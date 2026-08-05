export const createRecordingStateMachine = ({ silenceMs = 1500, drainTimeoutMs = 8000, setTimer = setTimeout, clearTimer = clearTimeout, onPhaseChange = () => {}, onStopCapture = () => {}, onDrainComplete = () => {} } = {}) => {
  let phase = "idle", meaningfulSpeech = false, silenceTimer = null, drainTimer = null, awaitingFinalTranscript = false;
  const pendingLanguages = new Set(), dubbingSubmissions = new Set();
  const change = (next) => { if (phase !== next) { phase = next; onPhaseChange(next); } };
  const clearSilence = () => { if (silenceTimer !== null) clearTimer(silenceTimer); silenceTimer = null; };
  const finish = (reason) => {
    if (!['draining', 'translating'].includes(phase)) return false;
    clearSilence(); if (drainTimer !== null) clearTimer(drainTimer); drainTimer = null;
    awaitingFinalTranscript = false; pendingLanguages.clear(); dubbingSubmissions.clear(); change('idle'); onDrainComplete(reason); return true;
  };
  const maybeFinish = () => { if (!awaitingFinalTranscript && !pendingLanguages.size && !dubbingSubmissions.size) finish('processed'); };
  const beginDrain = () => {
    if (phase !== 'listening') return false;
    clearSilence(); awaitingFinalTranscript = true; change('draining'); onStopCapture();
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
