import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRecorderGenerationController, createRecordingStateMachine } from "../src/audio/recordingStateMachine.mjs";

const timers = new Map();
let timerId = 0;
const phases = [];
let captureStops = 0;
let trackStops = 0;
let sessionClosed = 0;
const lifecycle = createRecordingStateMachine({
  silenceMs: 1500,
  drainTimeoutMs: 8000,
  setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
  clearTimer(id) { timers.delete(id); },
  onPhaseChange(phase) { phases.push(phase); },
  onStopCapture() { captureStops += 1; trackStops += 1; },
  onDrainComplete() { sessionClosed += 1; }
});

lifecycle.start();
assert.equal(lifecycle.noteSilence(), false, "silence before meaningful speech cannot stop capture");
lifecycle.noteMeaningfulSpeech();
assert.equal(lifecycle.noteSilence(), true);
const silenceTimer = [...timers.values()].find(({ delay }) => delay === 1500);
assert.ok(silenceTimer, "meaningful speech arms a 1.5 second silence timer");
lifecycle.noteMeaningfulSpeech();
assert.equal(captureStops, 0, "resumed speech cancels the silence timer");
lifecycle.noteSilence();
[...timers.values()].find(({ delay }) => delay === 1500).callback();
assert.equal(captureStops, 1, "sustained silence enters draining exactly once");
assert.equal(trackStops, 1, "microphone tracks stop on entry to draining");
assert.equal(lifecycle.beginDrain(), false, "duplicate drain calls are ignored");
assert.equal(sessionClosed, 0, "the interpreter session remains alive for final results");
lifecycle.noteFinalTranscript(["zh", "fr"]);
lifecycle.noteLanguageSettled("zh", { dubbingQueued: true });
lifecycle.noteDubbingSubmitted("zh");
assert.equal(sessionClosed, 0, "one target does not wait on or close another target's processing incorrectly");
lifecycle.noteLanguageSettled("fr", { dubbingQueued: true });
lifecycle.noteDubbingSubmitted("fr");
assert.equal(sessionClosed, 1);
assert.equal(lifecycle.snapshot().phase, "idle", "the button returns to idle after processing");

lifecycle.start();
lifecycle.noteMeaningfulSpeech();
lifecycle.beginDrain();
const drainTimer = [...timers.values()].find(({ delay }) => delay === 8000);
assert.ok(drainTimer, "draining has an 8 second upper bound");
drainTimer.callback();
assert.equal(lifecycle.snapshot().phase, "idle", "drain timeout prevents a stuck UI");
assert.equal(sessionClosed, 2);

assert.deepEqual(phases.slice(0, 4), ["listening", "draining", "translating", "idle"]);
console.log("Recording auto-stop and drain state-machine regression tests passed.");

const recorderStarts = [], recorderStops = [];
const recorder = createRecorderGenerationController({
  onStart(event) { recorderStarts.push(event); },
  onStop(event) { recorderStops.push(event); }
});
const firstGeneration = recorder.explicitStart();
assert.equal(firstGeneration, 1, "one microphone press creates one recording generation");
assert.equal(recorder.explicitStart(), null, "a pending start cannot be duplicated");
assert.equal(recorder.sessionReady(firstGeneration), true);
assert.equal(recorder.sessionReady(firstGeneration), false, "duplicate session ACK cannot start MediaRecorder twice");
assert.equal(recorder.sessionReady(firstGeneration - 1), false, "a stale ACK cannot restart an old generation");
assert.equal(recorderStarts.length, 1, "one microphone press creates exactly one MediaRecorder start");
assert.equal(recorder.reconnect(), false, "socket reconnect does not create a MediaRecorder");
assert.equal(recorderStarts.length, 1);
assert.equal(recorder.streamGenerationChanged(2), true, "one confirmed Deepgram generation boundary may be handled");
assert.equal(recorder.streamGenerationChanged(2), false, "duplicate generation resets are ignored");
assert.equal(recorder.snapshot().phase, "listening", "short pauses do not alter recorder ownership");
assert.equal(recorder.beginDrain(), true, "sustained silence enters draining once");
assert.equal(recorder.beginDrain(), false);
assert.equal(recorder.finish("drain_timeout"), true);
assert.equal(recorder.finish("drain_timeout"), false, "drain timeout stops once without restart");
assert.equal(recorderStops.length, 1);
assert.equal(recorderStarts.length, 1);
const secondGeneration = recorder.explicitStart();
assert.equal(secondGeneration, 2, "a second explicit microphone press creates the next generation");
assert.equal(recorder.sessionReady(secondGeneration), true);
assert.equal(recorderStarts.length, 2, "the second press creates exactly one new MediaRecorder start");

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
for (const guard of ["startInFlightRef", "stopInFlightRef", "activeRecordingGenerationRef", "activeSessionIdRef", "recorderStartedForGenerationRef", "recorderStoppedForGenerationRef"]) {
  assert.match(appSource, new RegExp(`const ${guard} = useRef`), `${guard} protects recorder lifecycle ownership`);
}
assert.doesNotMatch(appSource, /AUDIO_RECOVERY_SCHEDULED[\s\S]{0,900}?startSession/, "transient recorder recovery cannot automatically start a new recording generation");
assert.match(appSource, /nextGeneration <= lastHandledDeepgramGenerationRef\.current/, "duplicate Deepgram generation resets are ignored");
assert.match(appSource, /recordingPhaseRef\.current !== "listening"/, "draining blocks recorder generation changes and duplicate drain requests");
assert.match(appSource, /activeRecordingGenerationRef\.current !== recordingGeneration[\s\S]{0,300}?if \(stale\) return/, "late start ACKs cannot update an old generation");
assert.match(appSource, /stopReason: "no_meaningful_speech_timeout"/, "no-speech timeout stops once without restarting");
