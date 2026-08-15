export const DESKTOP_SPEECH_GATE_CONFIG = Object.freeze({
  startupGraceMs: 4000,
  noSpeechTimeoutMs: 12000,
  minimumThreshold: 0.0025,
  noiseFloorMultiplier: 1.35,
  consecutiveSamples: 3
});

export const createMeaningfulSpeechGate = (options = {}) => {
  const config = { ...DESKTOP_SPEECH_GATE_CONFIG, ...options };
  let phase = "idle";
  let recordingGeneration = 0;
  let sessionId = "";
  let startedAt = 0;
  let deadline = 0;
  let consecutiveSpeechSamples = 0;
  let meaningfulSpeechDetected = false;
  let speechStarted = false;
  let lastAudioLevel = 0;
  let threshold = config.minimumThreshold;
  let chunksCaptured = 0;
  let chunksEmitted = 0;
  let speechLikeSample = false;
  let speechStartedAt = 0, lastMeaningfulSpeechAt = 0, silenceStartedAt = 0, silenceDurationMs = 0;
  let finalizationRequested = false, captureStopped = false, transcriptPending = false, translationsPending = 0;

  const snapshot = (now = Date.now()) => ({
    phase,
    speechStarted,
    meaningfulSpeechDetected,
    recordingGeneration,
    sessionId,
    startedAt,
    elapsedSinceStartMs: Math.max(0, now - startedAt),
    graceRemainingMs: Math.max(0, config.startupGraceMs - (now - startedAt)),
    deadline,
    consecutiveSpeechSamples,
    lastAudioLevel,
    threshold,
    chunksCaptured,
    chunksEmitted,
    speechLikeSample,
    speechStartedAt, lastMeaningfulSpeechAt, silenceStartedAt, silenceDurationMs,
    finalizationRequested, captureStopped, transcriptPending, translationsPending
  });

  const start = (input = Date.now()) => {
    const now = typeof input === "number" ? input : input?.now ?? Date.now();
    const nextGeneration = typeof input === "number" ? recordingGeneration : Number.isFinite(input?.recordingGeneration) ? input.recordingGeneration : recordingGeneration;
    const nextSessionId = typeof input === "number" ? sessionId : input?.sessionId ? String(input.sessionId) : sessionId;
    startedAt = now;
    deadline = now + config.noSpeechTimeoutMs;
    consecutiveSpeechSamples = 0;
    meaningfulSpeechDetected = false;
    speechStarted = false;
    lastAudioLevel = 0;
    threshold = config.minimumThreshold;
    chunksCaptured = 0;
    chunksEmitted = 0;
    speechLikeSample = false;
    speechStartedAt = lastMeaningfulSpeechAt = silenceStartedAt = silenceDurationMs = 0;
    finalizationRequested = captureStopped = transcriptPending = false;
    translationsPending = 0;
    recordingGeneration = nextGeneration;
    sessionId = nextSessionId;
    phase = "listening";
    return snapshot(now);
  };

  const observeAudio = ({ audioLevel = 0, noiseFloor = 0.001, bytes = 0, containerAudio = false, now = Date.now() } = {}) => {
    chunksCaptured += 1;
    lastAudioLevel = Number.isFinite(audioLevel) ? Math.max(0, audioLevel) : 0;
    threshold = Math.max(config.minimumThreshold, Math.max(0.001, noiseFloor) * config.noiseFloorMultiplier);
    const adaptiveSpeech = lastAudioLevel >= threshold;
    const lowRmsContainerSpeech = containerAudio && bytes >= 96 && lastAudioLevel >= Math.max(0.0015, noiseFloor * 1.08);
    speechLikeSample = adaptiveSpeech || lowRmsContainerSpeech;
    if (speechLikeSample) {
      consecutiveSpeechSamples += 1;
      deadline = now + config.noSpeechTimeoutMs;
      if (consecutiveSpeechSamples >= config.consecutiveSamples) {
        meaningfulSpeechDetected = true;
        speechStarted = true;
        speechStartedAt ||= now;
        lastMeaningfulSpeechAt = now;
      }
    } else {
      consecutiveSpeechSamples = 0;
    }
    if (phase === "idle") phase = "listening";
    return snapshot(now);
  };

  const noteEmitted = () => { chunksEmitted += 1; };
  const confirmMeaningfulSpeech = (now = Date.now()) => {
    meaningfulSpeechDetected = true;
    speechStarted = true;
    speechStartedAt ||= now;
    lastMeaningfulSpeechAt = now;
    silenceStartedAt = silenceDurationMs = 0;
    consecutiveSpeechSamples = Math.max(consecutiveSpeechSamples, config.consecutiveSamples);
    deadline = Number.POSITIVE_INFINITY;
    if (phase === "idle") phase = "listening";
    return snapshot(now);
  };
  const observeVad = ({ type, silenceMs = 0, now = Date.now() } = {}) => {
    if (!meaningfulSpeechDetected || phase !== "listening") return snapshot(now);
    if (type === "speech_started" || type === "speech_resumed") {
      lastMeaningfulSpeechAt = now;
      silenceStartedAt = silenceDurationMs = 0;
    } else if (type === "soft_pause" || type === "finalize") {
      silenceDurationMs = Math.max(0, silenceMs);
      silenceStartedAt ||= now - silenceDurationMs;
    }
    return snapshot(now);
  };
  const requestFinalization = (reason = "vad_sustained_silence", generation = recordingGeneration) => {
    const phaseBefore = phase;
    if (generation !== recordingGeneration || phase !== "listening" || !speechStarted || finalizationRequested) return { accepted: false, reason, phaseBefore, phaseAfter: phase };
    phase = "draining";
    finalizationRequested = true;
    captureStopped = true;
    transcriptPending = true;
    return { accepted: true, reason, phaseBefore, phaseAfter: phase };
  };
  const setPhase = (nextPhase) => {
    phase = nextPhase;
    return snapshot(Date.now());
  };
  const setSessionId = (nextSessionId = "") => {
    sessionId = String(nextSessionId || "");
    return snapshot(Date.now());
  };
  const resetToIdle = (now = Date.now()) => {
    phase = "idle";
    meaningfulSpeechDetected = false;
    speechStarted = false;
    consecutiveSpeechSamples = 0;
    lastAudioLevel = 0;
    threshold = config.minimumThreshold;
    chunksCaptured = 0;
    chunksEmitted = 0;
    speechLikeSample = false;
    speechStartedAt = lastMeaningfulSpeechAt = silenceStartedAt = silenceDurationMs = 0;
    finalizationRequested = captureStopped = transcriptPending = false;
    translationsPending = 0;
    return snapshot(now);
  };
  const stop = (now = Date.now()) => resetToIdle(now);
  const shouldStopForNoSpeech = (now = Date.now()) => phase === "listening" && !meaningfulSpeechDetected && now - startedAt >= config.startupGraceMs && now >= deadline;
  const nextCheckDelay = (now = Date.now()) => Math.max(1, Math.max(startedAt + config.startupGraceMs, deadline) - now);
  start(0);
  return {
    start,
    observeAudio,
    noteEmitted,
    confirmMeaningfulSpeech,
    observeVad,
    requestFinalization,
    setPhase,
    setSessionId,
    resetToIdle,
    stop,
    shouldStopForNoSpeech,
    nextCheckDelay,
    snapshot,
    getConfig: () => ({ ...config })
  };
};
