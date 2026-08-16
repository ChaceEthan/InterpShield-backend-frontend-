// @ts-nocheck
import { verifyToken } from "../services/authService.js";
import User from "../models/User.js";
import { isAccountActive } from "../middleware/authorization.js";
import { consumeTrialUsage, EXPIRED_ACCESS_MESSAGE, hasActiveSubscription, isUnlimitedUser, normalizeSubscription, subscriptionSnapshot } from "../services/subscriptionService.js";
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
// Server-authoritative trial metering, keyed by clientSessionId (NOT socket.id) so a single
// meter survives socket reconnects instead of being duplicated or orphaned: the interpreter
// `session`/`audioPipeline` already survive reconnects via reconnectableSessions, and this
// mirrors that same lifecycle rather than living on a per-connection closure variable.
const TRIAL_METER_INTERVAL_MS = 10000;
const trialMeters = new Map();

const chargeTrialMeter = async (meter, { finalCharge = false } = {}) => {
  const now = Date.now();
  const elapsedSeconds = (now - meter.lastChargedAt) / 1000;
  meter.lastChargedAt = now;
  if (elapsedSeconds < 0.5 && !finalCharge) return null;
  try {
    const user = await User.findById(meter.userId);
    if (!user) return null;
    normalizeSubscription(user);
    if (isUnlimitedUser(user) || hasActiveSubscription(user)) return user;
    consumeTrialUsage(user, elapsedSeconds);
    await user.save();
    return user;
  } catch (error) {
    console.error("Trial usage metering failed:", error?.message || error);
    return null;
  }
};

const startTrialMeter = (clientSessionId, userId) => {
  if (!clientSessionId || !userId || trialMeters.has(clientSessionId)) return;
  const meter = { userId, lastChargedAt: Date.now(), timer: null, onExpired: null };
  meter.timer = setInterval(async () => {
    const user = await chargeTrialMeter(meter);
    if (user && !isUnlimitedUser(user) && !hasActiveSubscription(user) && Number(user.trialSecondsRemaining) <= 0) {
      meter.onExpired?.();
    }
  }, TRIAL_METER_INTERVAL_MS);
  meter.timer.unref?.();
  trialMeters.set(clientSessionId, meter);
};

const setTrialMeterExpiryHandler = (clientSessionId, handler) => {
  const meter = trialMeters.get(clientSessionId);
  if (meter) meter.onExpired = handler;
};

const stopTrialMeter = async (clientSessionId) => {
  const meter = trialMeters.get(clientSessionId);
  if (!meter) return;
  trialMeters.delete(clientSessionId);
  clearInterval(meter.timer);
  await chargeTrialMeter(meter, { finalCharge: true });
};
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

// A payload is only worth putting on the wire as translation_update/translation_result/
// translated_text if it carries something the frontend can actually act on: real translated
// text, a per-language status/failure the frontend explicitly understands (e.g. "processing",
// "translated", "failed"), or a top-level status/text. Internal lifecycle bookkeeping that has
// none of that (no translations, no per-language status, no failures, no text, no status) is
// noise, not translation output, and must never reach the socket.
export const hasMeaningfulTranslationPayload = (payload = {}) =>
  Boolean(
    (payload.translations && Object.keys(payload.translations).length > 0) ||
    (payload.statusByLanguage && Object.keys(payload.statusByLanguage).length > 0) ||
    (Array.isArray(payload.failedLanguages) && payload.failedLanguages.length > 0) ||
    payload.text ||
    payload.status
  );

export const registerInterpreterSocket = (io, env, getPublicConfig) => {
  io.on("connection", (socket) => {
    const outputTarget = { socket };
    let session = null;
    let sessionTimer = null;
    let lastSequence = -1;
    let lastAudioStreamGeneration = 0;
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
      void stopTrialMeter(clientSessionId);
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
      mimeType = "",
      roomId = "",
      participantId = ""
    } = {}) =>
      JSON.stringify({
        sourceLang,
        targetLanguages,
        shouldTranslate,
        twoWay,
        mimeType,
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
        if (!hasMeaningfulTranslationPayload(payload)) {
          console.info("[EMPTY_TRANSLATION_PAYLOAD_SUPPRESSED]", { sessionId: payload.sessionId, jobId: payload.jobId, sequence: payload.sequence });
          return;
        }
        const activeSocket = getActiveSocket();
        const translationLanguages = Object.keys(payload.translations || {});
        const statusLanguages = Object.keys(payload.statusByLanguage || {});
        const diagnostic = { sessionId: payload.sessionId, jobId: payload.jobId, sequence: payload.sequence, status: payload.status, languages: translationLanguages.length > 0 ? translationLanguages : statusLanguages, complete: payload.complete };
        console.info("[DESKTOP_PIPELINE_TRANSLATION_RESULT]", diagnostic);
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
        for (const event of ["translation_update", "translation_result", "translated_text"]) {
          console.info("[DESKTOP_PIPELINE_SOCKET_EMIT]", { event, socketId: activeSocket.id, ...diagnostic });
          activeSocket.emit(event, payload);
        }
        console.info("[TRANSLATION_PIPELINE_DIAGNOSTICS]", {
          decision: "translation emitted to socket",
          socketId: activeSocket.id,
          sessionId: payload.sessionId,
          jobId: payload.jobId,
          sequence: payload.sequence,
          events: ["translation_update", "translation_result", "translated_text"]
        });
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
        if (["admin", "super_admin"].includes(socket.data.userRole)) getActiveSocket().emit("result", result);
        return;
      }

      if (!result?.isFinal) {
        const activeSocket = getActiveSocket();
        if (process.env.NODE_ENV !== "production") {
          console.debug("[TRANSCRIPT_PARTIAL_EMITTED]", { chars: String(result.originalText || "").length });
        }
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
        if (result.speechFinal) console.info("[DESKTOP_PIPELINE_SPEECH_FINAL]", { stage: "stt_complete", socketId: activeSocket.id, chars: String(result.originalText || "").length });
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
      console.info("[DESKTOP_PIPELINE_SPEECH_FINAL]", { stage: "transcript_final_emit", socketId: activeSocket.id, sessionId: result.sessionId, jobId: result.jobId, sequence: result.sequence, chars: String(result.originalText || "").length });
      if (result.isTranscriptOnly) {
        console.info("[DESKTOP_PIPELINE_TRANSLATION_START]", { socketId: activeSocket.id, sessionId: result.sessionId, jobId: result.jobId, sequence: result.sequence, targetLanguages: result.targetLanguages || [result.targetLang] });
      }
      if (process.env.NODE_ENV !== "production") {
        console.debug("[TRANSCRIPT_FINAL_EMITTED]", { sequence: result.sequence, jobId: result.jobId, chars: String(result.originalText || "").length });
      }
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
      const authenticatedUser = await User.findById(authenticatedUserId);
      const trialSecondsBeforeNormalize = authenticatedUser?.trialSecondsRemaining;
      normalizeSubscription(authenticatedUser);
      // Persist a legacy 7-day-to-300-second trial migration immediately on first access
      // check, rather than waiting for the first metered usage tick.
      if (authenticatedUser && trialSecondsBeforeNormalize !== authenticatedUser.trialSecondsRemaining) {
        await authenticatedUser.save();
      }
      if (!isAccountActive(authenticatedUser)) {
        const message = subscriptionSnapshot(authenticatedUser).canUseInterpreter
          ? "Your account has been suspended. Contact support."
          : EXPIRED_ACCESS_MESSAGE;
        socket.emit("session_error", { message });
        ack?.(null, { ok: false, error: message });
        return;
      }
      socket.data.userRole = authenticatedUser.role || "user";
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
      const mimeType = String(payload.mimeType || "").trim().toLowerCase();
      if (!["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].includes(mimeType)) {
        const message = "A supported Opus WebM/Ogg microphone format is required.";
        ack?.({ ok: false, error: message });
        socket.emit("session_error", { message });
        return;
      }
      const roomId = String(payload.roomId || payload.callRoomId || "").trim();
      const participantId = String(payload.participantId || socket.id).trim();
      const configSignature = sessionConfigSignature({
        sourceLang,
        targetLanguages,
        shouldTranslate,
        twoWay,
        mimeType,
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
        startTrialMeter(clientSessionId, authenticatedUserId);
        setTrialMeterExpiryHandler(clientSessionId, () => {
          const activeSocket = getActiveSocket();
          activeSocket.emit("session_error", { message: EXPIRED_ACCESS_MESSAGE });
          activeSocket.emit("trial_expired", { message: EXPIRED_ACCESS_MESSAGE });
          stopSession("trial_expired");
        });
        const readyPayload = { sessionId: session.sessionId, recordingGeneration: payload.recordingGeneration };
        socket.emit("session_ready", readyPayload);
        socket.emit("session:ready", readyPayload);
        ack?.({ ok: true, mode: "production", sessionId: session.sessionId, recordingGeneration: payload.recordingGeneration, targetLanguages, room: callRoomInfo, recovered: true });
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
          mimeType,
          userPlan: ["admin", "super_admin"].includes(authenticatedUser.role) ? "team" : authenticatedUser.plan || "free",
          preferredProvider: payload.preferredProvider || "auto",
          targetLang,
          targetLanguages,
          shouldTranslate,
          twoWay,
          onReady: () => {
            const activeSocket = getActiveSocket();
            const readyPayload = { sessionId: session?.sessionId, recordingGeneration: payload.recordingGeneration };
            activeSocket.emit("session_ready", readyPayload);
            activeSocket.emit("session:ready", readyPayload);
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
          onAudioStreamReset: ({ generation }) => getActiveSocket().emit("deepgram_stream_reset", { generation }),
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
          mimeType,
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

        startTrialMeter(clientSessionId, authenticatedUserId);
        setTrialMeterExpiryHandler(clientSessionId, () => {
          const activeSocket = getActiveSocket();
          activeSocket.emit("session_error", { message: EXPIRED_ACCESS_MESSAGE });
          activeSocket.emit("trial_expired", { message: EXPIRED_ACCESS_MESSAGE });
          stopSession("trial_expired");
        });
        ack?.({ ok: true, mode: "production", sessionId: session.sessionId, recordingGeneration: payload.recordingGeneration, targetLanguages, room: callRoomInfo });
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
        const streamGeneration = Number(payload?.streamGeneration);
        if (!Number.isFinite(streamGeneration) || streamGeneration < 1 || streamGeneration < lastAudioStreamGeneration) return;
        if (streamGeneration > lastAudioStreamGeneration) {
          lastAudioStreamGeneration = streamGeneration;
          lastSequence = -1;
        }
        if (Number.isFinite(sequence) && sequence <= lastSequence) return;
        if (Number.isFinite(sequence)) lastSequence = sequence;

        const audioBuffer = audioPayloadToBuffer(payload);
        if (audioBuffer.length < 64) return;
        console.info("[BACKEND_AUDIO_RECEIVED]", { sequence, bytes: audioBuffer.length, sessionId: session.sessionId, streamGeneration });

        const processedAudio = payload.containerHeader
          ? { accepted: true, buffer: audioBuffer }
          : audioPipeline?.preprocessAudioChunk(audioBuffer, {
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
          if (process.env.NODE_ENV !== "production") {
            console.debug("[AUDIO_CHUNK_REJECTED]", { sequence, reason: processedAudio.reason });
          }
          console.info("[AUDIO_CHUNK_DROPPED]", { sequence, bytes: audioBuffer.length, sessionId: session.sessionId, reason: processedAudio.reason, audioLevel: Number(payload?.audioLevel) });
          return;
        }

        session.sendAudio(processedAudio.buffer, {
          streamGeneration,
          containerHeader: Boolean(payload.containerHeader),
          sequence
        });
        console.info("[AUDIO_CHUNK_ACCEPTED]", { sequence, bytes: processedAudio.buffer.length, sessionId: session.sessionId, streamGeneration, audioLevel: Number(payload?.audioLevel) });
        if (process.env.NODE_ENV !== "production" && (sequence === 1 || sequence % 25 === 0)) {
          console.debug("[AUDIO_CHUNK_ACCEPTED]", { sessionId: session.sessionId, sequence, streamGeneration, bytes: processedAudio.buffer.length, mimeType: payload.mimeType, containerHeader: Boolean(payload.containerHeader), signature: processedAudio.buffer.subarray(0, 16).toString("hex") });
        }
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

      void stopTrialMeter(clientSessionId);
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
    socket.on("audio_utterance_end", (payload = {}) => {
      // This is an idle boundary, not a session stop. Deepgram remains open and
      // owns its reconnect lifecycle; only replay overlap is retired.
      if (process.env.NODE_ENV !== "production") {
        console.debug("[UTTERANCE_BOUNDARY_RECEIVED]", { sequence: payload.sequence, finalChunk: payload.finalChunk });
      }
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
