import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRecorderGenerationController } from "../src/audio/recordingStateMachine.mjs";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

// THE ROOT-CAUSE FIX: utteranceLifecycleRef.current.start() moves the lifecycle phase away
// from "idle", and startSession()'s own entry guard requires phase === "idle" before it will
// do anything on a later press. Every early-bailout check that can fire before that point
// (unsupported getUserMedia, unsupported MediaRecorder, unsupported tab/system audio) must
// therefore run BEFORE .start() is called — otherwise the phase is stuck away from "idle"
// forever and every future press of either Start button silently no-ops with no visible
// error, which is exactly the "Microphone stopped" / "Press and start talking does nothing"
// symptom reported from real devices.
const startSessionBody = appSource.slice(
  appSource.indexOf("const startSession = useCallback(async () => {"),
  appSource.indexOf("const selectMode = (nextMode: Mode) => {")
);
const unsupportedGetUserMediaIndex = startSessionBody.indexOf('!navigator.mediaDevices?.getUserMedia');
const unsupportedMediaRecorderIndex = startSessionBody.indexOf('!("MediaRecorder" in window)');
const unsupportedTabAudioIndex = startSessionBody.indexOf('activeAudioSource === "tab" && !isTabAudioCaptureSupported');
const lifecycleStartIndex = startSessionBody.indexOf("utteranceLifecycleRef.current.start({");

assert.ok(unsupportedGetUserMediaIndex > -1, "the getUserMedia support guard exists in startSession");
assert.ok(unsupportedMediaRecorderIndex > -1, "the MediaRecorder support guard exists in startSession");
assert.ok(unsupportedTabAudioIndex > -1, "the tab/system audio support guard exists in startSession");
assert.ok(lifecycleStartIndex > -1, "utteranceLifecycleRef.current.start() exists in startSession");

assert.ok(unsupportedGetUserMediaIndex < lifecycleStartIndex, "the getUserMedia support check runs BEFORE the lifecycle phase leaves idle, so it can safely bail out without ever needing to revert it");
assert.ok(unsupportedMediaRecorderIndex < lifecycleStartIndex, "the MediaRecorder support check runs BEFORE the lifecycle phase leaves idle");
assert.ok(unsupportedTabAudioIndex < lifecycleStartIndex, "the tab/system audio support check runs BEFORE the lifecycle phase leaves idle — a browser without display-capture support (or a false-negative detection) can no longer permanently wedge the entry guard for every future press, including switching back to Microphone mode");

// None of the three pre-flight guards may set startInFlightRef without also being able to
// reach a real reset; the fix makes this moot by placing them before startInFlightRef is ever
// set in the first place. Confirm startInFlightRef.current = true is likewise positioned after
// all three checks (i.e. checks own their own early return with nothing left dangling).
const startInFlightSetIndex = startSessionBody.indexOf("startInFlightRef.current = true;");
assert.ok(startInFlightSetIndex > unsupportedTabAudioIndex, "startInFlightRef is only ever set once every pre-flight support check has already passed");

// Defense in depth: stopSession, scheduleAudioRecovery, and finishDrain all guarantee the
// session lands back at a pressable idle state via try/finally, even if cleanup throws
// partway through — so a single unexpected exception can never leave the mic button
// permanently stuck (native-disabled on "stopping", or silently no-op via a stuck ref).
assert.match(appSource, /setStatus\("stopping"\);\s*try \{\s*cleanupMedia\(\{ stopReason: "explicit_user_stop"/, "stopSession wraps its cleanup in try/finally");
assert.match(appSource, /\} finally \{\s*\/\/ However cleanup went, the mic button must never stay stuck disabled on "stopping"/, "stopSession's finally block unconditionally restores idle state");
assert.match(appSource, /setAlert\(alertMessage\);\s*try \{\s*cleanupMedia\(\{ stopReason: reason \}\);/, "scheduleAudioRecovery wraps its cleanup in try/finally");
assert.match(appSource, /utteranceLifecycleRef\.current\.setPhase\("finalizing"\);\s*try \{\s*cleanupMedia\(\{ preserveTranslationPipeline: true, stopReason: `drain_\$\{reason\}`/, "finishDrain wraps its cleanup in try/finally");

// A completed mobile utterance must never permanently poison the next microphone start: the
// generation-controller module models exactly the press -> speech -> final -> translation ->
// expected recorder stop -> idle -> press-again cycle real mobile usage requires. Run it for
// at least 10 consecutive cycles (mobile devices are pressed far more than 5 times per day).
{
  const MOBILE_CYCLE_COUNT = 10;
  const starts = [];
  const stops = [];
  const recorder = createRecorderGenerationController({ onStart: (event) => starts.push(event), onStop: (event) => stops.push(event) });

  for (let cycle = 1; cycle <= MOBILE_CYCLE_COUNT; cycle += 1) {
    const generation = recorder.explicitStart();
    assert.equal(generation, cycle, `cycle ${cycle}: press creates a fresh generation, unaffected by any earlier cycle`);
    assert.equal(recorder.sessionReady(generation), true, `cycle ${cycle}: getUserMedia/session ack starts capture`);
    assert.equal(recorder.beginDrain(), true, `cycle ${cycle}: the finalized utterance can begin draining`);
    assert.equal(recorder.finish("processed"), true, `cycle ${cycle}: the expected recorder stop completes the utterance`);
    assert.equal(recorder.snapshot().phase, "idle", `cycle ${cycle}: the session returns to idle, ready for the next press — not stuck`);
  }

  assert.equal(starts.length, MOBILE_CYCLE_COUNT, "ten consecutive presses each started a real recorder");
  assert.equal(stops.length, MOBILE_CYCLE_COUNT, "ten consecutive utterances each completed with exactly one expected stop");

  // A late-arriving onstop for an old generation (e.g. queued on the event loop when the user
  // pressed the mic again quickly) must not affect the generation that is now active.
  const staleGeneration = recorder.explicitStart();
  assert.equal(staleGeneration, MOBILE_CYCLE_COUNT + 1, "an eleventh press still creates a fresh generation after ten prior cycles");
  assert.equal(recorder.sessionReady(staleGeneration - 1), false, "a stale session acknowledgement belonging to a superseded generation is ignored");
  assert.equal(recorder.beginDrain(), false, "stale drain requests for an old generation cannot affect the new one before it is even ready");
}

console.log("Mic button recovery / stale-guard regression tests passed.");
