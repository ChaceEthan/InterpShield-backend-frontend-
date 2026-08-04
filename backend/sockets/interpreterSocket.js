// @ts-nocheck
import { verifyToken } from "../services/authService.js";
import { createInterpreterSession, isTranslationDisplayable } from "../services/interpreter.js";
import {
  createAudioPipelineSession,
  removeCallRoomParticipant,
  upsertCallRoomParticipant
} from "../services/audioPipeline.js";
import {
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode as normalizeSharedLanguageCode
} from "../../shared/languages.mjs";

const MAX_TARGET_LANGUAGES = 3;
const LOG_TEXT_PREVIEW_CHARS = 96;
const DISCONNECTED_SESSION_GRACE_MS = 2 * 60 * 1000;
const callRooms = new Map();
const reconnectableSessions = new Map();
const socketRuntime = {
  startedAt: Date.now(),
  connectedSockets: 0,
  totalConnections: 0,
  totalDisconnects: 0,
  totalReconnects: 0,
  totalReconnectFailures: 0,
  totalSessionsStarted: 0,
  totalSessionErrors: 0,
  totalAudioChunks: 0,
  totalAudioDropped: 0,
  totalTranslationEvents: 0,
  lastConnectionAt: null,
  lastDisconnectAt: null,
  lastAudioAt: null,
  lastTranslationAt: null,
  lastError: "",
  activeSessions: new Map(),
  latestAudio: null,
  providers: {}
};

const debugFlagEnabled = (flag) =>
  ["1", "true", "yes", "on"].includes(String(process.env[flag] || process.env.DEBUG || "").trim().toLowerCase());

const logSocketTranslationEvent = (event, payload = {}) => {
  if (process.env.NODE_ENV === "production" && !debugFlagEnabled("SOCKET_DEBUG")) return;

  const safePayload = {};

  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null || value === "") continue;
    safePayload[key] = typeof value === "string" && value.length > LOG_TEXT_PREVIEW_CHARS
      ? `${value.slice(0, LOG_TEXT_PREVIEW_CHARS)}...`
      : value;
  }

  console.info(`[${event}]`, safePayload);
};

const roomHealthSnapshot = () => ({
  activeRooms: callRooms.size,
  rooms: [...callRooms.values()].map((room) => ({
    id: room.id,
    participantCount: room.participants?.size || 0,
    updatedAt: room.updatedAt
  }))
});

export const getInterpreterSocketHealth = () => {
  const sessions = [...socketRuntime.activeSessions.values()].map((session) => ({
    ...session,
    translationHealth: session.getTranslationHealth?.() || session.translationHealth || null,
    getTranslationHealth: undefined
  }));
  const translationQueues = sessions
    .map((session) => session.translationHealth)
    .filter(Boolean);

  return {
    socket: {
      uptimeMs: Date.now() - socketRuntime.startedAt,
      connectedSockets: socketRuntime.connectedSockets,
      totalConnections: socketRuntime.totalConnections,
      totalDisconnects: socketRuntime.totalDisconnects,
      totalReconnects: socketRuntime.totalReconnects,
      totalReconnectFailures: socketRuntime.totalReconnectFailures,
      activeSessions: sessions.length,
      recoveringSessions: [...reconnectableSessions.values()].filter((record) => record.recovering).length,
      totalSessionsStarted: socketRuntime.totalSessionsStarted,
      totalSessionErrors: socketRuntime.totalSessionErrors,
      lastConnectionAt: socketRuntime.lastConnectionAt,
      lastDisconnectAt: socketRuntime.lastDisconnectAt,
      lastError: socketRuntime.lastError
    },
    rooms: roomHealthSnapshot(),
    audio: {
      totalAudioChunks: socketRuntime.totalAudioChunks,
      totalAudioDropped: socketRuntime.totalAudioDropped,
      lastAudioAt: socketRuntime.lastAudioAt,
      latest: socketRuntime.latestAudio,
      sessions: sessions.map((session) => ({
        socketId: session.socketId,
        sessionId: session.sessionId,
        roomId: session.roomId,
        participantId: session.participantId,
        audio: session.audio
      }))
    },
    translation: {
      totalTranslationEvents: socketRuntime.totalTranslationEvents,
      lastTranslationAt: socketRuntime.lastTranslationAt,
      queues: translationQueues,
      activeSessions: sessions.map((session) => ({
        socketId: session.socketId,
        sessionId: session.sessionId,
        sourceLang: session.sourceLang,
        targetLanguages: session.targetLanguages,
        translationHealth: session.translationHealth
      }))
    },
    providers: socketRuntime.providers
  };
};

const normalizeSocketLanguageCode = (language = "") => {
  const normalized = String(language || "").trim().toLowerCase().replace("_", "-");
  if (!normalized) return "";
  if (normalized === "auto") return "auto";
  return normalizeSharedLanguageCode(normalized) || "en";
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

const normalizeClientSessionId = (value = "") =>
  String(value || "")
    .trim()
    .replace(/[^\w:.-]/g, "")
    .slice(0, 160);

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
  const diagnostics = result.diagnostics && typeof result.diagnostics === "object" ? result.diagnostics : null;
  const diagnosticsLanguage = normalizeSocketLanguageCode(diagnostics?.language || result.lang || result.targetLang || targetLanguages[0]);
  const diagnosticsByLanguage = diagnostics && diagnosticsLanguage
    ? { [diagnosticsLanguage]: diagnostics }
    : {};
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
      failedLanguages: Array.isArray(result.failedLanguages) ? result.failedLanguages : [],
      diagnostics,
      diagnosticsByLanguage
    },
    translatedText,
    translations,
    translationOutputs,
    translationStatus: result.translationStatus || {},
      failedLanguages: Array.isArray(result.failedLanguages) ? result.failedLanguages : [],
      diagnostics,
      diagnosticsByLanguage
  };
};

export const registerInterpreterSocket = (io, env, getPublicConfig) => {
  io.on("connection", (socket) => {
    const outputTarget = { socket };
    let session = null;
    let sessionTimer = null;
    let lastSequence = -1;
    let audioPipeline = null;
    let roomMetadata = null;
    let heartbeatTimer = null;
    let disconnectCleanupTimer = null;
    let clientSessionId = normalizeClientSessionId(socket.handshake.auth?.clientSessionId || socket.handshake.auth?.sessionId) || socket.id;
    let authenticatedUserId = "";

    try {
      const token = socket.handshake.auth?.token;
      const authPayload = verifyToken(token, env);
      authenticatedUserId = String(authPayload?.userId || "");
      socket.data.userId = authenticatedUserId;
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

    const clearDisconnectCleanupTimer = () => {
      if (disconnectCleanupTimer) clearTimeout(disconnectCleanupTimer);
      disconnectCleanupTimer = null;
    };

    const getActiveSocket = () => outputTarget.socket || socket;

    const stopSession = (reason = "manual") => {
      clearDisconnectCleanupTimer();
      const activeSocket = getActiveSocket();
      const activeSession = socket.data.interpreterSession || session;
      activeSession?.stop?.();
      audioPipeline?.stop?.();

      if (roomMetadata?.roomId && roomMetadata?.participantId) {
        removeCallRoomParticipant(callRooms, roomMetadata.roomId, roomMetadata.participantId);
        activeSocket.leave(roomMetadata.roomId);
      }

      session = null;
      audioPipeline = null;
      roomMetadata = null;
      activeSocket.data.interpreterSession = null;
      activeSocket.data.deepgramStream = null;
      activeSocket.data.audioPipeline = null;
      activeSocket.data.callRoom = null;
      socket.data.interpreterSession = null;
      socket.data.deepgramStream = null;
      socket.data.audioPipeline = null;
      socket.data.callRoom = null;
      socketRuntime.activeSessions.delete(socket.id);
      socketRuntime.activeSessions.delete(activeSocket.id);
      const reconnectRecord = reconnectableSessions.get(clientSessionId);
      if (reconnectRecord?.socketId === socket.id || reconnectRecord?.socketId === activeSocket.id) {
        if (reconnectRecord.sessionTimer && reconnectRecord.sessionTimer !== sessionTimer) {
          clearTimeout(reconnectRecord.sessionTimer);
        }
        if (reconnectRecord.disconnectTimer && reconnectRecord.disconnectTimer !== disconnectCleanupTimer) {
          clearTimeout(reconnectRecord.disconnectTimer);
        }
        reconnectableSessions.delete(clientSessionId);
      }
      activeSocket.data.sessionClosedReason = reason;
      socket.data.sessionClosedReason = reason;

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

    const sessionConfigSignature = ({
      sourceLang = "en",
      targetLanguages = [],
      shouldTranslate = true,
      twoWay = false,
      roomId = "",
      participantId = ""
    } = {}) =>
      JSON.stringify({
        sourceLang,
        targetLanguages,
        shouldTranslate,
        twoWay,
        roomId,
        participantId
      });

    const startSessionLimitTimer = (startedAt = Date.now()) => {
      if (sessionTimer) clearTimeout(sessionTimer);
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(1000, env.maxSessionSeconds * 1000 - elapsedMs);

      sessionTimer = setTimeout(() => {
        stopSession();
        const activeSocket = getActiveSocket();
        activeSocket.emit("warning", { message: "Session safety limit reached." });
        activeSocket.emit("session:closed");
      }, remainingMs);
      sessionTimer.unref?.();
      return sessionTimer;
    };

    logSocketTranslationEvent("SOCKET_CONNECTED", { socketId: socket.id });
    socketRuntime.connectedSockets += 1;
    socketRuntime.totalConnections += 1;
    socketRuntime.lastConnectionAt = new Date().toISOString();
    socket.emit("server-config", getPublicConfig());
    startHeartbeat();

    const emitInterpreterResult = (result) => {
      const emitTranslationPayload = (payload) => {
        const activeSocket = getActiveSocket();
        logSocketTranslationEvent("SOCKET_TRANSLATION_EMIT", {
          socketId: activeSocket.id,
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
        socketRuntime.totalTranslationEvents += 1;
        socketRuntime.lastTranslationAt = new Date().toISOString();
        const activeHealth = socketRuntime.activeSessions.get(activeSocket.id);
        if (activeHealth) {
          activeHealth.translationHealth = session?.getTranslationHealth?.() || activeHealth.translationHealth;
        }
        activeSocket.emit("translation_update", payload);
        activeSocket.emit("translation_result", payload);
        activeSocket.emit("translated_text", payload);
        const speechRoutes = audioPipeline?.queueTranslatedSpeech?.({
          original: payload.original,
          translations: payload.translations,
          sourceLang: payload.sourceLang,
          targetLanguages: payload.targetLanguages
        });
        if (speechRoutes?.length) {
          activeSocket.data.translatedSpeechRoutes = speechRoutes;
        }
      };

      if (result?.type === "admin_stats") {
        getActiveSocket().emit("result", result);
        return;
      }

      if (!result?.isFinal) {
        const activeSocket = getActiveSocket();
        activeSocket.emit("transcript_partial", {
          text: result.originalText,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          targetLanguages: result.targetLanguages || [result.targetLang],
          detectedLanguage: result.detectedLanguage,
          providerFinal: Boolean(result.providerFinal),
          speechFinal: Boolean(result.speechFinal),
          utteranceEnd: Boolean(result.utteranceEnd),
          speechStarted: Boolean(result.speechStarted)
        });
        activeSocket.emit("result", result);
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
            diagnostics: result.diagnostics || null,
            diagnosticsByLanguage: safe.diagnosticsByLanguage,
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

        getActiveSocket().emit("result", safe.result);
        return;
      }

      const activeSocket = getActiveSocket();
      activeSocket.emit("transcript_final", {
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
        activeSocket.emit("result", result);
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
            diagnostics: result.diagnostics || null,
            diagnosticsByLanguage: safe.diagnosticsByLanguage,
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

      activeSocket.emit("result", safe.result);
    };

    const handleStartSession = async (payload = {}, ack) => {
      const requestedClientSessionId =
        normalizeClientSessionId(payload.clientSessionId || socket.handshake.auth?.clientSessionId || socket.handshake.auth?.sessionId) ||
        clientSessionId ||
        socket.id;
      clientSessionId = requestedClientSessionId;
      socket.data.clientSessionId = clientSessionId;

      const sourceLang = normalizeSocketLanguageCode(payload.sourceLang || "en") || "en";
      const targetLanguages = normalizeTargetLanguages(payload.targetLanguages, payload.targetLang || "es");
      const targetLang = targetLanguages[0];
      const shouldTranslate = payload.translate !== false;
      const twoWay = Boolean(payload.twoWay);
      const roomId = String(payload.roomId || payload.callRoomId || "").trim();
      const participantId = String(payload.participantId || socket.id).trim();
      const configSignature = sessionConfigSignature({
        sourceLang,
        targetLanguages,
        shouldTranslate,
        twoWay,
        roomId,
        participantId
      });
      const existingSessionRecord = reconnectableSessions.get(clientSessionId);
      const canResumeExistingSession =
        existingSessionRecord &&
        existingSessionRecord.socketId !== socket.id &&
        existingSessionRecord.userId === authenticatedUserId &&
        existingSessionRecord.recovering &&
        existingSessionRecord.session &&
        existingSessionRecord.audioPipeline &&
        existingSessionRecord.configSignature === configSignature;

      if (canResumeExistingSession) {
        const oldSocketId = existingSessionRecord.socketId;
        clearTimeout(existingSessionRecord.disconnectTimer);
        if (existingSessionRecord.sessionTimer) clearTimeout(existingSessionRecord.sessionTimer);
        existingSessionRecord.outputTarget.socket = socket;
        outputTarget.socket = socket;
        session = existingSessionRecord.session;
        audioPipeline = existingSessionRecord.audioPipeline;
        roomMetadata = existingSessionRecord.roomMetadata || (roomId
          ? {
              roomId,
              participantId,
              sourceLang,
              targetLanguages
            }
          : null);
        lastSequence = Number.isFinite(existingSessionRecord.lastSequence) ? existingSessionRecord.lastSequence : -1;
        socket.data.interpreterSession = session;
        socket.data.deepgramStream = session;
        socket.data.audioPipeline = audioPipeline.getSnapshot?.() || null;
        socket.data.clientSessionId = clientSessionId;

        let callRoomInfo = null;
        if (roomMetadata?.roomId) {
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

        const resumedSessionTimer = startSessionLimitTimer(existingSessionRecord.startedAt);
        existingSessionRecord.socketId = socket.id;
        existingSessionRecord.recovering = false;
        existingSessionRecord.disconnectTimer = null;
        existingSessionRecord.stopSession = stopSession;
        existingSessionRecord.sessionTimer = resumedSessionTimer;
        existingSessionRecord.roomMetadata = roomMetadata;
        existingSessionRecord.lastSequence = lastSequence;

        socketRuntime.activeSessions.delete(oldSocketId);
        socketRuntime.activeSessions.set(socket.id, {
          socketId: socket.id,
          clientSessionId,
          userId: authenticatedUserId,
          connected: socket.connected,
          recovering: false,
          sessionId: session.sessionId,
          roomId,
          participantId,
          sourceLang,
          targetLanguages,
          startedAt: new Date(existingSessionRecord.startedAt).toISOString(),
          audio: socket.data.audioPipeline,
          translationHealth: session.getTranslationHealth?.() || null,
          getTranslationHealth: session.getTranslationHealth
        });
        socketRuntime.totalReconnects += 1;
        socket.emit("session_ready");
        socket.emit("session:ready");
        ack?.({ ok: true, mode: "production", sessionId: session.sessionId, targetLanguages, room: callRoomInfo, recovered: true });
        logSocketTranslationEvent("SOCKET_SESSION_RESUMED", {
          socketId: socket.id,
          oldSocketId,
          sessionId: session.sessionId,
          sourceLang,
          targetLanguages
        });
        return;
      }

      stopSession("session_restart");
      const replacedSessionRecord = reconnectableSessions.get(clientSessionId);
      if (replacedSessionRecord && replacedSessionRecord.socketId !== socket.id) {
        clearTimeout(replacedSessionRecord.disconnectTimer);
        if (replacedSessionRecord.sessionTimer) clearTimeout(replacedSessionRecord.sessionTimer);
        replacedSessionRecord.stopSession?.("replaced_by_new_session");
      }
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
            const activeSocket = getActiveSocket();
            activeSocket.emit("session_ready");
            activeSocket.emit("session:ready");
          },
          onWarning: (message) => getActiveSocket().emit("warning", { message }),
          onError: (message) => {
            const activeSocket = getActiveSocket();
            logSocketTranslationEvent("SOCKET_PROVIDER_WARNING", { socketId: activeSocket.id, message }, "warn");
            activeSocket.emit("warning", { message });
          },
          onProviderHealth: (health) => {
            socketRuntime.providers = health || {};
            getActiveSocket().emit("provider_health", health);
          },
          onClosed: () => getActiveSocket().emit("warning", { message: "Provider stream closed; reconnecting if session is active." }),
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
        socketRuntime.totalSessionsStarted += 1;
        const startedAt = Date.now();
        const activeSessionTimer = startSessionLimitTimer(startedAt);
        reconnectableSessions.set(clientSessionId, {
          clientSessionId,
          userId: authenticatedUserId,
          socketId: socket.id,
          session,
          sessionId: session.sessionId,
          audioPipeline,
          roomMetadata,
          outputTarget,
          configSignature,
          lastSequence,
          startedAt,
          recovering: false,
          disconnectTimer: null,
          sessionTimer: activeSessionTimer,
          stopSession
        });
        socketRuntime.activeSessions.set(socket.id, {
          socketId: socket.id,
          clientSessionId,
          userId: authenticatedUserId,
          connected: socket.connected,
          recovering: false,
          sessionId: session.sessionId,
          roomId,
          participantId,
          sourceLang,
          targetLanguages,
          startedAt: new Date(startedAt).toISOString(),
          audio: socket.data.audioPipeline,
          translationHealth: session.getTranslationHealth?.() || null,
          getTranslationHealth: session.getTranslationHealth
        });

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
        socketRuntime.totalSessionErrors += 1;
        socketRuntime.lastError = message;
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

        socketRuntime.totalAudioChunks += 1;
        if (!processedAudio.accepted) {
          socketRuntime.totalAudioDropped += 1;
          socket.data.audioPipeline = audioPipeline?.getSnapshot?.() || socket.data.audioPipeline;
          socketRuntime.latestAudio = {
            socketId: socket.id,
            accepted: false,
            reason: processedAudio.reason,
            at: new Date().toISOString(),
            snapshot: socket.data.audioPipeline
          };
          return;
        }

        session.sendAudio(processedAudio.buffer);
        socket.data.audioPipeline = audioPipeline?.getSnapshot?.() || socket.data.audioPipeline;
        socketRuntime.lastAudioAt = new Date().toISOString();
        socketRuntime.latestAudio = {
          socketId: socket.id,
          accepted: true,
          sequence: Number.isFinite(sequence) ? sequence : undefined,
          at: socketRuntime.lastAudioAt,
          snapshot: socket.data.audioPipeline
        };
        const activeHealth = socketRuntime.activeSessions.get(socket.id);
        if (activeHealth) {
          activeHealth.audio = socket.data.audioPipeline;
          activeHealth.translationHealth = session.getTranslationHealth?.() || activeHealth.translationHealth;
        }
      } catch {
        socketRuntime.lastError = "Invalid audio chunk received.";
        socket.emit("warning", { message: "Invalid audio chunk received." });
      }
    };

    const handleEndSession = () => {
      stopSession();
      socket.emit("session:closed");
    };

    const scheduleDisconnectedSessionCleanup = (reason) => {
      if (!session) return;

      const activeHealth = socketRuntime.activeSessions.get(socket.id);
      if (activeHealth) {
        activeHealth.connected = false;
        activeHealth.recovering = true;
        activeHealth.disconnectedAt = new Date().toISOString();
        activeHealth.disconnectReason = reason;
        activeHealth.audio = socket.data.audioPipeline;
        activeHealth.translationHealth = session.getTranslationHealth?.() || activeHealth.translationHealth;
      }

      const reconnectRecord = reconnectableSessions.get(clientSessionId);
      if (!reconnectRecord || reconnectRecord.socketId !== socket.id) {
        stopSession("stale_disconnect");
        return;
      }

      reconnectRecord.recovering = true;
      reconnectRecord.disconnectedAt = Date.now();
      reconnectRecord.disconnectReason = reason;
      reconnectRecord.disconnectTimer = setTimeout(() => {
        const currentRecord = reconnectableSessions.get(clientSessionId);
        if (currentRecord?.socketId !== socket.id) return;
        socketRuntime.totalReconnectFailures += 1;
        stopSession("disconnect_grace_elapsed");
      }, DISCONNECTED_SESSION_GRACE_MS);
      disconnectCleanupTimer = reconnectRecord.disconnectTimer;
      disconnectCleanupTimer.unref?.();
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
    socket.on("audio_utterance_end", () => {
      // This is an idle boundary, not a session stop. Deepgram remains open and
      // owns its reconnect lifecycle; only replay overlap is retired.
      session?.completeUtterance?.();
    });
    socket.on("end_session", handleEndSession);
    socket.on("session:stop", handleEndSession);

    socket.on("disconnect", (reason) => {
      logSocketTranslationEvent("SOCKET_DISCONNECTED", { socketId: socket.id, reason });
      socketRuntime.connectedSockets = Math.max(0, socketRuntime.connectedSockets - 1);
      socketRuntime.totalDisconnects += 1;
      socketRuntime.lastDisconnectAt = new Date().toISOString();
      stopHeartbeat();
      scheduleDisconnectedSessionCleanup(reason);
    });
  });
};
