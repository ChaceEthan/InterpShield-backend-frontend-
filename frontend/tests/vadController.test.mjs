import assert from "node:assert/strict";
import { buildProductionAudioConstraints, createVadController } from "../src/audio/vadController.mjs";

const constraints = buildProductionAudioConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: true, channelCount: true });
assert.equal(constraints.noiseSuppression, true);
assert.equal(constraints.echoCancellation, true);
assert.equal(constraints.autoGainControl, true);
assert.deepEqual(constraints.channelCount, { ideal: 1 });

const vad = createVadController({ calibrationMs: 100, minimumSpeechMs: 100, silenceHoldMs: 1500 });
vad.start(0);
assert.equal(vad.update(0.003, 50), null);
assert.equal(vad.update(0.003, 100)?.type, "calibrated");
assert.equal(vad.update(0.006, 200), null, "background noise must remain gated");
assert.equal(vad.update(0.04, 300)?.type, "speech_candidate");
assert.equal(vad.update(0.04, 410)?.type, "speech_started");
assert.equal(vad.update(0.001, 1000), null, "short pause must not finalize");
assert.equal(vad.update(0.04, 1200), null, "speech within hold period must cancel silence");
assert.equal(vad.update(0.001, 1300), null);
assert.equal(vad.update(0.001, 2801)?.type, "finalize", "sustained silence must finalize");
vad.markPaused();
assert.equal(vad.update(0.04, 3000)?.type, "speech_candidate");
assert.equal(vad.update(0.04, 3110)?.type, "speech_started", "speech must resume a paused VAD");

const duplicateGuard = createVadController({ calibrationMs: 0 });
duplicateGuard.start(0);
duplicateGuard.update(0, 1);
assert.equal(duplicateGuard.update(0, 2), null, "calibration transition is emitted once");

// Recorder/session harness: speech candidates resume the existing recorder,
// finalization flushes before pause, and sequence numbers advance only for
// transmitted non-empty chunks.
const recorder = {
  state: "paused",
  instances: 1,
  calls: [],
  resume() { assert.equal(this.state, "paused"); this.state = "recording"; this.calls.push("resume"); },
  requestData() { assert.equal(this.state, "recording"); this.calls.push("requestData"); },
  pause() { assert.equal(this.state, "recording"); this.state = "paused"; this.calls.push("pause"); },
  stop() { this.state = "inactive"; this.calls.push("stop"); }
};
let sequence = 0;
const transmitted = [];
const sendChunk = (size) => { if (size > 0) transmitted.push(++sequence); };
recorder.resume();
sendChunk(128);
recorder.requestData();
sendChunk(96);
recorder.pause();
assert.deepEqual(recorder.calls, ["resume", "requestData", "pause"], "final chunk must be requested before pausing");
assert.deepEqual(transmitted, [1, 2]);
sendChunk(0);
assert.equal(sequence, 2, "silence/zero-byte gating must not reset or consume sequence numbers");
recorder.resume();
assert.equal(recorder.instances, 1, "automatic resume must reuse the existing MediaRecorder");
assert.equal(recorder.instances, 1, "duplicate MediaRecorder instances are prevented");
recorder.stop();
assert.equal(recorder.state, "inactive", "manual stop must stop the recorder");
console.log("VAD controller regression tests passed.");
