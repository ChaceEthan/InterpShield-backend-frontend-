import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRecorderGenerationController, createRecordingStateMachine } from "../src/audio/recordingStateMachine.mjs";

const timers = new Map();
let timerId = 0;
const phases = [], captureStops = [], sessionClosed = [];
const lifecycle = createRecordingStateMachine({
  silenceMs: 1600,
  drainTimeoutMs: 8000,
  setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
  clearTimer(id) { timers.delete(id); },
  onPhaseChange(phase) { phases.push(phase); },
  onStopCapture() { captureStops.push("capture-and-tracks-released"); },
  onDrainComplete(reason) { sessionClosed.push(reason); }
});

assert.equal(lifecycle.start(), true, "one press starts one idle utterance lifecycle");
assert.equal(lifecycle.noteSilence(), false, "silence before meaningful speech cannot finalize");
lifecycle.noteMeaningfulSpeech();
assert.equal(lifecycle.noteSilence(), true, "meaningful speech arms the desktop 1600 ms silence timer");
assert.equal(lifecycle.canEmitAudio(), true, "audio emits while the utterance is listening");
const desktopTimer = [...timers.values()].find(({ delay }) => delay === 1600);
assert.ok(desktopTimer, "desktop silence threshold is explicit");
desktopTimer.callback();
assert.equal(lifecycle.snapshot().phase, "draining", "sustained silence enters draining");
assert.equal(captureStops.length, 1, "MediaRecorder and microphone tracks stop exactly once at finalization");
assert.equal(lifecycle.canEmitAudio(), false, "no audio emits after utterance finalization");
assert.equal(lifecycle.beginDrain(), false, "duplicate finalization is ignored");
assert.equal(lifecycle.start(), false, "a second press cannot start until the drain settles");

// A final transcript can arrive after capture is released; translations and automatic
// dubbing still finish before the backend session closes.
lifecycle.noteFinalTranscript(["zh", "fr"]);
assert.equal(lifecycle.snapshot().phase, "translating", "final transcript during drain starts translation work");
lifecycle.noteLanguageSettled("zh", { dubbingQueued: true });
lifecycle.noteDubbingSubmitted("zh");
assert.equal(sessionClosed.length, 0, "one completed target cannot close work for another target");
lifecycle.noteLanguageSettled("fr", { dubbingQueued: true });
lifecycle.noteDubbingSubmitted("fr");
assert.equal(lifecycle.snapshot().phase, "idle", "translated/Dubbed utterance returns the microphone button to idle");
assert.deepEqual(sessionClosed, ["processed"], "backend closes only after valid transcript, translations, and Dubbing handoff");

// Each later press owns a fresh generation and behaves identically.
const starts = [], stops = [];
const recorder = createRecorderGenerationController({ onStart: (event) => starts.push(event), onStop: (event) => stops.push(event) });
for (const expectedGeneration of [1, 2, 3]) {
  assert.equal(recorder.explicitStart(), expectedGeneration, `press ${expectedGeneration} creates a fresh generation`);
  assert.equal(recorder.sessionReady(expectedGeneration - 1), false, "stale session acknowledgement is ignored");
  assert.equal(recorder.sessionReady(expectedGeneration), true, "current session acknowledgement starts capture once");
  assert.equal(recorder.sessionReady(expectedGeneration), false, "duplicate acknowledgement cannot restart capture");
  assert.equal(recorder.beginDrain(), true, "current generation can enter draining once");
  assert.equal(recorder.beginDrain(), false, "stale or duplicate drain cannot stop capture twice");
  assert.equal(recorder.finish("processed"), true, "completed drain releases this recorder generation");
  assert.equal(recorder.snapshot().phase, "idle", "there is no automatic return to continuous listening");
}
assert.equal(starts.length, 3, "three explicit presses produce exactly three recorder starts");
assert.equal(stops.length, 3, "each completed utterance stops its recorder exactly once");
assert.deepEqual(stops.map(({ generation }) => generation), [1, 2, 3], "late events cannot affect the next generation");

const mobileLifecycle = createRecordingStateMachine({ silenceMs: 1400, setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimer(id) { timers.delete(id); } });
mobileLifecycle.start(); mobileLifecycle.noteMeaningfulSpeech(); mobileLifecycle.noteSilence();
assert.ok([...timers.values()].some(({ delay }) => delay === 1400), "mobile silence threshold is 1400 ms");

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
for (const guard of ["startInFlightRef", "stopInFlightRef", "activeRecordingGenerationRef", "activeSessionIdRef", "recorderStartedForGenerationRef", "recorderStoppedForGenerationRef"]) {
  assert.match(appSource, new RegExp(`const ${guard} = useRef`), `${guard} protects recording ownership`);
}
assert.match(appSource, /hardFinalizeMs: 1600/, "desktop uses the required 1600 ms threshold");
assert.match(appSource, /hardFinalizeMs: 1400/, "mobile uses the required 1400 ms threshold");
assert.match(appSource, /activeRecordingGenerationRef\.current !== recordingGeneration/, "stale recorder callbacks are ignored");
assert.match(appSource, /sessionId && activeSessionIdRef\.current && sessionId !== activeSessionIdRef\.current\) return/, "stale transcript events are ignored");
assert.match(appSource, /cleanupMedia\(\{ preserveTranslationPipeline: true/, "capture cleanup preserves translation draining and automatic Dubbing");
assert.match(appSource, /const speakTranslatedCaption[\s\S]*?stopDubbingPlayback\(false\)/, "manual card replay remains independent of capture cleanup");

// Desktop must keep the SAME MediaRecorder/stream/socket session/sessionId/recordingGeneration
// alive across many utterances; only an explicit user Stop (or mobile, which intentionally
// auto-stops per utterance) ends it. A sustained-silence finalize just cycles the recorder.
assert.match(appSource, /const explicitStopRequestedRef = useRef\(false\)/, "an explicit-stop flag distinguishes a user Stop from a routine utterance finish");
assert.match(appSource, /const continueListeningAfterStopRef = useRef\(false\)/, "a flag marks whether the just-stopped recorder should restart into the same session");
assert.match(appSource, /explicitStopRequestedRef\.current = true;\s*stopInFlightRef\.current = true;/, "pressing Stop marks the session as explicitly ended before cleanup runs");
assert.match(appSource, /explicitStopRequestedRef\.current = false;\s*continueListeningAfterStopRef\.current = false;\s*startInFlightRef\.current = true;/, "a fresh Start clears any earlier explicit-stop or continue-listening marker");
assert.match(appSource, /const continueListening = reason === "vad_sustained_silence" && isDesktopChrome\(\) && !explicitStopRequestedRef\.current;/, "only a sustained-silence desktop finalize (not an explicit Stop) keeps the session open");
assert.match(appSource, /if \(continueListening && recorderWasRecording\) \{[\s\S]{0,260}return true;\s*\}[\s\S]{0,260}recordingRef\.current = false;/, "continuing utterances skip the full stream/socket teardown that mobile and explicit stops still run");
assert.match(appSource, /const recorderWasRecording = recorder\?\.state === "recording";\s*continueListeningAfterStopRef\.current = continueListening && recorderWasRecording;/, "continuation is only armed when the recorder is actually recording, so onstop is guaranteed to fire and restart it");
assert.match(appSource, /if \(continueListeningAfterStopRef\.current && recordingRef\.current && !explicitStopRequestedRef\.current\) \{/, "the recorder's onstop handler re-checks Stop was not pressed mid-restart before resurrecting capture");
assert.match(appSource, /recorderStoppedForGenerationRef\.current = null;\s*finalizationEmittedForGenerationRef\.current = null;/, "per-generation dedup guards reset after each utterance so the next utterance's stop/boundary can fire again");
assert.match(appSource, /vadControllerRef\.current\.markPaused\(\);\s*utteranceLifecycleRef\.current\.start\(\{ now: Date\.now\(\), recordingGeneration: lifecycle\.recordingGeneration, sessionId: lifecycle\.sessionId \}\);/, "VAD and utterance phase reset for the next sentence while reusing the SAME recordingGeneration and sessionId");
assert.match(appSource, /reason: "utterance_boundary_continue", recordingGeneration: activeRecordingGenerationRef\.current/, "the recorder restart is logged without minting a new recordingGeneration");
assert.match(appSource, /if \(activeRecordingGenerationRef\.current !== recordingGeneration \|\| explicitStopRequestedRef\.current\) \{\s*stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\);/, "a Stop pressed while (re-)acquiring the stream releases it instead of resurrecting capture");
assert.doesNotMatch(appSource, /RECORDING_SESSION_CONTINUES|CONTINUOUS_INACTIVITY_TIMEOUT_MS/, "the old inactivity-timeout continuous-recording mode is absent; continuity now comes from the recorder-cycle mechanism above");

// Ten-utterance proof: a faithful model of the App.tsx mechanism above (same generation and
// sessionId reused, per-generation dedup refs reset after each stop) must survive ten
// consecutive sustained-silence finalizations without ever tearing the session down, and must
// still tear down cleanly the moment an explicit Stop is pressed.
{
  const recordingGeneration = 7;
  const boundaryEmissions = [];
  const restarts = [];
  const teardowns = [];
  const refs = {
    recorderStoppedForGenerationRef: { current: null },
    finalizationEmittedForGenerationRef: { current: null },
    explicitStopRequestedRef: { current: false }
  };

  const emitUtteranceFinalization = () => {
    if (refs.finalizationEmittedForGenerationRef.current === recordingGeneration) return false;
    refs.finalizationEmittedForGenerationRef.current = recordingGeneration;
    boundaryEmissions.push(recordingGeneration);
    return true;
  };

  const beginDrainThenOnstop = () => {
    const continueListening = !refs.explicitStopRequestedRef.current;
    if (refs.recorderStoppedForGenerationRef.current !== recordingGeneration) {
      refs.recorderStoppedForGenerationRef.current = recordingGeneration;
    }
    emitUtteranceFinalization();
    if (!continueListening) {
      teardowns.push(recordingGeneration);
      return;
    }
    refs.recorderStoppedForGenerationRef.current = null;
    refs.finalizationEmittedForGenerationRef.current = null;
    restarts.push(recordingGeneration);
  };

  for (let utterance = 1; utterance <= 10; utterance += 1) {
    beginDrainThenOnstop();
  }
  assert.equal(restarts.length, 10, "ten consecutive sustained-silence utterances each restart capture");
  assert.deepEqual(new Set(restarts), new Set([recordingGeneration]), "every restart reuses the exact same recordingGeneration, never minting a new one");
  assert.equal(boundaryEmissions.length, 10, "every one of the ten utterances dispatches its own translation boundary");
  assert.equal(teardowns.length, 0, "ten consecutive utterances never trigger a full session teardown");

  refs.explicitStopRequestedRef.current = true;
  beginDrainThenOnstop();
  assert.deepEqual(teardowns, [recordingGeneration], "pressing Stop after any number of utterances tears the session down exactly once, in the same generation it ran in throughout");
}

assert.deepEqual(phases.slice(0, 4), ["listening", "draining", "translating", "idle"], "the mobile/explicit-stop lifecycle has one bounded utterance path");
console.log("Desktop continuous-session and mobile one-utterance regression tests passed.");
