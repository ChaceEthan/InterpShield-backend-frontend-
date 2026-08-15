import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { translationPlaceholder } from "../src/translationLifecycle.mjs";

// Reproduces the exact production symptom: audio chunks are accepted and Deepgram is
// receiving them, but no final transcript ever arrives for an utterance (e.g. Deepgram's
// Results kept coming back with an empty transcript). The UI must never show "Translating..."
// for that language while there is no real translation job, and a later, genuinely valid
// utterance must still be able to translate — no stale state from the failed one may block it.

// Before any transcript exists at all, a card is "ready" — recording alone must not claim
// translation is happening.
assert.equal(translationPlaceholder("ready", true), "Waiting for speech…", "a card with no transcript yet never claims to be translating just because the mic is on");
assert.equal(translationPlaceholder("ready", false), "Translation will appear here.", "an idle, untouched card shows the neutral placeholder");

// Only once a real job exists (queued/processing/retrying) does "Translating..." appear.
for (const state of ["queued", "processing", "retrying"]) {
  assert.equal(translationPlaceholder(state, true), "Translating...", `a real in-flight job (${state}) legitimately shows Translating...`);
}

// A failed/timed-out/stale job must show a controlled, non-stuck state, not linger on
// "Translating..." forever and not silently pretend to be idle either.
for (const state of ["failed", "stale", "cancelled"]) {
  assert.equal(translationPlaceholder(state, true), "Translation unavailable — retry", `a ${state} job surfaces a controlled retry state instead of a permanent Translating...`);
}

// A later, valid utterance must still be able to reach a real Translating state and complete,
// even after an earlier utterance never produced a transcript.
{
  let cardState = "ready"; // no transcript ever arrived for the previous utterance
  assert.equal(translationPlaceholder(cardState, true), "Waiting for speech…", "an utterance with no transcript leaves the card truthfully non-translating");
  cardState = "queued";
  assert.equal(translationPlaceholder(cardState, true), "Translating...", "a subsequent valid utterance can still start translating");
  cardState = "translated";
  assert.notEqual(translationPlaceholder(cardState, true), "Translating...", "a completed translation does not fall back to Translating... (real UI renders entry.text instead once state is translated)");
}

// Real production evidence: "CHINESE (ZH) / DONE / Waiting for speech..." — a card showing a
// done/translated badge while its body falls back to the empty-state placeholder. The real UI
// (TranscriptArea.tsx) only ever calls translationPlaceholder() when its own translated text is
// empty (`entry.text || translationPlaceholder(...)`), so this exact input combination — state
// "translated"/"done" with no text to show — is the literal shape of that bug. It must never
// claim "Waiting for speech...", which falsely implies no translation was ever attempted.
for (const state of ["translated", "done"]) {
  assert.equal(
    translationPlaceholder(state, true),
    "Translation unavailable — retry",
    `a "${state}" card with no text to show (should be structurally unreachable, but must fail safely if it ever happens) must never render "Waiting for speech..."`
  );
  assert.notEqual(translationPlaceholder(state, true), "Waiting for speech…");
}

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

// Desktop's continuous live session structurally cannot get stuck waiting for a transcript:
// beginDrain's desktop branch never sets awaitingFinalTranscriptRef at all (it only requests a
// buffer flush and arms the boundary controller), so there is nothing for a missing final
// transcript to block — the recorder and every later utterance's beginDrain call remain free
// regardless of whether Deepgram ever produces a final for the one that just ended.
assert.doesNotMatch(appSource, /awaitingFinalTranscriptRef\.current = true;[\s\S]{0,200}continueListening/, "the desktop continue-listening path never sets the mobile-style awaiting-transcript gate");
assert.match(appSource, /const continueListening = reason === "vad_sustained_silence" && isDesktopChrome\(\) && !explicitStopRequestedRef\.current;\s*if \(continueListening\) \{\s*const transition = utteranceLifecycleRef\.current\.requestFinalization\(reason, generation\);\s*if \(!transition\.accepted\) return false;/, "the desktop branch only gates on requestFinalization's own phase check, not on any pending-transcript flag");

// Mobile still uses the awaiting-transcript gate (it genuinely stops capture and must wait),
// and finishDrain's existing drain-timeout is still the safety net that resets a mobile
// utterance's cards back to ready if no final transcript/translation ever arrives.
assert.match(appSource, /if \(awaitingFinalTranscriptRef\.current\) return false;\s*const transition = utteranceLifecycleRef\.current\.requestFinalization\(reason, generation\);\s*if \(!transition\.accepted\) return false;\s*awaitingFinalTranscriptRef\.current = true;/, "mobile's full-finalize path still gates on and sets awaitingFinalTranscriptRef");
// A completed translation must win over an earlier timeout: only the languages that were STILL
// pending when the timeout fired revert to "ready" — a language that already completed (e.g.
// French arrived, German is still pending) keeps its translated status/text instead of both
// being wiped back to ready together.
assert.match(appSource, /const stillPendingLanguages = \[\.\.\.drainPendingLanguagesRef\.current\];/, "finishDrain captures which languages were still pending before clearing the set");
assert.match(appSource, /const readyStatuses = Object\.fromEntries\(stillPendingLanguages\.map\(\(language\) => \[language, "ready" as TranslationLifecycleState\]\)\);\s*setTranslationStatuses\(\(current\) => \(\{ \.\.\.current, \.\.\.readyStatuses \}\)\);/, "finishDrain's timeout branch only reverts the still-pending target languages back to ready, preserving any language that already completed");
assert.match(appSource, /const hasAnyCompletedTranslation = Object\.keys\(finalTranslationsRef\.current\)\.length > 0;/, "finishDrain checks whether any language actually completed before deciding which alert to show");
assert.match(appSource, /\} else if \(!hasAnyCompletedTranslation\) \{\s*setAlert\("Translation did not finish\. Please try again\."\);/, '"Translation did not finish" is reserved for a genuine total failure (zero languages completed), not shown merely because one of several targets was still pending');
assert.match(appSource, /drainTimeoutRef\.current = window\.setTimeout\(\(\) => finishDrain\("timeout"\), RECORDING_DRAIN_TIMEOUT_MS\);/, "mobile's full-finalize path still arms the bounded drain-timeout safety net");

console.log("Stuck-Translating regression tests passed.");
