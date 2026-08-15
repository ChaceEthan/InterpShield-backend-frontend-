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
  assert.match(appSource, /const TRANSLATION_DRAIN_TIMEOUT_MS = 12000;/, "a translation-specific timeout budget exists, separate from the STT-oriented RECORDING_DRAIN_TIMEOUT_MS");
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
    /drainTimeoutRef\.current = window\.setTimeout\(\(\) => finishDrainRef\.current\("timeout"\), TRANSLATION_DRAIN_PER_LANGUAGE_MS \+ TRANSLATION_DRAIN_TIMEOUT_MS \/ 2\);/,
    "that branch re-arms the drain timeout with a fresh budget instead of letting the remaining target(s) race whatever time was left from the first"
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
// "broken" during actual live use. Reduced to a bound still generous enough for a genuine
// Gemini-then-OpenAI fallback with the backend's own bounded per-provider retries.
assert.match(appSource, /const STALE_TRANSLATION_STATE_MS = 18000;/, "the desktop translation-status staleness watchdog now resolves a stuck language far sooner than the old 45s bound, matching a live-interpreter UX instead of a background task");
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

console.log("Translation pipeline regression tests passed.");
