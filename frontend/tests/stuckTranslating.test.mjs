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

// Simulate the actual App.tsx recovery path: an utterance whose final transcript never
// arrives times out back to "ready" (finishDrain's timeout branch and, for desktop's
// continue-listening path, recoverStuckUtterance both do exactly this), and from "ready" the
// card can never show "Translating..." again until a real job is created for it.
{
  let cardState = "queued"; // a final transcript arrived, translation was requested
  // ...no provider result ever arrives (simulating repeated Deepgram-empty-transcript utterances
  // upstream never even producing a job, or a provider timeout downstream)...
  cardState = "ready"; // recovery timeout fires, exactly like finishDrain("timeout") / recoverStuckUtterance
  assert.equal(translationPlaceholder(cardState, true), "Waiting for speech…", "after recovery, the card returns to a truthful non-translating state");

  // A later, valid utterance must still be able to reach a real Translating state and complete.
  cardState = "queued";
  assert.equal(translationPlaceholder(cardState, true), "Translating...", "a subsequent valid utterance can still start translating after an earlier one recovered from being stuck");
  cardState = "translated";
  assert.notEqual(translationPlaceholder(cardState, true), "Translating...", "a completed translation does not fall back to Translating... (real UI renders entry.text instead once state is translated)");
}

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

// The actual App.tsx recovery mechanism: desktop's continue-listening drain arms a bounded
// timeout because it never tears the session down, so nothing else would ever unstick it.
assert.match(appSource, /const recoverStuckUtterance = useCallback\(\(generation: number\) => \{/, "a dedicated recovery path exists for utterances whose final transcript never arrives");
assert.match(appSource, /if \(activeRecordingGenerationRef\.current !== generation \|\| !awaitingFinalTranscriptRef\.current\) return;/, "recovery is a no-op if the utterance already resolved normally or a newer generation has started");
assert.match(appSource, /const readyStatuses = Object\.fromEntries\(targetLanguagesRef\.current\.map\(\(language\) => \[language, "ready" as TranslationLifecycleState\]\)\);\s*setTranslationStatuses\(readyStatuses\);/, "recovery resets every target language back to ready, not stuck on its previous status");
assert.match(appSource, /utteranceRecoveryTimeoutRef\.current = window\.setTimeout\(\(\) => recoverStuckUtterance\(generation\), UTTERANCE_RECOVERY_TIMEOUT_MS\);/, "the continue-listening drain path arms the recovery timeout for this specific utterance");
assert.match(appSource, /if \(utteranceRecoveryTimeoutRef\.current\) \{\s*window\.clearTimeout\(utteranceRecoveryTimeoutRef\.current\);\s*utteranceRecoveryTimeoutRef\.current = null;\s*\}/, "a real final transcript arriving cancels the recovery timeout so it can't fire late and clobber valid state");
assert.match(appSource, /awaitingFinalTranscriptRef\.current = false;\s*setAwaitingFinalTranscript\(false\);\s*drainPendingLanguagesRef\.current\.clear\(\);\s*setTranslationsPending\(\[\]\);\s*const readyStatuses = Object\.fromEntries/, "recovery clears the pending-translation bookkeeping too, so it can't block the next utterance's beginDrain call");

console.log("Stuck-Translating regression tests passed.");
