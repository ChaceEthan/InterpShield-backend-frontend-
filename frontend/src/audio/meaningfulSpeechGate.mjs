export const DESKTOP_SPEECH_GATE_CONFIG = Object.freeze({
  startupGraceMs: 4000,
  noSpeechTimeoutMs: 12000,
  minimumThreshold: 0.0025,
  noiseFloorMultiplier: 1.35,
  consecutiveSamples: 3
});

export const createMeaningfulSpeechGate = (options = {}) => {
  const config = { ...DESKTOP_SPEECH_GATE_CONFIG, ...options };
  let startedAt = 0, deadline = 0, consecutiveSpeechSamples = 0, meaningfulSpeechDetected = false;
  let lastAudioLevel = 0, threshold = config.minimumThreshold, chunksCaptured = 0, chunksEmitted = 0;
  const start = (now = Date.now()) => {
    startedAt = now; deadline = now + config.noSpeechTimeoutMs; consecutiveSpeechSamples = 0;
    meaningfulSpeechDetected = false; lastAudioLevel = 0; threshold = config.minimumThreshold;
    chunksCaptured = 0; chunksEmitted = 0;
  };
  const observeAudio = ({ audioLevel = 0, noiseFloor = 0.001, bytes = 0, containerAudio = false, now = Date.now() } = {}) => {
    chunksCaptured += 1;
    lastAudioLevel = Number.isFinite(audioLevel) ? Math.max(0, audioLevel) : 0;
    threshold = Math.max(config.minimumThreshold, Math.max(0.001, noiseFloor) * config.noiseFloorMultiplier);
    const adaptiveSpeech = lastAudioLevel >= threshold;
    const lowRmsContainerSpeech = containerAudio && bytes >= 96 && lastAudioLevel >= Math.max(0.0015, noiseFloor * 1.08);
    if (adaptiveSpeech || lowRmsContainerSpeech) {
      consecutiveSpeechSamples += 1;
      deadline = now + config.noSpeechTimeoutMs;
      if (consecutiveSpeechSamples >= config.consecutiveSamples) meaningfulSpeechDetected = true;
    } else {
      consecutiveSpeechSamples = 0;
    }
    return snapshot(now);
  };
  const noteEmitted = () => { chunksEmitted += 1; };
  const confirmMeaningfulSpeech = (now = Date.now()) => {
    meaningfulSpeechDetected = true; consecutiveSpeechSamples = Math.max(consecutiveSpeechSamples, config.consecutiveSamples); deadline = Number.POSITIVE_INFINITY;
    return snapshot(now);
  };
  const shouldStopForNoSpeech = (now = Date.now()) => !meaningfulSpeechDetected && now - startedAt >= config.startupGraceMs && now >= deadline;
  const nextCheckDelay = (now = Date.now()) => Math.max(1, Math.max(startedAt + config.startupGraceMs, deadline) - now);
  const snapshot = (now = Date.now()) => ({
    startedAt, elapsedSinceStartMs: Math.max(0, now - startedAt), graceRemainingMs: Math.max(0, config.startupGraceMs - (now - startedAt)),
    deadline, consecutiveSpeechSamples, meaningfulSpeechDetected, lastAudioLevel, threshold, chunksCaptured, chunksEmitted
  });
  start(0);
  return { start, observeAudio, noteEmitted, confirmMeaningfulSpeech, shouldStopForNoSpeech, nextCheckDelay, snapshot, getConfig: () => ({ ...config }) };
};
