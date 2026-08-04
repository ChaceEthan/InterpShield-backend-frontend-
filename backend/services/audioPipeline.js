// @ts-nocheck
import {
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode
} from "../../shared/languages.mjs";

const MIN_AUDIO_CHUNK_BYTES = 48;
const DUPLICATE_HASH_WINDOW = 24;
const MIN_CHUNK_INTERVAL_MS = 20;
const LOW_AUDIO_LEVEL = 0.0008;
const MAX_TRANSLATED_SPEECH_QUEUE = 24;
const TRANSLATED_SPEECH_TTL_MS = 45000;
const audioDebugEnabled = () =>
  ["1", "true", "yes", "on"].includes(String(process.env.AUDIO_DEBUG || process.env.DEBUG || "").trim().toLowerCase());

const logAudioDebug = (event, payload = {}) => {
  if (!audioDebugEnabled()) return;
  console.info(`[${event}]`, payload);
};

const normalizeLanguage = (language = "") => {
  const normalized = String(language || "").trim().toLowerCase().replace("_", "-");
  if (!normalized) return "";
  const code = normalizeLanguageCode(normalized);
  return SUPPORTED_LANGUAGE_CODES.has(code) ? code : "en";
};

const hashBufferSample = (buffer) => {
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(buffer.length / 64));

  for (let index = 0; index < buffer.length; index += step) {
    hash ^= buffer[index];
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
};

const estimateSilenceConfidence = ({ buffer, audioLevel }) => {
  if (Number.isFinite(audioLevel)) {
    return Math.max(0, Math.min(1, 1 - audioLevel / 0.08));
  }

  if (!buffer?.length) return 1;

  let zeroBytes = 0;
  let repeatedBytes = 0;
  let previousByte = buffer[0];
  const step = Math.max(1, Math.floor(buffer.length / 96));

  for (let index = 0; index < buffer.length; index += step) {
    const byte = buffer[index];
    if (byte === 0) zeroBytes += 1;
    if (byte === previousByte) repeatedBytes += 1;
    previousByte = byte;
  }

  const samples = Math.ceil(buffer.length / step);
  return Math.min(1, Math.max(zeroBytes / samples, repeatedBytes / samples - 0.18));
};

const compactSpeechQueue = (queue) => {
  const now = Date.now();
  const seen = new Set();

  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index];
    const key = `${item.targetLang}:${item.text}`;
    if (now - item.createdAt > TRANSLATED_SPEECH_TTL_MS || seen.has(key)) {
      queue.splice(index, 1);
      continue;
    }
    seen.add(key);
  }

  while (queue.length > MAX_TRANSLATED_SPEECH_QUEUE) queue.shift();
};

export const createAudioPipelineSession = ({
  sessionId = "",
  roomId = "",
  participantId = "",
  sourceLang = "en",
  targetLanguages = [],
  mimeType = "audio/webm",
  audioProfile = {}
} = {}) => {
  let lastAcceptedAt = 0;
  let lastHash = "";
  let duplicateHashCount = 0;
  let consecutiveSilentChunks = 0;
  let acceptedChunks = 0;
  let droppedChunks = 0;
  const translatedSpeechQueue = [];

  const metadata = {
    sessionId,
    roomId,
    participantId,
    sourceLang: normalizeLanguage(sourceLang) || "en",
    targetLanguages: targetLanguages.map(normalizeLanguage).filter(Boolean),
    mimeType,
    audioProfile
  };

  const preprocessAudioChunk = (buffer, { sequence, audioLevel, receivedAt = Date.now() } = {}) => {
    if (!buffer?.length || buffer.length < MIN_AUDIO_CHUNK_BYTES) {
      droppedChunks += 1;
      logAudioDebug("AUDIO_CHUNK_DROPPED", { sessionId, reason: "too_small", bytes: buffer?.length || 0, droppedChunks });
      return { accepted: false, reason: "too_small", silenceConfidence: 1 };
    }

    const chunkHash = hashBufferSample(buffer);
    if (chunkHash === lastHash) duplicateHashCount += 1;
    else duplicateHashCount = 0;
    lastHash = chunkHash;

    const silenceConfidence = estimateSilenceConfidence({ buffer, audioLevel });
    const tooFast = lastAcceptedAt && receivedAt - lastAcceptedAt < MIN_CHUNK_INTERVAL_MS;
    const likelySilentMicroChunk =
      Number.isFinite(audioLevel) &&
      audioLevel < LOW_AUDIO_LEVEL &&
      buffer.length < MIN_AUDIO_CHUNK_BYTES &&
      silenceConfidence > 0.995;
    const duplicateSpam = duplicateHashCount >= DUPLICATE_HASH_WINDOW && silenceConfidence > 0.995;
    const sustainedSilence = Number.isFinite(audioLevel) && audioLevel < 0.008 && silenceConfidence > 0.88;
    consecutiveSilentChunks = sustainedSilence ? consecutiveSilentChunks + 1 : 0;
    const silentRun = consecutiveSilentChunks > 2;

    if ((tooFast && likelySilentMicroChunk) || duplicateSpam || silentRun) {
      droppedChunks += 1;
      logAudioDebug("AUDIO_CHUNK_DROPPED", {
        sessionId,
        reason: duplicateSpam ? "duplicate_chunk" : silentRun ? "sustained_silence" : "silent_micro_chunk",
        bytes: buffer.length,
        audioLevel,
        droppedChunks
      });
      return {
        accepted: false,
        reason: duplicateSpam ? "duplicate_chunk" : silentRun ? "sustained_silence" : "silent_micro_chunk",
        silenceConfidence
      };
    }

    acceptedChunks += 1;
    lastAcceptedAt = receivedAt;
    if (acceptedChunks === 1 || acceptedChunks % 25 === 0) {
      logAudioDebug("AUDIO_CHUNK_ACCEPTED", {
        sessionId,
        sequence,
        bytes: buffer.length,
        audioLevel,
        acceptedChunks,
        droppedChunks
      });
    }

    return {
      accepted: true,
      buffer,
      metadata: {
        sequence,
        audioLevel: Number.isFinite(audioLevel) ? Number(audioLevel.toFixed(4)) : undefined,
        silenceConfidence: Number(silenceConfidence.toFixed(3)),
        acceptedChunks,
        droppedChunks
      }
    };
  };

  const queueTranslatedSpeech = ({ original = "", translations = {}, sourceLang: resultSourceLang, targetLanguages: resultTargets = [] } = {}) => {
    const targets = (Array.isArray(resultTargets) && resultTargets.length > 0 ? resultTargets : metadata.targetLanguages)
      .map(normalizeLanguage)
      .filter(Boolean);
    const routes = [];

    compactSpeechQueue(translatedSpeechQueue);

    for (const targetLang of targets) {
      const text = String(translations?.[targetLang] || "").trim();
      if (!text) continue;

      const route = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        roomId: metadata.roomId,
        fromParticipantId: metadata.participantId,
        sourceLang: normalizeLanguage(resultSourceLang) || metadata.sourceLang,
        targetLang,
        original,
        text,
        status: "queued",
        provider: "future-tts",
        voiceCloneProfileId: null,
        createdAt: Date.now()
      };

      translatedSpeechQueue.push(route);
      routes.push(route);
    }

    compactSpeechQueue(translatedSpeechQueue);
    return routes;
  };

  return {
    metadata,
    preprocessAudioChunk,
    queueTranslatedSpeech,
    getSnapshot: () => ({
      ...metadata,
      acceptedChunks,
      droppedChunks,
      translatedSpeechQueued: translatedSpeechQueue.length
    }),
    stop: () => {
      translatedSpeechQueue.length = 0;
    }
  };
};

export const upsertCallRoomParticipant = (rooms, {
  roomId = "",
  participantId = "",
  socketId = "",
  sourceLang = "en",
  targetLanguages = []
} = {}) => {
  const id = String(roomId || "").trim();
  if (!id) return null;

  if (!rooms.has(id)) {
    rooms.set(id, {
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      participants: new Map(),
      languagePreferences: new Map(),
      translatedAudioRoutes: []
    });
  }

  const room = rooms.get(id);
  const participant = {
    id: String(participantId || socketId || "").trim(),
    socketId,
    sourceLang: normalizeLanguage(sourceLang) || "en",
    targetLanguages: targetLanguages.map(normalizeLanguage).filter(Boolean),
    joinedAt: room.participants.get(participantId)?.joinedAt || Date.now(),
    updatedAt: Date.now()
  };

  room.participants.set(participant.id, participant);
  room.languagePreferences.set(participant.id, {
    sourceLang: participant.sourceLang,
    targetLanguages: participant.targetLanguages
  });
  room.updatedAt = Date.now();

  return room;
};

export const removeCallRoomParticipant = (rooms, roomId = "", participantId = "") => {
  const room = rooms.get(roomId);
  if (!room) return;

  room.participants.delete(participantId);
  room.languagePreferences.delete(participantId);
  room.updatedAt = Date.now();

  if (room.participants.size === 0) rooms.delete(roomId);
};
