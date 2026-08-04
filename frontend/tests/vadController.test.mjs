import assert from "node:assert/strict";
import { analyzeTranscriptCompleteness, buildProductionAudioConstraints, createVadController, getDynamicSilenceHoldMs } from "../src/audio/vadController.mjs";

const constraints = buildProductionAudioConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: true, channelCount: true });
assert.equal(constraints.noiseSuppression, true);
assert.equal(constraints.echoCancellation, true);
assert.equal(constraints.autoGainControl, true);
assert.deepEqual(constraints.channelCount, { ideal: 1 });

const beginSpeech = (vad, start = 0) => {
  vad.start(start);
  vad.update(0.002, start + 1);
  assert.equal(vad.update(0.04, start + 10)?.type, "speech_candidate");
  assert.equal(vad.update(0.04, start + 240)?.type, "speech_started");
};

{
  const vad = createVadController({ calibrationMs: 0 });
  beginSpeech(vad);
  vad.noteTranscript("possible", { providerFinal: true }, 700);
  vad.update(0.04, 1250);
  vad.update(0.001, 1300);
  assert.equal(vad.update(0.001, 1900)?.type, "soft_pause");
  assert.notEqual(vad.update(0.001, 2800)?.type, "finalize", "one unknown word must not finalize at 1.5 seconds");
}

{
  const vad = createVadController({ calibrationMs: 0 });
  beginSpeech(vad);
  vad.noteTranscript("I want", { providerFinal: true }, 800);
  vad.update(0.04, 1250);
  vad.update(0.001, 1300);
  vad.update(0.001, 1800);
  assert.notEqual(vad.update(0.001, 2800)?.type, "finalize", "two-word incomplete speech must remain open");
}

{
  const vad = createVadController({ calibrationMs: 0 });
  beginSpeech(vad);
  vad.noteTranscript("I want to explain", {}, 700);
  assert.equal(vad.update(0.001, 1000), null);
  assert.equal(vad.update(0.04, 1700), null, "a 700 ms pause must remain in the same utterance");
  assert.equal(vad.getState(), "speaking");
}

{
  const vad = createVadController({ calibrationMs: 0 });
  beginSpeech(vad);
  vad.noteTranscript("I stopped because", { providerFinal: true }, 800);
  vad.update(0.04, 1250);
  vad.update(0.001, 1300);
  vad.update(0.001, 1800);
  assert.notEqual(vad.update(0.001, 2800)?.type, "finalize", "an incomplete connector must survive a 1.5 second pause");
  assert.equal(analyzeTranscriptCompleteness("kwa sababu").incomplete, true);
  assert.equal(analyzeTranscriptCompleteness("kandi umuntu").completeShortPhrase, false);
}

{
  const vad = createVadController({ calibrationMs: 0 });
  beginSpeech(vad);
  vad.noteTranscript("I understand.", { providerFinal: true, speechFinal: true }, 1000);
  vad.update(0.04, 1250);
  vad.update(0.001, 1300);
  vad.update(0.001, 1900);
  assert.equal(vad.update(0.001, 4200)?.type, "finalize", "a complete sentence should finalize after a strong pause");
  assert.equal(vad.cancelFinalization(4250), true, "renewed speech during final chunk grace must cancel finalization");
  assert.equal(vad.getState(), "speaking");
}

for (const phrase of ["Thank you", "Murakoze"]) {
  const vad = createVadController({ calibrationMs: 0 });
  beginSpeech(vad);
  vad.noteTranscript(phrase, { providerFinal: true }, 800);
  vad.update(0.04, 1250);
  vad.update(0.001, 1300);
  vad.update(0.001, 1900);
  assert.equal(vad.update(0.001, 3150)?.type, "finalize", `${phrase} should use the complete short-phrase exception`);
}

{
  const vad = createVadController({ calibrationMs: 0 });
  beginSpeech(vad);
  vad.noteTranscript("This sentence is complete.", { providerFinal: true }, 900);
  vad.update(0.001, 1200);
  assert.equal(vad.update(0.001, 1800)?.type, "soft_pause");
  assert.equal(vad.update(0.04, 2200)?.type, "speech_resumed", "speech resuming in soft-pause must cancel finalization");
  assert.equal(vad.getState(), "speaking");
}

assert.ok(getDynamicSilenceHoldMs("one word") >= 2800);
assert.ok(getDynamicSilenceHoldMs("We have enough words to make this complete.", { speechFinal: true }) <= 2400);
assert.ok(getDynamicSilenceHoldMs("I would like to") > getDynamicSilenceHoldMs("I understand."));

{
  const vad = createVadController({ calibrationMs: 0, autoFinalize: false });
  beginSpeech(vad);
  vad.noteTranscript("This is complete.", { providerFinal: true, speechFinal: true }, 800);
  vad.update(0.04, 1250);
  vad.update(0.001, 1300);
  vad.update(0.001, 1900);
  assert.notEqual(vad.update(0.001, 6000)?.type, "finalize", "disabled auto-finalization must continue listening through silence");
}

const duplicateGuard = createVadController({ calibrationMs: 0 });
duplicateGuard.start(0);
duplicateGuard.update(0, 1);
assert.equal(duplicateGuard.update(0, 2), null, "calibration transition is emitted once");

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
assert.deepEqual(recorder.calls, ["resume", "requestData", "pause"], "the final chunk must be requested before pausing");
assert.deepEqual(transmitted, [1, 2]);
sendChunk(0);
assert.equal(sequence, 2, "zero-byte chunks must not consume sequence numbers");
recorder.resume();
assert.equal(recorder.instances, 1, "automatic resume must reuse the MediaRecorder");
recorder.stop();
assert.equal(recorder.state, "inactive", "manual stop must stop the recorder");
console.log("Hybrid VAD controller regression tests passed.");
