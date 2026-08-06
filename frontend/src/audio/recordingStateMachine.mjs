export const createRecordingStateMachine = ({ silenceMs = 1500, drainTimeoutMs = 8000, setTimer = setTimeout, clearTimer = clearTimeout, onPhaseChange = () => {}, onStopCapture = () => {}, onDrainComplete = () => {} } = {}) => {
  let phase = "idle", meaningfulSpeech = false, silenceTimer = null, drainTimer = null, awaitingFinalTranscript = false;
  const pendingLanguages = new Set(), dubbingSubmissions = new Set();
  const change = (next) => { if (phase !== next) { phase = next; onPhaseChange(next); } };
  const clearSilence = () => { if (silenceTimer !== null) clearTimer(silenceTimer); silenceTimer = null; };
  const finish = (reason) => {
    if (!['draining', 'translating'].includes(phase)) return false;
    clearSilence(); if (drainTimer !== null) clearTimer(drainTimer); drainTimer = null;
    awaitingFinalTranscript = false; pendingLanguages.clear(); dubbingSubmissions.clear(); meaningfulSpeech = false;
    if (reason === 'processed') change('listening');
    else { change('idle'); onStopCapture(); }
    onDrainComplete(reason); return true;
  };
  const maybeFinish = () => { if (!awaitingFinalTranscript && !pendingLanguages.size && !dubbingSubmissions.size) finish('processed'); };
  const beginDrain = () => {
    if (phase !== 'listening') return false;
    clearSilence(); awaitingFinalTranscript = true; change('draining');
    drainTimer = setTimer(() => finish('timeout'), drainTimeoutMs); return true;
  };
  return {
    start() { clearSilence(); if (drainTimer !== null) clearTimer(drainTimer); drainTimer = null; meaningfulSpeech = false; awaitingFinalTranscript = false; pendingLanguages.clear(); dubbingSubmissions.clear(); change('listening'); },
    noteMeaningfulSpeech() { if (phase === 'listening') { meaningfulSpeech = true; clearSilence(); } },
    noteSilence() { if (phase !== 'listening' || !meaningfulSpeech || silenceTimer !== null) return false; silenceTimer = setTimer(() => { silenceTimer = null; beginDrain(); }, silenceMs); return true; },
    beginDrain,
    noteFinalTranscript(languages = []) { if (!['draining', 'translating'].includes(phase)) return; awaitingFinalTranscript = false; for (const language of languages) pendingLanguages.add(language); if (pendingLanguages.size) change('translating'); maybeFinish(); },
    noteLanguageSettled(language, { dubbingQueued = false } = {}) { pendingLanguages.delete(language); if (dubbingQueued) dubbingSubmissions.add(language); maybeFinish(); },
    noteDubbingSubmitted(language) { dubbingSubmissions.delete(language); maybeFinish(); },
    snapshot() { return { phase, meaningfulSpeech, awaitingFinalTranscript, pendingLanguages: [...pendingLanguages], dubbingSubmissions: [...dubbingSubmissions] }; }
  };
};

export const createRecorderGenerationController = ({ onStart = () => {}, onStop = () => {} } = {}) => {
  let phase = "idle", generation = 0, startInFlight = false, stopInFlight = false;
  let startedGeneration = 0, stoppedGeneration = 0, lastStreamGeneration = 1;
  return {
    explicitStart() {
      if (phase !== "idle" || startInFlight) return null;
      generation += 1; startInFlight = true; stopInFlight = false; phase = "starting";
      return generation;
    },
    sessionReady(readyGeneration) {
      if (phase !== "starting" || readyGeneration !== generation || startedGeneration === generation) return false;
      startedGeneration = generation; startInFlight = false; phase = "listening"; onStart({ generation, reason: "session_ready" }); return true;
    },
    reconnect() { return false; },
    streamGenerationChanged(streamGeneration) {
      if (phase !== "listening" || streamGeneration <= lastStreamGeneration) return false;
      lastStreamGeneration = streamGeneration; return true;
    },
    beginDrain() { if (phase !== "listening") return false; phase = "draining"; return true; },
    finish(reason = "processed") {
      if (!['draining', 'finalizing'].includes(phase) || stopInFlight || stoppedGeneration === generation) return false;
      if (reason === "processed") { phase = "listening"; return true; }
      phase = "finalizing"; stopInFlight = true; stoppedGeneration = generation; onStop({ generation, reason });
      stopInFlight = false; phase = "idle"; return true;
    },
    explicitStop() {
      if (!['starting', 'listening'].includes(phase) || stopInFlight || stoppedGeneration === generation) return false;
      stopInFlight = true; stoppedGeneration = generation; onStop({ generation, reason: "explicit_user_stop" });
      startInFlight = false; stopInFlight = false; phase = "idle"; return true;
    },
    snapshot() { return { phase, generation, startInFlight, stopInFlight, startedGeneration, stoppedGeneration, lastStreamGeneration }; }
  };
};
