import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

// ROOT CAUSE #1: the socket-setup effect created a brand-new Socket.IO connection (and
// re-registered every listener) every time any of its dependencies changed identity.
// finishDrain transitively depended on refreshMe, which depends on `token` — and /api/auth/me
// always signs a FRESH JWT (a new `iat`) on every call, so the 15s trial-countdown poller
// (which calls refreshMe while recording) reassigned `token`, and therefore finishDrain, roughly
// every 15 seconds during any trial user's active recording. If finishDrain were a dependency of
// the socket effect, that churn would disconnect and recreate the live socket connection out
// from under any in-flight translation request every ~15s — exactly matching the reported
// "backend sends translation results but the frontend doesn't consistently show them" and
// repeated [DESKTOP_PIPELINE_SOCKET_EVENT]/[DESKTOP_PIPELINE_TRANSLATION_RECEIVED] log spam.
{
  const socketEffectStart = appSource.indexOf("const socket = io(SOCKET_URL, {");
  const socketEffectDepsIndex = appSource.indexOf("}, [isAuthed, queueDubbingTranslations,");
  assert.ok(socketEffectStart > -1, "the socket-setup effect exists");
  assert.ok(socketEffectDepsIndex > socketEffectStart, "the socket-setup effect's dependency array is found after its body");

  const socketEffectDepsLine = appSource.slice(socketEffectDepsIndex, appSource.indexOf(";", socketEffectDepsIndex) + 1);
  assert.doesNotMatch(socketEffectDepsLine, /\bfinishDrain\b/, "finishDrain is NOT a dependency of the socket-setup effect — its identity churns every ~15s during trial recording via refreshMe -> token, which would otherwise tear down and recreate the live socket connection that often");

  const socketEffectBody = appSource.slice(socketEffectStart, socketEffectDepsIndex);
  assert.doesNotMatch(socketEffectBody, /[^.]\bfinishDrain\(/, "the socket effect body never calls finishDrain directly (only finishDrainRef.current(...)), since a direct closure reference would force it back into the dependency array");
  assert.match(socketEffectBody, /finishDrainRef\.current\("processed"\)/, "the socket effect calls the latest finishDrain via finishDrainRef instead of closing over finishDrain directly");
}

// ROOT CAUSE #2: a genuinely new utterance's transcript_final handler used to hard-reset
// finalTranslations to {} immediately, even if the PREVIOUS utterance's translation for French
// or German had not arrived yet (a real race on desktop's continuous re-arm, where utterance
// N+1 can begin before utterance N's translation round-trip finishes). Whatever hadn't rendered
// yet was silently discarded — it still reached "history" but never the live subtitles. Fix:
// freeze the previous utterance's accumulated text into a rolling per-language window before
// resetting the "current" slot, and render the window + current combined, so nothing is ever
// blanked, only appended to.
{
  const newUtteranceResetIndex = appSource.indexOf("if (!keepStreamingTranslation) {");
  assert.ok(newUtteranceResetIndex > -1, "the new-utterance reset branch exists");
  const resetBlock = appSource.slice(newUtteranceResetIndex, newUtteranceResetIndex + 900);
  assert.match(resetBlock, /const previousTranslations = finalTranslationsRef\.current;/, "the previous utterance's in-progress translations are captured before the current slot resets");
  assert.match(resetBlock, /setTranslatedTextWindow\(\(current\) => \{/, "the previous utterance's translations are folded into the rolling window instead of being discarded");
  assert.match(resetBlock, /next\[language\] = appendTextWindow\(next\[language\] \|\| "", trimmed\);/, "folding appends onto the existing window rather than replacing it");

  assert.match(
    appSource,
    /const translatedText = appendTextWindow\(translatedTextWindow\[language\] \|\| "", finalTranslations\[language\]\?\.trim\(\) \|\| ""\);/,
    "the rendered translation for each language combines the rolling window (frozen prior utterances) with the current utterance's in-progress text, mirroring how latestOriginal combines finalText with liveText"
  );
}

// ROOT CAUSE #3: a completed translation for an utterance that is no longer "current" (a newer
// utterance already started) used to be dropped from the live display entirely, even though its
// session and pending-transcript entry were both still genuinely valid. Section 8 requires
// rejecting a translation ONLY when its session/utterance truly no longer exists, or it's an
// older revision of the exact same target — never merely because the global "current" pointer
// moved on.
{
  assert.match(
    appSource,
    /const explicitPendingMatch = streamingPreview\s*\?\s*null\s*:\s*findPendingFinalTranscript\(\{/,
    "an explicit (session/job/sequence/original-text) pending-transcript lookup is computed independently of the loose 'current' fallback"
  );
  assert.match(
    appSource,
    /const sequenceIsStale = Number\.isFinite\(incomingSequence\) && incomingSequence < latestTranslationSequenceRef\.current && !streamingPreview && !preFinalTranslation && !explicitPendingMatch;/,
    "a lower sequence number is exempted from the staleness check when it explicitly matches a still-tracked pending transcript — sequence alone (i.e. the global pointer having moved on) is not sufficient grounds for rejection"
  );
  assert.match(
    appSource,
    /if \(!shouldUpdateLiveTranslation && explicitPendingMatch && isComplete\) \{/,
    "a completed translation for a still-valid but no-longer-current utterance is handled explicitly instead of being silently skipped"
  );
  assert.match(
    appSource,
    /next\[language\] = appendTextWindow\(next\[language\] \|\| "", String\(translatedText\)\.trim\(\)\);\s*\}\s*return next;\s*\}\);/,
    "a superseded utterance's completed translation is folded into the rolling window (still visible) rather than discarded"
  );
}

// ROOT CAUSE #4 (mobile): finishDrain's 8-second RECORDING_DRAIN_TIMEOUT_MS governed both
// "waiting for STT" and "waiting for every requested translation," and firing it unconditionally
// emitted end_session — which the backend's session.stop() uses to mark every in-flight
// translation job stale and drop it from its queue, permanently abandoning work that may well
// have still been genuinely in progress for 2-3 target languages. Fix: once the STT final
// arrives, re-arm a translation-specific, per-language-aware timeout, extend it on real
// per-target progress, and only show "Translation did not finish" for a genuine total failure —
// never for a partial success where at least one target already completed.
{
  assert.match(appSource, /const TRANSLATION_DRAIN_TIMEOUT_MS = 32000;/, "a translation-specific timeout budget exists, separate from the STT-oriented RECORDING_DRAIN_TIMEOUT_MS, sized to stay above the backend's own single-attempt Gemini budget (see ROOT CAUSE #9)");
  assert.match(appSource, /const TRANSLATION_DRAIN_PER_LANGUAGE_MS = 4000;/, "an additional per-target-language allowance exists");
  assert.match(
    appSource,
    /if \(drainPendingLanguagesRef\.current\.size > 0\) \{\s*if \(drainTimeoutRef\.current\) window\.clearTimeout\(drainTimeoutRef\.current\);\s*const translationBudgetMs = TRANSLATION_DRAIN_TIMEOUT_MS \+ Math\.max\(0, drainPendingLanguagesRef\.current\.size - 1\) \* TRANSLATION_DRAIN_PER_LANGUAGE_MS;/,
    "once STT final arrives, the drain timeout is re-armed with a budget sized to the number of target languages still pending translation"
  );
  assert.match(
    appSource,
    /\} else if \(drainTimeoutRef\.current && drainPendingLanguagesRef\.current\.size > 0\) \{/,
    "real per-target progress (one language settling while another is still pending) takes a distinct branch from the fully-settled case"
  );
  assert.match(
    appSource,
    /drainTimeoutRef\.current = window\.setTimeout\(\(\) => finishDrainRef\.current\("timeout"\), TRANSLATION_DRAIN_TIMEOUT_MS \+ Math\.max\(0, drainPendingLanguagesRef\.current\.size - 1\) \* TRANSLATION_DRAIN_PER_LANGUAGE_MS\);/,
    "that branch re-arms the drain timeout with the same full per-attempt budget as the initial arm, not a shortened fraction of it, so the remaining target(s) still get their own full window instead of racing a truncated one (see ROOT CAUSE #9)"
  );
  assert.match(appSource, /const stillPendingLanguages = \[\.\.\.drainPendingLanguagesRef\.current\];/, "finishDrain captures which languages were still pending before clearing the set, so it can tell a partial success from a total failure");
  assert.match(
    appSource,
    /const hasAnyCompletedTranslation = Object\.keys\(finalTranslationsRef\.current\)\.length > 0;/,
    "finishDrain distinguishes a genuine total failure (nothing ever completed) from a partial success"
  );
  assert.doesNotMatch(
    appSource,
    /setAlert\(timeoutWithoutFinalOriginal \? "No final caption was received\. Please try again\." : "Translation did not finish\. Please try again\."\);\s*pendingFinalTranscriptRef\.current = null;\s*pendingFinalTranscriptsRef\.current\.clear\(\);/,
    "the old unconditional timeout branch (always showing the failure alert and always wiping pending-transcript tracking, even for a partial success) is gone"
  );
  assert.doesNotMatch(
    appSource.slice(appSource.indexOf("const finishDrain = useCallback"), appSource.indexOf("const finishDrain = useCallback") + 2600),
    /pendingFinalTranscriptsRef\.current\.clear\(\);/,
    "finishDrain no longer clears pendingFinalTranscriptsRef on timeout — a translation the backend had already computed before end_session reaches it can still be matched and committed if it arrives moments later"
  );
}

// ROOT CAUSE #5 ("DONE + Waiting for speech..." with no visible text): the status-update loop
// used to mark every language present as a RAW KEY in the incoming translations payload as
// "translated" (Object.keys(nextTranslations)), regardless of whether that language's text
// actually survived the separate isValidTranslationText() gate in the merge loop just above it
// (e.g. rejected as a source-echo). A language's status could reach "translated" ("DONE" once
// translationStateLabel() uppercases it) while mergedTranslations[language] — and therefore
// finalTranslations/translatedTextWindow — was never actually set, so the card's text stayed
// empty and fell through to the "Waiting for speech…" placeholder despite the status claiming
// completion. The fix makes the status loop use the exact same criterion as the text-merge loop:
// only mark a language translated once its text is genuinely present in mergedTranslations.
{
  assert.match(
    appSource,
    /for \(const language of Object\.keys\(nextTranslations\)\) \{\s*if \(!mergedTranslations\[language\]\) continue;\s*nextStatusUpdates\[language\] = "translated";/,
    "the status-update loop gates on mergedTranslations[language] before marking a language translated"
  );
  assert.doesNotMatch(
    appSource,
    /for \(const language of Object\.keys\(nextTranslations\)\) \{\s*nextStatusUpdates\[language\] = "translated";/,
    'the old ungated version (marking every raw key "translated" regardless of merge success) is gone'
  );
}

// ROOT CAUSE #6 (a language stuck in RETRYING/Translating for up to 45s while new source speech
// kept arriving): the desktop-continuous staleness watchdog existed and did eventually resolve a
// stuck language to "failed", but its 45-second bound made "stuck" indistinguishable from
// "broken" during actual live use. Reduced from 45s — but (see ROOT CAUSE #9) an intermediate
// 18s value overcorrected past the backend's own single-attempt Gemini budget and started
// failing genuinely healthy in-flight translations, so the bound must stay strictly above that
// backend budget while still being far below the original 45s.
assert.match(appSource, /const STALE_TRANSLATION_STATE_MS = 32000;/, "the desktop translation-status staleness watchdog resolves a stuck language far sooner than the old 45s bound while staying above the backend's own single-attempt provider budget, matching a live-interpreter UX instead of a background task without racing legitimate in-flight work");
assert.match(
  appSource,
  /for \(const \[language, state\] of Object\.entries\(translationStatuses\)\) \{\s*if \(!\["queued", "translating", "processing", "retrying"\]\.includes\(state as string\)\) continue;\s*const updatedAt = translationStatusUpdatedAtRef\.current\[language\] \|\| 0;\s*if \(updatedAt && now - updatedAt > STALE_TRANSLATION_STATE_MS\) \{\s*staleUpdates\[language\] = "failed";/,
  "the watchdog itself (checked every second) still exists and forces any language stuck past the bound into a real terminal \"failed\" state, never leaving it in queued/translating/processing/retrying indefinitely"
);

// Section 10/11: French and German (or any set of independently-selected targets) are each
// processed via their own entry in nextTranslations/mergedTranslations/nextStatusUpdates, keyed
// by language code — there is no shared "currentTargetLanguage" mutable slot that one target's
// async response could clobber for another. A failure recorded for one language (via
// failedLanguages or a per-language statusByLanguage entry) is scoped to that language's own key
// and never clears or reassigns a different language's already-merged text.
assert.doesNotMatch(appSource, /let currentTargetLanguage/, "no shared mutable currentTargetLanguage exists for translation dispatch/consumption");
assert.match(appSource, /for \(const language of failedLanguages \|\| \[\]\) \{\s*if \(!mergedTranslations\[language\] && !nextTranslations\[language\]\) \{\s*nextStatusUpdates\[language\] = "failed";/, "a failed language is marked failed only under its own key, and only when it genuinely has no merged or incoming text of its own");

// ROOT CAUSE #7 (long-session "DONE + Translation unavailable — retry" on one language while a
// SIBLING language's preview is still streaming): mergedTranslations was reset to a bare `{}`
// the instant a genuinely new utterance's streaming preview arrived (newStreamingPreviewSource),
// discarding EVERY language's current-utterance translation at once — not just scoping to the
// language the preview belonged to. Under light load the previous utterance's transcript_final
// handler always won that race and had already folded finished languages into
// translatedTextWindow first, so this stayed latent. Under a long, continuously busy session
// (heavier Gemini queueing/backlog), a slower OTHER language (e.g. Chinese) could still be sitting
// only in finalTranslationsRef.current — not yet folded — when the NEXT utterance's French preview
// started streaming. That reset silently dropped Chinese's already-completed text while its
// translationStatuses entry stayed "translated", producing the exact invalid combination: a DONE
// badge with an empty body, which falls through to translationPlaceholder's "Translation
// unavailable — retry" fallback. Fix: fold any still-unfolded current-utterance translations into
// the rolling window BEFORE discarding them, mirroring the transcript_final handler's own fold
// step, so a sibling language's preview can never erase a completed translation — only move it
// from "in progress" to "history", exactly like a normal utterance boundary would.
{
  const newStreamingPreviewSourceIndex = appSource.indexOf("const newStreamingPreviewSource = streamingPreview &&");
  assert.ok(newStreamingPreviewSourceIndex > -1, "the newStreamingPreviewSource computation exists");
  const foldBlock = appSource.slice(newStreamingPreviewSourceIndex, newStreamingPreviewSourceIndex + 1800);
  assert.match(
    foldBlock,
    /if \(newStreamingPreviewSource && shouldUpdateLiveTranslation && Object\.keys\(finalTranslationsRef\.current\)\.length > 0\) \{/,
    "a new utterance's streaming preview folds any still-pending current-utterance translations before they can be discarded"
  );
  assert.match(
    foldBlock,
    /const staleCurrentUtteranceTranslations = finalTranslationsRef\.current;\s*setTranslatedTextWindow\(\(current\) => \{/,
    "the fold captures finalTranslationsRef.current (every language's current-utterance text, not just the incoming preview's language) before it is reset"
  );
  assert.match(
    foldBlock,
    /next\[language\] = appendTextWindow\(next\[language\] \|\| "", trimmed\);/,
    "folding appends onto the existing rolling window rather than replacing it, consistent with ROOT CAUSE #2's fold"
  );
  const mergedTranslationsIndex = appSource.indexOf("const mergedTranslations: Record<string, string> =", newStreamingPreviewSourceIndex);
  assert.ok(mergedTranslationsIndex > newStreamingPreviewSourceIndex && mergedTranslationsIndex < newStreamingPreviewSourceIndex + 1800, "the fold runs before mergedTranslations is computed, i.e. before any language's current-utterance text can be dropped");
}

// ROOT CAUSE #8 (production evidence: [DESKTOP_PIPELINE_TRANSLATION_RESULT] { jobId: "preview-46",
// status: undefined, languages: [], complete: false } arriving via translation_update/
// translation_result/translated_text): the backend already suppresses genuinely empty/cancelled
// lifecycle payloads before they reach the socket (hasMeaningfulTranslationPayload in
// interpreterSocket.js), but handleTranslationUpdate needs its own second line of defense — a
// payload with no translations, no per-language status, no failures, no top-level status, and no
// text must be ignored before ANY state is read or mutated, so a stray empty event (e.g. replayed
// after a socket reconnect) can never regress a card, erase a previous successful translation
// (e.g. Chinese DONE), or trigger retry UI.
{
  const handlerIndex = appSource.indexOf("const handleTranslationUpdate = (");
  assert.ok(handlerIndex > -1, "handleTranslationUpdate exists");
  const guardBlock = appSource.slice(handlerIndex, handlerIndex + 2600);
  assert.match(
    guardBlock,
    /const hasAnyTranslationContent = Boolean\(\s*\(translations && Object\.keys\(translations\)\.length > 0\) \|\|\s*\(statusByLanguage && Object\.keys\(statusByLanguage\)\.length > 0\) \|\|\s*\(Array\.isArray\(failedLanguages\) && failedLanguages\.length > 0\) \|\|\s*text \|\|\s*status\s*\);/,
    "a payload is only considered meaningful if it carries translations, per-language status, failures, text, or a top-level status"
  );
  assert.match(
    guardBlock,
    /if \(!hasAnyTranslationContent\) \{\s*console\.info\("\[EMPTY_TRANSLATION_PAYLOAD_IGNORED\]", \{ sessionId, jobId, sequence \}\);\s*return;\s*\}/,
    "an empty/non-actionable payload is ignored with a single concise diagnostic log, before any other processing"
  );
  const currentPendingIndex = guardBlock.indexOf("const currentPendingTranscript = pendingFinalTranscriptRef.current;");
  const guardIndex = guardBlock.indexOf("if (!hasAnyTranslationContent)");
  assert.ok(guardIndex > -1 && currentPendingIndex > -1 && guardIndex < currentPendingIndex, "the empty-payload guard runs before any pending-transcript lookup or other state access, guaranteeing it cannot mutate translationStatus/finalTranslations/translatedTextWindow/failure UI/retry UI for a non-actionable payload");
}

// ROOT CAUSE #9 (production evidence: a healthy source transcript reached the frontend live, but
// BOTH Chinese and Greek translation cards ended "FAILED — Translation timed out. Speak again to
// retry." even though nothing was actually wrong with either translation): the frontend's own
// translation-stuck watchdogs must never be able to fire before the backend's own declared,
// legal budget for a single provider attempt has elapsed — otherwise a Gemini call that is still
// legitimately in flight (Gemini is one blocking HTTP call, not a stream — see
// backend/services/gemini.js — so there is no incremental status update while it's waiting) gets
// unilaterally declared failed by the client with no way for the eventual real backend result to
// undo the premature verdict. This is a timer-ownership bug, not a "the timeout is too short for
// comfort" preference: it is provably possible for the frontend to give up while the backend is
// still within its own contract.
{
  const geminiSource = readFileSync(new URL("../../backend/services/gemini.js", import.meta.url), "utf8");
  const geminiTimeoutMatch = geminiSource.match(/export const GEMINI_TIMEOUT_MS = (\d+);/);
  assert.ok(geminiTimeoutMatch, "GEMINI_TIMEOUT_MS is defined in backend/services/gemini.js");
  const backendSingleAttemptBudgetMs = Number(geminiTimeoutMatch[1]);

  const staleTranslationMatch = appSource.match(/const STALE_TRANSLATION_STATE_MS = (\d+);/);
  assert.ok(staleTranslationMatch, "STALE_TRANSLATION_STATE_MS is defined in App.tsx");
  const staleTranslationWatchdogMs = Number(staleTranslationMatch[1]);
  assert.ok(
    staleTranslationWatchdogMs > backendSingleAttemptBudgetMs,
    `STALE_TRANSLATION_STATE_MS (${staleTranslationWatchdogMs}ms) must stay strictly greater than the backend's single-attempt GEMINI_TIMEOUT_MS (${backendSingleAttemptBudgetMs}ms), or a legitimate in-flight Gemini call gets prematurely marked failed on the desktop staleness watchdog before the backend itself gives up`
  );

  const drainTimeoutMatch = appSource.match(/const TRANSLATION_DRAIN_TIMEOUT_MS = (\d+);/);
  assert.ok(drainTimeoutMatch, "TRANSLATION_DRAIN_TIMEOUT_MS is defined in App.tsx");
  const mobileDrainBudgetMs = Number(drainTimeoutMatch[1]);
  assert.ok(
    mobileDrainBudgetMs > backendSingleAttemptBudgetMs,
    `TRANSLATION_DRAIN_TIMEOUT_MS (${mobileDrainBudgetMs}ms) must stay strictly greater than the backend's single-attempt GEMINI_TIMEOUT_MS (${backendSingleAttemptBudgetMs}ms), or mobile's post-final-transcript drain timeout prematurely marks a still-legitimate translation failed`
  );

  // The re-arm after one target settles (Section 7) must give the remaining target(s) the same
  // full per-attempt budget, not a shortened fraction of it — a remaining language's own single
  // Gemini attempt can independently take up to the backend's full budget regardless of how
  // quickly a different language already settled.
  assert.doesNotMatch(
    appSource,
    /TRANSLATION_DRAIN_PER_LANGUAGE_MS \+ TRANSLATION_DRAIN_TIMEOUT_MS \/ 2/,
    "the mobile drain-timeout re-arm after a target settles no longer halves the per-attempt budget for the remaining target(s)"
  );
}

console.log("Translation pipeline regression tests passed.");
