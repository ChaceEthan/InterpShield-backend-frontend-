// @ts-nocheck
import { verifyToken } from "../services/authService.js";
import { createInterpreterSession } from "../services/interpreter.js";
import { saveHistoryItem } from "../services/userService.js";

const audioPayloadToBuffer = (audio) => {
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof ArrayBuffer) return Buffer.from(audio);
  if (ArrayBuffer.isView(audio)) return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (audio?.audio) return audioPayloadToBuffer(audio.audio);

  const payload = typeof audio === "string" && audio.includes(",") ? audio.split(",").pop() : audio;
  return Buffer.from(payload || "", "base64");
};

export const registerInterpreterSocket = (io, env, getPublicConfig) => {
  io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    let session = null;
    let sessionTimer = null;
    let lastSequence = -1;
    let activeShouldTranslate = false;
    let sessionStartedAt = null;
    let userId = "";
    let sessionStarting = false;

    try {
      const token = socket.handshake.auth?.token;
      const payload = verifyToken(token, env);
      userId = payload?.userId || "";
    } catch {
      socket.emit("session_error", { message: "Authentication required." });
      socket.emit("app-error", { message: "Authentication required." });
      socket.disconnect(true);
      return;
    }

    const stopSession = () => {
      const activeSession = socket.data.interpreterSession || session;
      activeSession?.stop?.();
      session = null;
      socket.data.interpreterSession = null;
      socket.data.deepgramStream = null;
      activeShouldTranslate = false;
      sessionStartedAt = null;
      sessionStarting = false;

      if (sessionTimer) {
        clearTimeout(sessionTimer);
        sessionTimer = null;
      }
    };

    const startErrorMessage = (error) => {
      const message = error?.message || "";
      if (/forbidden|unauthorized|401|403/i.test(message)) {
        return "Deepgram rejected the live stream. Check DEEPGRAM_API_KEY on Render.";
      }

      if (/deepgram/i.test(message)) {
        return message.startsWith("Deepgram") ? message : `Deepgram connection failed: ${message}`;
      }

      return message || "Unable to start interpreter session.";
    };

    socket.emit("server-config", getPublicConfig());

    const saveFinalHistory = (payload = {}) => {
      const originalText = payload.originalText?.trim() || "";
      const translatedText = payload.translatedText?.trim() || originalText;

      if (!userId || !originalText) return;

      const durationSeconds = sessionStartedAt ? Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000)) : 0;

      void saveHistoryItem(userId, {
        title: "Live interpreter session",
        sourceLang: payload.sourceLang,
        targetLang: payload.targetLang,
        originalText,
        translatedText,
        durationSeconds
      }, env)
        .then(() => {
          console.log("AI pipeline history saved", {
            socketId: socket.id,
            sourceLang: payload.sourceLang,
            targetLang: payload.targetLang,
            originalChars: originalText.length,
            translatedChars: translatedText.length
          });
        })
        .catch((error) => {
          console.warn("AI pipeline history save skipped:", error?.message || error);
        });
    };

    const emitInterpreterResult = (result) => {
      if (!result?.isFinal) {
        socket.emit("transcript_partial", {
          text: result.originalText,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          detectedLanguage: result.detectedLanguage
        });
        socket.emit("result", result);
        return;
      }

      socket.emit("transcript_final", {
        text: result.originalText,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        detectedLanguage: result.detectedLanguage,
        latencyMs: result.latencyMs
      });

      if (result.translatedText) {
        socket.emit("translation_update", {
          text: result.translatedText,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          latencyMs: result.latencyMs,
          provider: result.provider,
          stale: Boolean(result.stale)
        });
      }

      socket.emit("result", result);

      if (!activeShouldTranslate) {
        saveFinalHistory({
          originalText: result.originalText,
          translatedText: result.translatedText || result.originalText,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang
        });
      }
    };

    const emitTranslationUpdate = (translation) => {
      const text = translation?.translatedText?.trim() || "";
      if (!text) return;

      const payload = {
        text,
        sourceLang: translation.sourceLang,
        targetLang: translation.targetLang,
        detectedLanguage: translation.detectedLanguage,
        latencyMs: translation.latencyMs,
        provider: translation.provider,
        stale: Boolean(translation.stale)
      };

      socket.emit("translation_update", payload);
      socket.emit("result", {
        ...translation,
        translatedText: text,
        translationOnly: true
      });
      saveFinalHistory({
        originalText: translation.originalText,
        translatedText: text,
        sourceLang: translation.sourceLang,
        targetLang: translation.targetLang
      });
    };

    const handleStartSession = async (payload = {}, ack) => {
      stopSession();
      sessionStarting = true;

      const sourceLang = payload.sourceLang || "en";
      const targetLang = payload.targetLang || "es";
      const shouldTranslate = payload.translate !== false;
      const twoWay = Boolean(payload.twoWay);
      const mimeType = payload.mimeType || "audio/webm";
      activeShouldTranslate = shouldTranslate;
      sessionStartedAt = Date.now();
      lastSequence = -1;
      console.log("Interpreter session starts", { socketId: socket.id, sourceLang, targetLang, shouldTranslate, twoWay, mimeType });

      try {
        session = await createInterpreterSession({
          env,
          sourceLang,
          targetLang,
          mimeType,
          shouldTranslate,
          twoWay,
          onReady: () => {
            socket.emit("session_ready");
            socket.emit("session:ready");
          },
          onWarning: (message) => socket.emit("warning", { message }),
          onError: (message) => socket.emit("session_error", { message }),
          onClosed: () => socket.emit("session:closed"),
          onTranslation: emitTranslationUpdate,
          onTranslationStatus: (payload) => socket.emit("translation_status", payload),
          onResult: emitInterpreterResult
        });
        socket.data.interpreterSession = session;
        socket.data.deepgramStream = session;
        sessionStarting = false;

        sessionTimer = setTimeout(() => {
          stopSession();
          socket.emit("warning", { message: "Two minute session limit reached." });
          socket.emit("session:closed");
        }, env.maxSessionSeconds * 1000);

        ack?.({ success: true, ok: true, mode: env.deepgramApiKey && env.geminiApiKey ? "production" : "demo" });
      } catch (error) {
        console.error("Interpreter session start failed:", error?.message || error);
        sessionStarting = false;
        const message = startErrorMessage(error);
        stopSession();
        ack?.({ success: false, ok: false, error: message });
        socket.emit("session_error", { message });
        socket.emit("app-error", { message });
      }
    };

    const handleAudioChunk = (payload = {}) => {
      if (!session) {
        if (!sessionStarting) socket.emit("warning", { message: "Audio received before interpreter session was ready." });
        return;
      }

      try {
        const sequence = Number(payload?.sequence);
        if (Number.isFinite(sequence) && sequence <= lastSequence) return;
        if (Number.isFinite(sequence)) lastSequence = sequence;

        const audioBuffer = audioPayloadToBuffer(payload);
        if (audioBuffer.length < 64) return;

        session.sendAudio(audioBuffer);
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
    socket.on("audio_chunk", handleAudioChunk);
    socket.on("audio-chunk", handleAudioChunk);
    socket.on("end_session", handleEndSession);
    socket.on("session:stop", handleEndSession);

    socket.on("disconnect", stopSession);
  });
};
