import assert from "node:assert/strict";
import { createRecordingStateMachine } from "../src/audio/recordingStateMachine.mjs";

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
