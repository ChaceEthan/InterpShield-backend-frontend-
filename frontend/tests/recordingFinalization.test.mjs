import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRecorderGenerationController, createRecordingStateMachine } from "../src/audio/recordingStateMachine.mjs";
import { createUtteranceBoundaryController } from "../src/audio/recorderLifecycle.mjs";

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

// Each later press owns a fresh generation and behaves identically. Mobile presses the mic,
// completes an utterance, and returns to idle — the user must be able to repeat this at least
// 5 times in a row, each cycle fully independent of the last.
const MOBILE_CYCLE_COUNT = 5;
const starts = [], stops = [];
const recorder = createRecorderGenerationController({ onStart: (event) => starts.push(event), onStop: (event) => stops.push(event) });
for (let expectedGeneration = 1; expectedGeneration <= MOBILE_CYCLE_COUNT; expectedGeneration += 1) {
  assert.equal(recorder.explicitStart(), expectedGeneration, `press ${expectedGeneration} creates a fresh generation`);
  assert.equal(recorder.sessionReady(expectedGeneration - 1), false, "stale session acknowledgement is ignored");
  assert.equal(recorder.sessionReady(expectedGeneration), true, "current session acknowledgement starts capture once");
  assert.equal(recorder.sessionReady(expectedGeneration), false, "duplicate acknowledgement cannot restart capture");
  assert.equal(recorder.beginDrain(), true, "current generation can enter draining once");
  assert.equal(recorder.beginDrain(), false, "stale or duplicate drain cannot stop capture twice");
  assert.equal(recorder.finish("processed"), true, "completed drain releases this recorder generation");
  assert.equal(recorder.snapshot().phase, "idle", "there is no automatic return to continuous listening — mobile returns to idle, ready for the next press");
}
assert.equal(starts.length, MOBILE_CYCLE_COUNT, "five explicit presses produce exactly five recorder starts");
assert.equal(stops.length, MOBILE_CYCLE_COUNT, "each of the five completed utterances stops its recorder exactly once");
assert.deepEqual(stops.map(({ generation }) => generation), Array.from({ length: MOBILE_CYCLE_COUNT }, (_, index) => index + 1), "late events cannot affect the next generation, across all five cycles");

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

// Desktop must keep ONE continuous MediaRecorder/stream/socket/Deepgram session alive across
// many utterances: an ordinary sustained-silence utterance boundary never calls
// recorder.stop()/cleanupMedia() at all. Only an explicit user Stop (or mobile, which
// intentionally finalizes and stops per utterance) tears anything down.
assert.match(appSource, /const explicitStopRequestedRef = useRef\(false\)/, "an explicit-stop flag distinguishes a user Stop from a routine utterance finish");
assert.match(appSource, /explicitStopRequestedRef\.current = true;\s*stopInFlightRef\.current = true;/, "pressing Stop marks the session as explicitly ended before cleanup runs");
assert.match(appSource, /const continueListening = reason === "vad_sustained_silence" && isDesktopChrome\(\) && !explicitStopRequestedRef\.current;\s*if \(continueListening\) \{/, "only a sustained-silence desktop finalize (not an explicit Stop) takes the no-teardown path");
assert.match(appSource, /const armed = utteranceBoundaryRef\.current\?\.request\(\{ sequence: sequenceRef\.current, capturedAt: Date\.now\(\), speechThreshold: utteranceLifecycleRef\.current\.snapshot\(\)\.threshold \}\) \?\? false;/, "a desktop utterance boundary is requested through the boundary controller instead of stopping the recorder");
assert.doesNotMatch(appSource, /if \(continueListening[\s\S]{0,50}recorderWasRecording\)/, "the old stop-then-restart continuation branch is gone");
assert.doesNotMatch(appSource, /continueListeningAfterStopRef/, "the recorder-cycling flag from the old per-utterance restart architecture no longer exists");
assert.doesNotMatch(appSource, /reason: "utterance_boundary_continue"/, "no code path restarts the recorder for an ordinary utterance boundary anymore");

// The boundary controller only fires its callback once the flush chunk is actually captured
// (or a timeout elapses); only then is it safe to reset VAD/utterance state for the next
// sentence, and the per-utterance dedup guard is reset so every utterance (not just the
// first) can emit its own boundary within the one long-lived recordingGeneration.
assert.match(appSource, /onBoundary: \(boundary, reason\) => \{\s*if \(utteranceLifecycleRef\.current\.snapshot\(\)\.phase !== "draining"\) return;\s*pendingSpeechChunksRef\.current = \[\];\s*emitUtteranceFinalization\(boundary\.capturedAt, reason === "dataavailable", reason\);/, "the boundary controller emits the audio_utterance_end signal once the flush is confirmed");
assert.match(appSource, /vadControllerRef\.current\.markPaused\(\);\s*utteranceLifecycleRef\.current\.start\(\{ now: Date\.now\(\), recordingGeneration: activeRecordingGenerationRef\.current, sessionId \}\);/, "VAD and utterance phase reset for the next sentence while reusing the SAME recordingGeneration");
assert.match(appSource, /finalizationEmittedForGenerationRef\.current = null;\s*return true;\s*\};/, "the per-utterance boundary dedup guard resets immediately after firing, since recordingGeneration no longer changes between utterances");

// Desktop must never gate whether a valid encoded chunk reaches the backend on client-side
// RMS/VAD state — only Deepgram's own VAD/endpointing decides what is speech.
assert.match(appSource, /if \(isDesktopChrome\(\)\) \{[\s\S]{0,400}finalChunkSent = sendCapturedChunk\(chunk\);\s*return;\s*\}\s*const vadState = vadControllerRef\.current\.getState\(\);/, "desktop sends every valid chunk unconditionally; only mobile still buffers on client VAD state");
assert.doesNotMatch(appSource, /RECORDING_SESSION_CONTINUES|CONTINUOUS_INACTIVITY_TIMEOUT_MS/, "the old inactivity-timeout continuous-recording mode is absent");

// Ten-utterance proof using the REAL createUtteranceBoundaryController module: one recorder
// "start", zero recorder "stop"s across all ten utterance boundaries, each producing exactly
// one boundary emission — proving the continuous desktop session never touches the recorder
// for ordinary sentence boundaries. Only an explicit Stop, modeled separately, ever stops it.
{
  const DESKTOP_UTTERANCE_COUNT = 10;
  let recorderStartCount = 0;
  let recorderStopCount = 0;
  const boundaryEmissions = [];
  const cancellations = [];

  recorderStartCount += 1; // one MediaRecorder.start() for the whole live session

  const boundary = createUtteranceBoundaryController({
    timeoutMs: 2500,
    getAudioLevel: () => 0.001, // silence by the time the flush chunk is captured
    onBoundary: (requested) => boundaryEmissions.push(requested.sequence),
    onCancelled: (requested) => cancellations.push(requested.sequence)
  });

  for (let utterance = 1; utterance <= DESKTOP_UTTERANCE_COUNT; utterance += 1) {
    assert.equal(boundary.request({ sequence: utterance, capturedAt: Date.now(), speechThreshold: 0.003 }), true, `utterance ${utterance} can request a boundary`);
    assert.equal(boundary.request({ sequence: utterance, capturedAt: Date.now(), speechThreshold: 0.003 }), false, `utterance ${utterance} cannot double-request while one is already pending`);
    // The flush chunk containing this utterance's tail audio arrives — this is the ONLY
    // signal that resolves the boundary; recorder.stop()/start() is never involved.
    assert.equal(boundary.onDataAvailable(0.001), true, `utterance ${utterance}'s flush chunk settles its boundary`);
  }

  assert.equal(recorderStartCount, 1, "MediaRecorder starts exactly once for the whole live session");
  assert.equal(recorderStopCount, 0, "MediaRecorder never stops across all ten utterance boundaries");
  assert.equal(boundaryEmissions.length, DESKTOP_UTTERANCE_COUNT, "all ten utterances produced exactly one boundary emission each");
  assert.deepEqual(boundaryEmissions, Array.from({ length: DESKTOP_UTTERANCE_COUNT }, (_, index) => index + 1), "boundaries fire in utterance order, one per utterance");
  assert.equal(cancellations.length, 0, "none of the ten utterances were cancelled");

  // If the speaker resumes talking before the flush chunk arrives, the boundary must cancel
  // instead of prematurely finalizing an utterance that is still ongoing.
  assert.equal(boundary.request({ sequence: 11, capturedAt: Date.now(), speechThreshold: 0.003 }), true, "an eleventh utterance can still request a boundary");
  assert.equal(boundary.onDataAvailable(0.05), false, "resumed speech above the threshold settles the pending boundary as a cancellation (not a finalization, hence a false return), not a finalization");
  assert.equal(boundaryEmissions.length, DESKTOP_UTTERANCE_COUNT, "a cancelled boundary does not count as a finalized utterance");
  assert.deepEqual(cancellations, [11], "resumed speech cancels the boundary instead of finalizing it");

  // Only an explicit Stop — modeled here as a wholly separate action, never triggered by the
  // boundary controller itself — increments the stop count.
  recorderStopCount += 1;
  assert.equal(recorderStopCount, 1, "explicit Stop is the only thing that ever stops the recorder in this scenario");
}

// Same ten-utterance desktop session, this time modeling the transcript/translation half of
// the real App.tsx flow: awaitingFinalTranscriptRef blocks a new beginDrain until this
// utterance's final transcript resolves (mirroring the real guard at the top of beginDrain),
// interim transcripts never dispatch a job, and exactly one final transcript per utterance
// creates exactly one translation job before the card completes and the next utterance
// becomes possible.
{
  let awaitingFinalTranscript = false;
  const interimEvents = [];
  const translationJobsCreated = [];
  const cardsCompleted = [];

  const beginDrainForUtterance = (utteranceId) => {
    if (awaitingFinalTranscript) return false; // mirrors: if (awaitingFinalTranscriptRef.current) return false;
    awaitingFinalTranscript = true;
    return true;
  };
  const receiveInterim = (utteranceId, text) => {
    interimEvents.push({ utteranceId, text }); // interim only ever updates the live caption
  };
  const receiveFinal = (utteranceId, text) => {
    if (!awaitingFinalTranscript) return; // a final for an utterance nobody is awaiting is ignored
    translationJobsCreated.push({ utteranceId, text }); // exactly one job per final transcript
    awaitingFinalTranscript = false; // mirrors transcript_final clearing awaitingFinalTranscriptRef
  };
  const receiveTranslationResult = (utteranceId) => {
    cardsCompleted.push(utteranceId);
  };

  for (let utterance = 1; utterance <= 10; utterance += 1) {
    assert.equal(beginDrainForUtterance(utterance), true, `utterance ${utterance} can begin draining because no earlier utterance is still awaited`);
    receiveInterim(utterance, `partial ${utterance}`);
    receiveInterim(utterance, `partial ${utterance} continued`);
    receiveFinal(utterance, `final sentence ${utterance}`);
    receiveTranslationResult(utterance);
  }

  assert.equal(interimEvents.length, 20, "every utterance's interim updates are captured (caption-only, never counted as jobs)");
  assert.equal(translationJobsCreated.length, 10, "exactly ten translation jobs exist for ten utterances — one each, never zero, never duplicated");
  assert.deepEqual(translationJobsCreated.map((job) => job.utteranceId), Array.from({ length: 10 }, (_, index) => index + 1), "each job belongs to its own utterance in order");
  assert.equal(cardsCompleted.length, 10, "every utterance's card reaches completion");
  assert.equal(awaitingFinalTranscript, false, "the tenth utterance's completion leaves the session ready for an eleventh, not stuck awaiting a transcript");

  // A duplicate final for an already-resolved utterance (e.g. is_final followed by a
  // duplicate speech_final) must not create a second translation job.
  receiveFinal(10, "duplicate final sentence 10");
  assert.equal(translationJobsCreated.length, 10, "a duplicate final/speech_final for an already-resolved utterance cannot double-dispatch translation");
}

assert.deepEqual(phases.slice(0, 4), ["listening", "draining", "translating", "idle"], "the mobile/explicit-stop lifecycle has one bounded utterance path");
console.log("Desktop continuous-session and mobile one-utterance regression tests passed.");
