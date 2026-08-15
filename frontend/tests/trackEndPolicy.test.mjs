import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyRecorderStop, isTrackEndExpected, shouldRecoverFromRecorderStop } from "../src/audio/trackEndPolicy.mjs";

const baseCurrent = {
  isCurrentGeneration: true,
  isCurrentStream: true,
  recordingExpected: true,
  intentionalStopInProgress: false,
  recorderTransitionInProgress: false,
  phase: "listening"
};

// A: expected mobile stop. A mobile utterance completing runs beginDrain's full teardown,
// which sets recordingRef.current = false BEFORE it ever calls track.stop() — so by the time
// track.onended fires, recordingExpected is already false. Run 5 full press/complete cycles.
for (let cycle = 1; cycle <= 5; cycle += 1) {
  const expected = isTrackEndExpected({ ...baseCurrent, recordingExpected: false, phase: "idle" });
  assert.equal(expected, true, `cycle ${cycle}: a mobile utterance's natural completion is an expected track end, not a failure`);
}

// B: unexpected mobile track failure. The track ends while recording is genuinely still
// active and nothing in the app initiated a stop/replacement — this must be treated as real.
{
  const expected = isTrackEndExpected(baseCurrent);
  assert.equal(expected, false, "a track ending while actively recording, with no app-initiated stop in progress, is a genuine unexpected failure");
}

// C: desktop expected stream replacement. A stale generation's track ending after a newer
// generation has already taken over must be ignored — it belongs to the old, discarded stream.
{
  const expected = isTrackEndExpected({ ...baseCurrent, isCurrentGeneration: false });
  assert.equal(expected, true, "a track from a superseded generation ending is expected, not a failure of the current session");
}
{
  const expected = isTrackEndExpected({ ...baseCurrent, isCurrentStream: false });
  assert.equal(expected, true, "a track from a stream that is no longer the active stream ending is expected");
}

// H: explicit user Stop in progress. The moment Stop is pressed (or a stop is already
// in-flight), any track.onended that fires as a direct result must be ignored.
{
  const expected = isTrackEndExpected({ ...baseCurrent, intentionalStopInProgress: true, phase: "idle" });
  assert.equal(expected, true, "a track ending while an explicit Stop is in progress is expected");
}

// Desktop's own continue-listening/generation-restart transitions (a healthy recorder cycling
// itself between utterances) must never be misread as failures either.
{
  const expected = isTrackEndExpected({ ...baseCurrent, recorderTransitionInProgress: true });
  assert.equal(expected, true, "a track ending during an app-initiated recorder restart/replacement is expected");
}

// E: desktop soft pause / any settling phase must not be misread as an unexpected end even
// if some other flag briefly disagrees, since a phase of draining/finalizing/idle already
// means the app itself is intentionally winding this utterance or session down.
for (const phase of ["draining", "finalizing", "idle"]) {
  const expected = isTrackEndExpected({ ...baseCurrent, phase });
  assert.equal(expected, true, `phase "${phase}" is a settling phase — a track ending here is expected, not a failure`);
}
// A genuinely active phase (listening/speaking/soft-pause) does not by itself excuse a track
// end — soft_pause is an ordinary mid-utterance state, not a teardown state.
for (const phase of ["listening", "speaking", "soft-pause", "translating"]) {
  const expected = isTrackEndExpected({ ...baseCurrent, phase });
  assert.equal(expected, false, `phase "${phase}" is still actively expecting audio — a track ending here is a real failure`);
}

// classifyRecorderStop / shouldRecoverFromRecorderStop: only a stop this app never tracked as
// intentional (recorderStoppedForGenerationRef didn't match) can trigger recovery, and only if
// recording is still expected. This mirrors MediaRecorder.onstop's final fallback exactly.
assert.equal(classifyRecorderStop({ stopWasIntentional: true, trackedReason: "vad_sustained_silence" }), "vad_sustained_silence", "a tracked, intentional stop keeps its real reason");
assert.equal(classifyRecorderStop({ stopWasIntentional: true, trackedReason: "explicit_user_stop" }), "explicit_user_stop", "explicit stop keeps its real reason");
assert.equal(classifyRecorderStop({ stopWasIntentional: false, trackedReason: "vad_sustained_silence" }), "unexpected_recorder_stop", "a stop no app code tracked as intentional is classified as unexpected regardless of a stale leftover reason string");

assert.equal(shouldRecoverFromRecorderStop({ recordingExpected: true, stopWasIntentional: false }), true, "an untracked stop while recording is still expected must recover");
assert.equal(shouldRecoverFromRecorderStop({ recordingExpected: true, stopWasIntentional: true }), false, "a tracked, intentional stop must never trigger recovery even while recordingExpected is still momentarily true");
assert.equal(shouldRecoverFromRecorderStop({ recordingExpected: false, stopWasIntentional: false }), false, "no recovery once recording is no longer expected, regardless of tracking");

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

// The status label must not call a completely normal idle state a failure. `audioDiagnostic`
// (a ref-backed piece of state set explicitly by the failure paths) is the real signal for
// whether idle means "successfully finished" vs "genuinely stopped unexpectedly".
assert.match(appSource, /status === "idle"\s*\?\s*\(audioDiagnostic\.state === "failed"\s*\?\s*audioDiagnostic\.message\s*:\s*\(audioSource === "tab" \? "Ready to share tab audio" : "Ready"\)\)/, 'the idle status label only reports a failure message for a real recorded failure, not for every successful completion, and distinguishes "Ready" (microphone) from "Ready to share tab audio" (tab/system audio)');
assert.doesNotMatch(appSource, /status === "idle"\s*\n?\s*\?\s*"Microphone stopped"\s*\n?\s*:/, 'the old unconditional "idle -> Microphone stopped" mapping is gone');

// The actual wiring: track.onended and recorder.onstop both route through the tested policy
// functions instead of inline, untested boolean soup.
assert.match(appSource, /const expected = isTrackEndExpected\(\{/, "track.onended defers its expected/unexpected decision to the tested policy function");
assert.match(appSource, /reason: classifyRecorderStop\(\{ stopWasIntentional, trackedReason: recorderStopReasonRef\.current \}\)/, "onstop's diagnostic reason comes from the tested classifier");
assert.match(appSource, /if \(shouldRecoverFromRecorderStop\(\{ recordingExpected: recordingRef\.current, stopWasIntentional \}\)\) \{\s*scheduleAudioRecovery\("unexpected_recorder_stop"\);/, "onstop only calls scheduleAudioRecovery when the tested policy says recovery is warranted, using the unexpected_recorder_stop reason");

// G: Dubbing (browser speechSynthesis playback) must never be wired into the microphone
// failure/recovery path — it has nothing to do with the capture track.
assert.doesNotMatch(appSource, /speechSynthesis[\s\S]{0,400}scheduleAudioRecovery/, "Dubbing/speech-synthesis code never calls into microphone failure recovery");
assert.doesNotMatch(appSource, /stopDubbingPlayback[\s\S]{0,200}scheduleAudioRecovery/, "stopping Dubbing playback never triggers a false microphone failure");

console.log("Track-end / recorder-stop policy regression tests passed.");
