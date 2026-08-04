export const DEFAULT_VAD_CONFIG = Object.freeze({ calibrationMs: 650, speechThreshold: 0.014, silenceThreshold: 0.009, minimumSpeechMs: 140, silenceHoldMs: 1500, preSpeechBufferMs: 900, maximumUtteranceMs: 45000, noiseFloorMultiplier: 2.4 });
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** @param {MediaTrackSupportedConstraints} [supported] @param {string | Record<string, unknown>} [microphoneOrOptions] */
export const buildProductionAudioConstraints = (supported = {}, microphoneOrOptions = {}) => ({
  ...(supported.echoCancellation !== false ? { echoCancellation: true } : {}),
  ...(supported.noiseSuppression !== false ? { noiseSuppression: true } : {}),
  ...(supported.autoGainControl !== false ? { autoGainControl: true } : {}),
  ...(supported.sampleRate ? { sampleRate: { ideal: 48000 } } : {}),
  ...(supported.channelCount ? { channelCount: { ideal: 1 } } : {}),
  ...(supported.sampleSize ? { sampleSize: { ideal: 16 } } : {}),
  ...(typeof microphoneOrOptions === "string" && microphoneOrOptions !== "default" ? { deviceId: { exact: microphoneOrOptions } } : {})
});
export const createVadController = (options = {}) => {
  const config = { ...DEFAULT_VAD_CONFIG, ...options };
  let state = "idle", startedAt = 0, calibrationTotal = 0, calibrationSamples = 0, noiseFloor = 0.003;
  let speechCandidateAt = 0, utteranceStartedAt = 0, silenceStartedAt = 0;
  const thresholds = () => {
    const speech = clamp(Math.max(config.speechThreshold, noiseFloor * config.noiseFloorMultiplier), config.speechThreshold, 0.12);
    return { speech, silence: clamp(Math.min(speech * 0.68, Math.max(config.silenceThreshold, noiseFloor * 1.35)), config.silenceThreshold, speech * 0.8) };
  };
  const start = (now = Date.now()) => { state = "calibrating"; startedAt = now; calibrationTotal = calibrationSamples = speechCandidateAt = utteranceStartedAt = silenceStartedAt = 0; return state; };
  const update = (rawLevel, now = Date.now(), forceTransmit = false) => {
    const level = Number.isFinite(rawLevel) ? clamp(rawLevel, 0, 1) : 0;
    if (state === "idle" || state === "stopped") return null;
    if (forceTransmit) { if (state !== "speaking") { state = "speaking"; utteranceStartedAt = now; silenceStartedAt = 0; return { type: "speech_started", state, level, ...thresholds() }; } silenceStartedAt = 0; return null; }
    if (state === "calibrating") { calibrationTotal += level; calibrationSamples += 1; if (now - startedAt >= config.calibrationMs) { noiseFloor = clamp(calibrationTotal / Math.max(1, calibrationSamples), 0.001, 0.04); state = "listening"; return { type: "calibrated", state, level, ...thresholds() }; } return null; }
    const { speech, silence } = thresholds();
    if (state === "listening" || state === "paused") { noiseFloor = clamp(noiseFloor * 0.985 + Math.min(level, speech) * 0.015, 0.001, 0.04); if (level >= speech) { if (!speechCandidateAt) { speechCandidateAt = now; return { type: "speech_candidate", state, level, speech, silence }; } if (now - speechCandidateAt >= config.minimumSpeechMs) { state = "speaking"; utteranceStartedAt = speechCandidateAt; silenceStartedAt = 0; return { type: "speech_started", state, level, speech, silence }; } } else if (level <= silence && speechCandidateAt) { speechCandidateAt = 0; return { type: "speech_cancelled", state, level, speech, silence }; } return null; }
    if (state === "speaking") { if (now - utteranceStartedAt >= config.maximumUtteranceMs) { state = "finalizing"; return { type: "finalize", reason: "maximum_duration", state, level, speech, silence }; } if (level <= silence) { silenceStartedAt ||= now; if (now - silenceStartedAt >= config.silenceHoldMs) { state = "finalizing"; return { type: "finalize", reason: "silence", state, level, speech, silence }; } } else silenceStartedAt = 0; }
    return null;
  };
  const markPaused = () => { state = "paused"; speechCandidateAt = silenceStartedAt = utteranceStartedAt = 0; return state; };
  const stop = () => (state = "stopped");
  return { start, update, markPaused, stop, getState: () => state, getConfig: () => ({ ...config }), getNoiseFloor: () => noiseFloor };
};
