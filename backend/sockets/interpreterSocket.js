// @ts-nocheck
import { verifyToken } from "../services/authService.js";
import { createInterpreterSession, isTranslationDisplayable } from "../services/interpreter.js";
import {
  createAudioPipelineSession,
  removeCallRoomParticipant,
  upsertCallRoomParticipant
} from "../services/audioPipeline.js";

const MAX_TARGET_LANGUAGES = 3;
const SUPPORTED_LANGUAGE_CODES = new Set(["en", "fr", "es", "de", "it", "pt", "nl", "ar", "zh", "ja", "ko", "hi", "tr", "pl", "ru", "sw"]);
const FORBIDDEN_LANGUAGE_CODES = new Set(["rw", "rn", "lg", "lug", "luganda", "ug", "lg-ug"]);
const LOG_TEXT_PREVIEW_CHARS = 96;
const callRooms = new Map();

const logSocketTranslationEvent = (event, payload = {}) => {
  if (process.env.NODE_ENV === "production") return;

  const safePayload = {};

  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null || value === "") continue;
    safePayload[key] = typeof value === "string" && value.length > LOG_TEXT_PREVIEW_CHARS
      ? `${value.slice(0, LOG_TEXT_PREVIEW_CHARS)}...`
      : value;
  }

  console.info(`[${event}]`, safePayload);
};

const normalizeSocketLanguageCode = (language = "") => {
  const normalized = String(language || "").trim().toLowerCase().replace("_", "-");
  if (!normalized) return "";
  if (normalized === "auto") return "auto";
  if (FORBIDDEN_LANGUAGE_CODES.has(normalized) || normalized.startsWith("rw") || normalized.startsWith("rn")) return "en";
  if (normalized.startsWith("sw")) return "sw";
  if (normalized.startsWith("zh")) return "zh";
  const code = normalized.split("-")[0] || normalized;
  return SUPPORTED_LANGUAGE_CODES.has(code) ? code : "en";
};

const audioPayloadToBuffer = (audio) => {
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof ArrayBuffer) return Buffer.from(audio);
  if (ArrayBuffer.isView(audio)) return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (audio?.audio) return audioPayloadToBuffer(audio.audio);

  const payload = typeof audio === "string" && audio.includes(",") ? audio.split(",").pop() : audio;
  return Buffer.from(payload || "", "base64");
};

const normalizeTargetLanguages = (targetLanguages, fallbackTargetLang = "es") => {
  const requestedLanguages = Array.isArray(targetLanguages)
    ? targetLanguages
    : targetLanguages
      ? [targetLanguages]
      : [fallbackTargetLang];

  const uniqueLanguages = [];

  for (const language of requestedLanguages) {
    const code = normalizeSocketLanguageCode(language);
    if (!code || code === "auto" || !SUPPORTED_LANGUAGE_CODES.has(code) || uniqueLanguages.includes(code)) continue;
    uniqueLanguages.push(code);
    if (uniqueLanguages.length === MAX_TARGET_LANGUAGES) break;
  }

  if (uniqueLanguages.length > 0) return uniqueLanguages;
  const fallback = normalizeSocketLanguageCode(fallbackTargetLang);
  return fallback && fallback !== "auto" && SUPPORTED_LANGUAGE_CODES.has(fallback) ? [fallback] : ["en"];
};

const sanitizeTranslationResult = (result = {}) => {
  const targetLanguages = normalizeTargetLanguages(result.targetLanguages, result.targetLang || "es");
  const rawTranslations = result.translations && typeof result.translations === "object"
    ? result.translations
    : result.translatedText
      ? { [result.targetLang || targetLanguages[0]]: result.translatedText }
      : {};
  const translations = {};

  for (const [language, value] of Object.entries(rawTranslations)) {
    const safeLanguage = normalizeSocketLanguageCode(language);
    const text = String(value || "").trim();
    if (
      safeLanguage &&
      safeLanguage !== "auto" &&
      SUPPORTED_LANGUAGE_CODES.has(safeLanguage) &&
      isTranslationDisplayable({
        text,
        sourceText: result.originalText || result.original || "",
        sourceLang: result.sourceLang,
        targetLang: safeLanguage,
        provider: result.provider
      })
    ) {
      translations[safeLanguage] = text;
    }
  }

  const translatedText = translations[result.targetLang] || translations[targetLanguages[0]] || Object.values(translations).find(Boolean) || "";
  const translationOutputs = targetLanguages
    .map((language) => {
      const text = translations[language];
      return text ? { lang: language, text } : null;
    })
    .filter(Boolean);

  return {
    result: {
      ...result,
      translatedText,
      translations,
      translationOutputs,
      translationStatus: result.translationStatus || {},
      failedLanguages: Array.isArray(result.failedLanguages) ? result.failedLanguages : []
    },
    translatedText,
    translations,
    translationOutputs,
    translationStatus: result.translationStatus || {},
    failedLanguages: Array.isArray(result.failedLanguages) ? result.failedLanguages : []
  };
};

export const registerInterpreterSocket = (io, env, getPublicConfig) => {
  io.on("connection", (socket) => {
    let session = null;
    let sessionTimer = null;
    let lastSequence = -1;
    let audioPipeline = null;
    let roomMetadata = null;
    let heartbeatTimer = null;

    try {
      const token = socket.handshake.auth?.token;
      verifyToken(token, env);
    } catch {
      socket.emit("session_error", { message: "Authentication required." });
      socket.emit("app-error", { message: "Authentication required." });
      socket.disconnect(true);
      return;
    }

    const stopHeartbeat = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };

    const stopSession = () => {
      const activeSession = socket.data.interpreterSession || session;
      activeSession?.stop?.();
      audioPipeline?.stop?.();

      if (roomMetadata?.roomId && roomMetadata?.participantId) {
        removeCallRoomParticipant(callRooms, roomMetadata.roomId, roomMetadata.participantId);
        socket.leave(roomMetadata.roomId);
      }

      session = null;
      audioPipeline = null;
      roomMetadata = null;
      socket.data.interpreterSession = null;
      socket.data.deepgramStream = null;
      socket.data.audioPipeline = null;
      socket.data.callRoom = null;

      if (sessionTimer) {
        clearTimeout(sessionTimer);
        sessionTimer = null;
      }
    };

    const startHeartbeat = () => {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (!socket.connected) return;
        logSocketTranslationEvent("SOCKET_HEARTBEAT", { socketId: socket.id });
        socket.emit("session:heartbeat", { ts: Date.now(), connected: true });
      }, 25000);
      heartbeatTimer.unref?.();
    };

    const startErrorMessage = (error) => {
      const message = error?.message || "";
      if (/forbidden|unauthorized|401|403/i.test(message)) {
        return "Deepgram rejected the live stream. Check DEEPGRAM_API_KEY on Render.";
      }

      return "Unable to start interpreter session.";
    };

    logSocketTranslationEvent("SOCKET_CONNECTED", { socketId: socket.id });
    socket.emit("server-config", getPublicConfig());
    startHeartbeat();

    const emitInterpreterResult = (result) => {
      const emitTranslationPayload = (payload) => {
        logSocketTranslationEvent("SOCKET_TRANSLATION_EMIT", {
          socketId: socket.id,
          sourceLang: payload.sourceLang,
          targetLanguages: payload.targetLanguages,
          provider: payload.provider,
          partial: payload.partial,
          complete: payload.complete,
          text: payload.text,
          sessionId: payload.sessionId,
          jobId: payload.jobId,
          sequence: payload.sequence,
          lang: payload.lang,
          status: payload.status
        });
        socket.emit("translation_update", payload);
        socket.emit("translation_result", payload);
        socket.emit("translated_text", payload);
        const speechRoutes = audioPipeline?.queueTranslatedSpeech?.({
          original: payload.original,
          translations: payload.translations,
          sourceLang: payload.sourceLang,
          targetLanguages: payload.targetLanguages
        });
        if (speechRoutes?.length) {
          socket.data.translatedSpeechRoutes = speechRoutes;
        }
      };

      if (result?.type === "admin_stats") {
        socket.emit("result", result);
        return;
      }

      if (!result?.isFinal) {
        socket.emit("transcript_partial", {
          text: result.originalText,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          targetLanguages: result.targetLanguages || [result.targetLang],
          detectedLanguage: result.detectedLanguage
        });
        socket.emit("result", result);
        return;
      }

      if (result.isTranslationPartial || result.isTranslationComplete) {
        const safe = sanitizeTranslationResult(result);
        const translations = safe.translations;
        const hasTranslationState = Object.keys(safe.translationStatus || {}).length > 0 || safe.failedLanguages.length > 0;

        if (Object.keys(translations).length > 0 || hasTranslationState) {
          emitTranslationPayload({
            original: result.originalText,
            ...(safe.translatedText ? { text: safe.translatedText } : {}),
            sessionId: result.sessionId,
            jobId: result.jobId,
            timestamp: result.timestamp,
            sequence: result.sequence,
            translations,
            outputs: safe.translationOutputs,
            statusByLanguage: safe.translationStatus,
            failedLanguages: safe.failedLanguages,
            lang: result.lang,
            status: result.status,
            sourceLang: result.sourceLang,
            targetLang: result.targetLang,
            targetLanguages: result.targetLanguages || [result.targetLang],
            latencyMs: result.latencyMs,
            provider: result.provider,
            streaming: Boolean(result.isStreamingPreview),
            partial: Boolean(result.isTranslationPartial),
            complete: Boolean(result.isTranslationComplete)
          });
        }

        socket.emit("result", safe.result);
        return;
      }

      socket.emit("transcript_final", {
        text: result.originalText,
        sessionId: result.sessionId,
        jobId: result.jobId,
        timestamp: result.timestamp,
        sequence: result.sequence,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        targetLanguages: result.targetLanguages || [result.targetLang],
        detectedLanguage: result.detectedLanguage,
        latencyMs: result.latencyMs
      });

      if (result.isTranscriptOnly) {
        socket.emit("result", result);
        return;
      }

      const safe = sanitizeTranslationResult(result);
      const translations = safe.translations;
      const hasTranslationState = Object.keys(safe.translationStatus || {}).length > 0 || safe.failedLanguages.length > 0;

      if (Object.keys(translations).length > 0 || hasTranslationState) {
        emitTranslationPayload({
          original: result.originalText,
          ...(safe.translatedText ? { text: safe.translatedText } : {}),
          sessionId: result.sessionId,
          jobId: result.jobId,
          timestamp: result.timestamp,
          sequence: result.sequence,
          translations,
          outputs: safe.translationOutputs,
          statusByLanguage: safe.translationStatus,
          failedLanguages: safe.failedLanguages,
          lang: result.lang,
          status: result.status,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          targetLanguages: result.targetLanguages || [result.targetLang],
          latencyMs: result.latencyMs,
          provider: result.provider,
          complete: Boolean(result.isTranslationComplete)
        });
      }

      socket.emit("result", safe.result);
    };

    const handleStartSession = async (payload = {}, ack) => {
      stopSession();

      const sourceLang = normalizeSocketLanguageCode(payload.sourceLang || "en") || "en";
      const targetLanguages = normalizeTargetLanguages(payload.targetLanguages, payload.targetLang || "es");
      const targetLang = targetLanguages[0];
      const shouldTranslate = payload.translate !== false;
      const twoWay = Boolean(payload.twoWay);
      const roomId = String(payload.roomId || payload.callRoomId || "").trim();
      const participantId = String(payload.participantId || socket.id).trim();
      lastSequence = -1;

      try {
        if (!env.deepgramApiKey) {
          throw new Error("Missing Deepgram API key");
        }
        let callRoomInfo = null;

        session = await createInterpreterSession({
          env,
          sourceLang,
          userPlan: payload.userPlan || "free",
          preferredProvider: payload.preferredProvider || "auto",
          targetLang,
          targetLanguages,
          shouldTranslate,
          twoWay,
          onReady: () => {
            socket.emit("session_ready");
            socket.emit("session:ready");
          },
          onWarning: (message) => socket.emit("warning", { message }),
          onError: (message) => {
            logSocketTranslationEvent("SOCKET_PROVIDER_WARNING", { socketId: socket.id, message }, "warn");
            socket.emit("warning", { message });
          },
          onProviderHealth: (health) => socket.emit("provider_health", health),
          onClosed: () => socket.emit("warning", { message: "Provider stream closed; reconnecting if session is active." }),
          onResult: emitInterpreterResult
        });
        socket.data.interpreterSession = session;
        socket.data.deepgramStream = session;
        roomMetadata = roomId
          ? {
              roomId,
              participantId,
              sourceLang,
              targetLanguages
            }
          : null;

        if (roomMetadata) {
          socket.join(roomMetadata.roomId);
          const callRoom = upsertCallRoomParticipant(callRooms, {
            roomId: roomMetadata.roomId,
            participantId: roomMetadata.participantId,
            socketId: socket.id,
            sourceLang,
            targetLanguages
          });
          socket.data.callRoom = {
            id: callRoom?.id,
            participantCount: callRoom?.participants?.size || 1
          };
          callRoomInfo = {
            id: callRoom?.id,
            participantId: roomMetadata.participantId,
            participantCount: callRoom?.participants?.size || 1
          };
        }

        audioPipeline = createAudioPipelineSession({
          sessionId: session.sessionId,
          roomId,
          participantId,
          sourceLang,
          targetLanguages,
          mimeType: payload.mimeType || "audio/webm",
          audioProfile: payload.audioProfile || {}
        });
        socket.data.audioPipeline = audioPipeline.getSnapshot();

        sessionTimer = setTimeout(() => {
          stopSession();
          socket.emit("warning", { message: "One hour safety session limit reached." });
          socket.emit("session:closed");
        }, env.maxSessionSeconds * 1000);
        sessionTimer.unref?.();

        ack?.({ ok: true, mode: "production", sessionId: session.sessionId, targetLanguages, room: callRoomInfo });
        logSocketTranslationEvent("SOCKET_SESSION_STARTED", {
          socketId: socket.id,
          sessionId: session.sessionId,
          sourceLang,
          targetLanguages
        });
      } catch (error) {
        console.error("Interpreter session start failed:", error?.message || error);
        const message = startErrorMessage(error);
        ack?.({ ok: false, error: message });
        socket.emit("session_error", { message });
        socket.emit("app-error", { message });
      }
    };

    const handleAudioChunk = (payload = {}) => {
      if (!session) return;

      try {
        const sequence = Number(payload?.sequence);
        if (Number.isFinite(sequence) && sequence <= lastSequence) return;
        if (Number.isFinite(sequence)) lastSequence = sequence;

        const audioBuffer = audioPayloadToBuffer(payload);
        if (audioBuffer.length < 64) return;

        const processedAudio = audioPipeline?.preprocessAudioChunk(audioBuffer, {
          sequence: Number.isFinite(sequence) ? sequence : undefined,
          audioLevel: Number(payload?.audioLevel),
          receivedAt: Number(payload?.capturedAt) || Date.now()
        }) || { accepted: true, buffer: audioBuffer };

        if (!processedAudio.accepted) {
          socket.data.audioPipeline = audioPipeline?.getSnapshot?.() || socket.data.audioPipeline;
          return;
        }

        session.sendAudio(processedAudio.buffer);
        socket.data.audioPipeline = audioPipeline?.getSnapshot?.() || socket.data.audioPipeline;
      } catch {
        socket.emit("warning", { message: "Invalid audio chunk received." });
      }
    };

    const handleEndSession = () => {
      stopSession();
      socket.emit("session:closed");
    };

    socket.on("start_session", handleStartSession);
    socket.on("session:start", handleStartSession);
    socket.on("session:pong", () => {
      socket.data.lastClientPongAt = Date.now();
    });
    socket.on("pong", () => {
      socket.data.lastClientPongAt = Date.now();
    });
    // Handle client-side ping for latency measurement
    socket.on("ping", (data) => {
      socket.emit("pong", { timestamp: data?.timestamp || Date.now() });
    });
    // Handle latency reporting from client
    socket.on("latency", (data) => {
      socket.data.clientLatency = data?.value || 0;
    });
    socket.on("audio_chunk", handleAudioChunk);
    socket.on("audio-chunk", handleAudioChunk);
    socket.on("end_session", handleEndSession);
    socket.on("session:stop", handleEndSession);

    socket.on("disconnect", (reason) => {
      logSocketTranslationEvent("SOCKET_DISCONNECTED", { socketId: socket.id, reason });
      stopHeartbeat();
      stopSession();
    });
  });
};
