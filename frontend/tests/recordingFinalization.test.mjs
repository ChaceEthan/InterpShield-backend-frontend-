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

// Desktop live mode: App.tsx's finishDrain auto-restarts a fresh generation after every
// "processed" utterance (see the shouldContinueListening assertions below), so one live
// session is really a chain of these generations. Ten in a row must each independently
// caption and dispatch a translation, and none may leave the recorder stuck mid-utterance.
const desktopStarts = [], desktopStops = [];
const desktopSession = createRecorderGenerationController({ onStart: (event) => desktopStarts.push(event), onStop: (event) => desktopStops.push(event) });
const desktopUtteranceCount = 10;
for (let utterance = 1; utterance <= desktopUtteranceCount; utterance += 1) {
  const generation = desktopSession.explicitStart();
  assert.equal(generation, utterance, `desktop utterance ${utterance} restarts into its own fresh generation`);
  assert.equal(desktopSession.sessionReady(generation), true, `utterance ${utterance} begins capturing once acknowledged`);
  assert.equal(desktopSession.beginDrain(), true, `utterance ${utterance} finalizes into draining exactly once`);
  assert.equal(desktopSession.finish("processed"), true, `utterance ${utterance} completes translation dispatch and releases capture`);
  assert.equal(desktopSession.snapshot().phase, "idle", `utterance ${utterance} leaves the generation ready for the next auto-restart, not stuck translating`);
}
assert.equal(desktopStarts.length, desktopUtteranceCount, "ten consecutive desktop utterances each start capture exactly once");
assert.equal(desktopStops.length, desktopUtteranceCount, "ten consecutive desktop utterances each dispatch exactly one translation and stop capture exactly once, none stuck mid-utterance");
assert.deepEqual(desktopStops.map(({ generation }) => generation), Array.from({ length: desktopUtteranceCount }, (_, index) => index + 1), "no utterance's finalization can leak into or block a later generation");

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

// Desktop must keep listening across repeated utterances in one live session; only an
// explicit user Stop (or mobile, which intentionally auto-stops per utterance) ends it.
assert.match(appSource, /const explicitStopRequestedRef = useRef\(false\)/, "an explicit-stop flag distinguishes a user Stop from a routine utterance finish");
assert.match(appSource, /explicitStopRequestedRef\.current = true;\s*stopInFlightRef\.current = true;/, "pressing Stop marks the session as explicitly ended before cleanup runs");
assert.match(appSource, /explicitStopRequestedRef\.current = false;\s*startInFlightRef\.current = true;/, "a fresh Start clears any earlier explicit-stop marker");
assert.match(appSource, /const shouldContinueListening = reason === "processed" && isDesktopChrome\(\) && !explicitStopRequestedRef\.current;/, "only a processed desktop utterance without an explicit Stop restarts listening");
assert.match(appSource, /shouldContinueListening[\s\S]{0,200}void startSessionRef\.current\(\);/, "desktop automatically opens the next utterance's session instead of going idle");
assert.match(appSource, /if \(activeRecordingGenerationRef\.current !== recordingGeneration \|\| explicitStopRequestedRef\.current\) \{\s*stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\);/, "a Stop pressed mid-restart releases the newly acquired microphone stream instead of resurrecting it");
assert.match(appSource, /startSessionRef\.current = startSession;/, "the desktop auto-restart can invoke the latest startSession without a dependency cycle");
assert.doesNotMatch(appSource, /RECORDING_SESSION_CONTINUES|CONTINUOUS_INACTIVITY_TIMEOUT_MS/, "the old continuous-recording mode is absent");
assert.deepEqual(phases.slice(0, 4), ["listening", "draining", "translating", "idle"], "the lifecycle has one bounded utterance path");
console.log("One-utterance auto-stop, draining, Dubbing, and generation regression tests passed.");
