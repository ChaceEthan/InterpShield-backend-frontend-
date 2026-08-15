export const DEFAULT_VAD_CONFIG = Object.freeze({
  autoFinalize: true,
  calibrationMs: 1000,
  speechThreshold: 0.006,
  silenceThreshold: 0.0035,
  minimumSpeechMs: 220,
  minimumUtteranceMs: 1000,
  speechHangoverMs: 550,
  preSpeechBufferMs: 900,
  postSpeechBufferMs: 700,
  shortPauseGraceMs: 1500,
  hardFinalizeMs: 1750,
  maximumUtteranceMs: 55000,
  transcriptChangeGraceMs: 650,
  noiseFloorMultiplier: 2.4,
  consecutiveSpeechSamples: 0
});

const INCOMPLETE_ENDINGS = new Set([
  "and", "or", "but", "because", "so", "then", "if", "when", "while", "to", "with", "for", "of",
  "kandi", "cyangwa", "ariko", "kuko", "rero", "niba", "igihe", "na", "ko",
  "au", "lakini", "basi", "kama", "wakati", "ili", "sababu",
  "et", "ou", "mais", "donc", "si", "quand", "pour", "avec", "que"
]);
const INCOMPLETE_PHRASES = ["kugira ngo", "kwa sababu", "parce que"];
const COMPLETE_SHORT_PHRASES = new Set([
  "yes", "no", "okay", "ok", "thank you", "i understand", "murakoze", "yego", "oya", "sawa", "merci", "hello", "bye", "ndabyumva"
]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const normalizeText = (text = "") => String(text).trim().replace(/\s+/g, " ");
const meaningfulWords = (text = "") => normalizeText(text).match(/[\p{L}\p{N}']+/gu) || [];

export const analyzeTranscriptCompleteness = (text = "") => {
  const clean = normalizeText(text);
  const normalized = clean.toLocaleLowerCase().replace(/[.!?,;:]+$/u, "").trim();
  const words = meaningfulWords(normalized);
  const lastWord = words.at(-1)?.toLocaleLowerCase() || "";
  const incompleteConnector = INCOMPLETE_ENDINGS.has(lastWord) || INCOMPLETE_PHRASES.some((phrase) => normalized.endsWith(phrase));
  const incompleteLastWord = words.length > 1 && lastWord.length === 1 && !["i", "a", "à", "y"].includes(lastWord);
  return {
    text: clean,
    wordCount: words.length,
    meaningful: words.some((word) => word.length > 1),
    punctuated: /[.!?]$/u.test(clean),
    incomplete: incompleteConnector || incompleteLastWord || /(?:\.\.\.|…)$/u.test(clean),
    completeShortPhrase: COMPLETE_SHORT_PHRASES.has(normalized)
  };
};

export const getDynamicSilenceHoldMs = (text = "", signals = {}) => {
  const analysis = analyzeTranscriptCompleteness(text);
  let hold = analysis.punctuated || analysis.completeShortPhrase ? 1400 : 1550;
  if (analysis.incomplete) hold += 200;
  if (signals.speechFinal || signals.utteranceEnd) hold -= 100;
  return clamp(hold, 1300, 1750);
};

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
  let speechCandidateAt = 0, speechCandidateSamples = 0, utteranceStartedAt = 0, silenceStartedAt = 0, lastSpeechAt = 0;
  let transcript = "", transcriptChangedAt = 0, providerFinal = false, speechFinal = false, utteranceEnd = false;
  const thresholds = () => {
    const speech = clamp(Math.max(config.speechThreshold, noiseFloor * config.noiseFloorMultiplier), config.speechThreshold, 0.12);
    return { speech, silence: clamp(Math.min(speech * 0.68, Math.max(config.silenceThreshold, noiseFloor * 1.35)), config.silenceThreshold, speech * 0.8) };
  };
  const clearUtterance = () => {
    speechCandidateAt = utteranceStartedAt = silenceStartedAt = lastSpeechAt = transcriptChangedAt = 0;
    speechCandidateSamples = 0;
    transcript = "";
    providerFinal = speechFinal = utteranceEnd = false;
  };
  const start = (now = Date.now()) => {
    state = "calibrating";
    startedAt = now;
    calibrationTotal = calibrationSamples = 0;
    clearUtterance();
    return state;
  };
  const noteTranscript = (nextText = "", signals = {}, now = Date.now()) => {
    const clean = normalizeText(nextText);
    if (clean && clean !== transcript) {
      transcript = clean;
      transcriptChangedAt = now;
    }
    providerFinal ||= Boolean(signals.providerFinal);
    speechFinal ||= Boolean(signals.speechFinal);
    utteranceEnd ||= Boolean(signals.utteranceEnd);
    return getDynamicSilenceHoldMs(transcript, { speechFinal, utteranceEnd });
  };
  const update = (rawLevel, now = Date.now(), forceTransmit = false) => {
    const level = Number.isFinite(rawLevel) ? clamp(rawLevel, 0, 1) : 0;
    if (state === "idle" || state === "stopped" || state === "finalizing") return null;
    if (forceTransmit) {
      if (state !== "speaking") {
        state = "speaking";
        utteranceStartedAt ||= now;
        lastSpeechAt = now;
        silenceStartedAt = 0;
        return { type: "speech_started", state, level, ...thresholds() };
      }
      lastSpeechAt = now;
      silenceStartedAt = 0;
      return null;
    }
    if (state === "calibrating") {
      calibrationTotal += level;
      calibrationSamples += 1;
      if (now - startedAt >= config.calibrationMs) {
        noiseFloor = clamp(calibrationTotal / Math.max(1, calibrationSamples), 0.001, 0.04);
        state = "listening";
        return { type: "calibrated", state, level, ...thresholds() };
      }
      return null;
    }
    const { speech, silence } = thresholds();
    if (state === "listening" || state === "paused") {
      noiseFloor = clamp(noiseFloor * 0.985 + Math.min(level, speech) * 0.015, 0.001, 0.04);
      if (level >= speech) {
        if (!speechCandidateAt) {
          speechCandidateAt = now;
          speechCandidateSamples = 1;
          return { type: "speech_candidate", state, level, speech, silence };
        }
        speechCandidateSamples += 1;
        if ((config.consecutiveSpeechSamples > 0 && speechCandidateSamples >= config.consecutiveSpeechSamples) || now - speechCandidateAt >= config.minimumSpeechMs) {
          state = "speaking";
          utteranceStartedAt = speechCandidateAt;
          lastSpeechAt = now;
          silenceStartedAt = 0;
          return { type: "speech_started", state, level, speech, silence };
        }
      } else if (level <= silence && speechCandidateAt) {
        speechCandidateAt = 0;
        speechCandidateSamples = 0;
        return { type: "speech_cancelled", state, level, speech, silence };
      }
      return null;
    }
    if (state === "speaking" || state === "soft-pause") {
      if (now - utteranceStartedAt >= config.maximumUtteranceMs) {
        state = "finalizing";
        return { type: "finalize", reason: "maximum_duration", state, level, speech, silence };
      }
      if (level >= speech) {
        const resumed = state === "soft-pause";
        state = "speaking";
        lastSpeechAt = now;
        silenceStartedAt = 0;
        speechFinal = utteranceEnd = false;
        return resumed ? { type: "speech_resumed", state, level, speech, silence } : null;
      }
      if (level > silence) {
        const resumed = state === "soft-pause";
        lastSpeechAt = now;
        silenceStartedAt = 0;
        if (state === "soft-pause") state = "speaking";
        return resumed ? { type: "speech_resumed", state, level, speech, silence } : null;
      }
      silenceStartedAt ||= now;
      const silenceMs = now - silenceStartedAt;
      if (state === "speaking" && silenceMs >= config.speechHangoverMs) {
        state = "soft-pause";
        return { type: "soft_pause", state, level, speech, silence, silenceMs };
      }
      if (state !== "soft-pause") return null;
      // Capture ownership must not depend on Deepgram partial/final timing.  A
      // partial can arrive after the speaker has stopped; treating it as fresh
      // microphone speech previously reset this clock forever.  Once speech is
      // confirmed, one sustained acoustic silence ends this utterance.
      if (config.autoFinalize && silenceMs >= config.hardFinalizeMs) {
        state = "finalizing";
        return { type: "finalize", reason: "sustained_silence", state, level, speech, silence, silenceMs };
      }
    }
    return null;
  };
  const markPaused = () => {
    state = "paused";
    clearUtterance();
    return state;
  };
  const cancelFinalization = (now = Date.now()) => {
    if (state !== "finalizing") return false;
    state = "speaking";
    lastSpeechAt = now;
    silenceStartedAt = 0;
    speechFinal = utteranceEnd = false;
    return true;
  };
  const stop = () => {
    state = "stopped";
    clearUtterance();
    return state;
  };
  return { start, update, noteTranscript, cancelFinalization, markPaused, stop, getState: () => state, getConfig: () => ({ ...config }), getNoiseFloor: () => noiseFloor };
};
