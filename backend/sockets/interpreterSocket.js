// @ts-nocheck
import { verifyToken } from "../services/authService.js";
import { createInterpreterSession } from "../services/interpreter.js";

const MAX_TARGET_LANGUAGES = 3;

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
    const code = String(language || "").trim();
    if (!code || uniqueLanguages.includes(code)) continue;
    uniqueLanguages.push(code);
    if (uniqueLanguages.length === MAX_TARGET_LANGUAGES) break;
  }

  return uniqueLanguages.length > 0 ? uniqueLanguages : [fallbackTargetLang || "es"];
};

export const registerInterpreterSocket = (io, env, getPublicConfig) => {
  io.on("connection", (socket) => {
    let session = null;
    let sessionTimer = null;
    let lastSequence = -1;

    try {
      const token = socket.handshake.auth?.token;
      verifyToken(token, env);
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

      return "Unable to start interpreter session.";
    };

    socket.emit("server-config", getPublicConfig());

    const emitInterpreterResult = (result) => {
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
        const translations = result.translations || (result.translatedText ? { [result.targetLang]: result.translatedText } : {});

        if (Object.keys(translations).length > 0) {
          socket.emit("translation_update", {
            original: result.originalText,
            text: result.translatedText,
            translations,
            outputs: result.translationOutputs || [],
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

        socket.emit("result", result);
        return;
      }

      socket.emit("transcript_final", {
        text: result.originalText,
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

      const translations = result.translations || (result.translatedText ? { [result.targetLang]: result.translatedText } : {});

      if (Object.keys(translations).length > 0) {
        socket.emit("translation_update", {
          original: result.originalText,
          text: result.translatedText,
          translations,
          outputs: result.translationOutputs || [],
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          targetLanguages: result.targetLanguages || [result.targetLang],
          latencyMs: result.latencyMs,
          provider: result.provider,
          complete: Boolean(result.isTranslationComplete)
        });
      }

      socket.emit("result", result);
    };

    const handleStartSession = async (payload = {}, ack) => {
      stopSession();

      const sourceLang = payload.sourceLang || "en";
      const targetLanguages = normalizeTargetLanguages(payload.targetLanguages, payload.targetLang || "es");
      const targetLang = targetLanguages[0];
      const shouldTranslate = payload.translate !== false;
      const twoWay = Boolean(payload.twoWay);
      lastSequence = -1;

      try {
        if (!env.deepgramApiKey) {
          throw new Error("Missing Deepgram API key");
        }

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
          onError: (message) => socket.emit("session_error", { message }),
          onProviderHealth: (health) => socket.emit("provider_health", health),
          onClosed: () => socket.emit("session:closed"),
          onResult: emitInterpreterResult
        });
        socket.data.interpreterSession = session;
        socket.data.deepgramStream = session;

        sessionTimer = setTimeout(() => {
          stopSession();
          socket.emit("warning", { message: "One hour safety session limit reached." });
          socket.emit("session:closed");
        }, env.maxSessionSeconds * 1000);
        sessionTimer.unref?.();

        ack?.({ ok: true, mode: "production", sessionId: session.sessionId, targetLanguages });
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
