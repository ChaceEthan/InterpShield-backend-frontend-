import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeTranscriptCompleteness, buildProductionAudioConstraints, createVadController, getDynamicSilenceHoldMs } from "../src/audio/vadController.mjs";
import { createUtteranceBoundaryController, stableSessionStartTime } from "../src/audio/recorderLifecycle.mjs";
import { createMeaningfulSpeechGate, DESKTOP_SPEECH_GATE_CONFIG } from "../src/audio/meaningfulSpeechGate.mjs";

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
  assert.equal(analyzeTranscriptCompleteness("ndashaka ko").incomplete, true);
  assert.equal(analyzeTranscriptCompleteness("je veux que").incomplete, true);
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

assert.ok(getDynamicSilenceHoldMs("one word") >= 1300 && getDynamicSilenceHoldMs("one word") <= 1750);
assert.ok(getDynamicSilenceHoldMs("We have enough words to make this complete.", { speechFinal: true }) <= 1500);
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

{
  const desktopLowVolume = createVadController({ calibrationMs: 0 });
  desktopLowVolume.start(0);
  desktopLowVolume.update(0.001, 1);
  assert.equal(desktopLowVolume.update(0.008, 100)?.type, "speech_candidate");
  assert.equal(desktopLowVolume.update(0.008, 350)?.type, "speech_started", "calibrated low-volume desktop speech must cross the adaptive threshold");
  assert.equal(desktopLowVolume.update(0.004, 700), null, "normal low-volume speech must not be classified as silence");
  assert.equal(desktopLowVolume.getState(), "speaking");
}

{
  const desktopVad = createVadController({ calibrationMs: 0, speechThreshold: 0.003, silenceThreshold: 0.0018, noiseFloorMultiplier: 1.5, consecutiveSpeechSamples: 3 });
  desktopVad.start(0);
  desktopVad.update(0.001, 1);
  assert.equal(desktopVad.update(0.0035, 30)?.type, "speech_candidate");
  assert.equal(desktopVad.update(0.0035, 60), null);
  assert.equal(desktopVad.update(0.0035, 90)?.type, "speech_started", "three low-volume desktop samples must confirm meaningful speech");
}

{
  const gate = createMeaningfulSpeechGate({ noSpeechTimeoutMs: 1000 });
  gate.start(1000);
  assert.equal(gate.shouldStopForNoSpeech(2500), false, "no-speech timeout cannot fire during the four-second startup grace period");
  assert.equal(gate.shouldStopForNoSpeech(4999), false);
  assert.equal(gate.shouldStopForNoSpeech(5000), true, "real silence eventually becomes eligible to return idle");

  gate.start(1000);
  gate.observeAudio({ audioLevel: 0.002, noiseFloor: 0.0015, bytes: 128, containerAudio: true, now: 1500 });
  gate.observeAudio({ audioLevel: 0.002, noiseFloor: 0.0015, bytes: 128, containerAudio: true, now: 1530 });
  const lowVolume = gate.observeAudio({ audioLevel: 0.002, noiseFloor: 0.0015, bytes: 128, containerAudio: true, now: 1560 });
  assert.equal(lowVolume.meaningfulSpeechDetected, true, "clear WebM/Opus chunks confirm normal low-volume desktop speech after three samples");
  assert.equal(gate.shouldStopForNoSpeech(60000), false, "confirmed meaningful speech permanently cancels the initial no-speech timeout");

  gate.start(1000);
  gate.confirmMeaningfulSpeech(2000);
  assert.equal(gate.shouldStopForNoSpeech(60000), false, "a non-empty Deepgram partial cancels the no-speech timeout");
  assert.equal(DESKTOP_SPEECH_GATE_CONFIG.startupGraceMs, 4000);
}

{
  const gate = createMeaningfulSpeechGate({ noSpeechTimeoutMs: 1000 });
  gate.start({ now: 1000, recordingGeneration: 5, sessionId: "utt-1" });
  const initial = gate.snapshot();
  assert.equal(initial.phase, "listening", "a new utterance begins in listening state");
  assert.equal(initial.speechStarted, false, "speech has not started before meaningful speech is confirmed");
  gate.confirmMeaningfulSpeech(1500);
  assert.equal(gate.snapshot().speechStarted, true, "meaningful speech marks the utterance as started");
  assert.equal(gate.requestFinalization("vad_sustained_silence").accepted, true, "meaningful speech can request a finalization transition");
  assert.equal(gate.snapshot().phase, "draining", "a finalized utterance transitions into draining");
  assert.equal(gate.requestFinalization("vad_sustained_silence").accepted, false, "duplicate finalization transitions are ignored");
  assert.equal(gate.resetToIdle().phase, "idle", "the lifecycle can return to idle for the next utterance");
}

{
  const source = readFileSync(new URL("../src/components/TranscriptArea.tsx", import.meta.url), "utf8");
  assert.match(source, /whitespace-pre-wrap/, "translation cards preserve multiline content");
  assert.doesNotMatch(source, /line-clamp|overflow-hidden/, "translation cards must not clip long content");
  assert.match(source, /pb-24 sm:pb-0/, "mobile layout leaves room for the floating microphone control");
}

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

{
  const timers = [];
  const boundaries = [];
  const cancellations = [];
  let sessionStartedAt = stableSessionStartTime(null, 1000);
  let sequence = 7;
  let recorderStops = 0;
  let trackStops = 0;
  const lifecycle = createUtteranceBoundaryController({
    timeoutMs: 2500,
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => undefined,
    onBoundary: (boundary, reason) => boundaries.push({ ...boundary, reason }),
    onCancelled: (boundary, reason) => cancellations.push({ ...boundary, reason })
  });

  assert.equal(lifecycle.request({ sequence, capturedAt: 2000, speechThreshold: 0.02 }), true);
  assert.equal(boundaries.length, 0, "utterance retirement must await the final dataavailable event");
  assert.equal(recorderStops, 0, "soft-pause must not stop MediaRecorder");
  assert.equal(trackStops, 0, "soft-pause must not stop microphone tracks");
  assert.equal(stableSessionStartTime(sessionStartedAt, 5000), 1000, "soft-pause must not reset the session timer");
  assert.equal(sequence, 7, "utterance completion must not reset or consume sequence numbers");

  lifecycle.onDataAvailable(0.001);
  assert.equal(boundaries.length, 1, "delayed Android-style dataavailable must retire the utterance once");
  assert.equal(boundaries[0].reason, "dataavailable");
  assert.equal(lifecycle.hasPending(), false);

  sequence += 1;
  assert.equal(lifecycle.request({ sequence, capturedAt: 4000, speechThreshold: 0.02 }), true, "the same recorder lifecycle must support another utterance");
  lifecycle.onDataAvailable(0.04);
  assert.equal(cancellations.length, 1, "renewed speech must cancel a pending boundary");
  assert.equal(boundaries.length, 1);
  assert.equal(recorderStops, 0);
  assert.equal(trackStops, 0);
  sessionStartedAt = stableSessionStartTime(sessionStartedAt, 9000);
  assert.equal(sessionStartedAt, 1000, "multiple utterances must share one stable timer origin");
  assert.equal(lifecycle.request({ sequence: sequence + 1, capturedAt: 6000, speechThreshold: 0.02 }), true);
  timers.at(-1)();
  assert.equal(boundaries.at(-1).reason, "timeout", "a throttled mobile data event must use the non-destructive fallback boundary");
  lifecycle.stop();
}
console.log("Hybrid VAD controller regression tests passed.");
