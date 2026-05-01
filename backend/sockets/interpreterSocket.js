// @ts-nocheck
import { verifyToken } from "../services/authService.js";
import { createInterpreterSession } from "../services/interpreter.js";

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
    console.log("Socket connected");

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
      session?.stop?.();
      session = null;

      if (sessionTimer) {
        clearTimeout(sessionTimer);
        sessionTimer = null;
      }
    };

    socket.emit("server-config", getPublicConfig());

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
          latencyMs: result.latencyMs
        });
      }

      socket.emit("result", result);
    };

    const handleStartSession = async (payload = {}, ack) => {
      stopSession();

      const sourceLang = payload.sourceLang || "en";
      const targetLang = payload.targetLang || "es";
      const shouldTranslate = payload.translate !== false;
      const twoWay = Boolean(payload.twoWay);
      lastSequence = -1;

      try {
        session = await createInterpreterSession({
          env,
          sourceLang,
          targetLang,
          shouldTranslate,
          twoWay,
          onReady: () => {
            socket.emit("session_ready");
            socket.emit("session:ready");
          },
          onWarning: (message) => socket.emit("warning", { message }),
          onError: (message) => socket.emit("session_error", { message }),
          onClosed: () => socket.emit("session:closed"),
          onResult: emitInterpreterResult
        });

        sessionTimer = setTimeout(() => {
          stopSession();
          socket.emit("warning", { message: "Two minute session limit reached." });
          socket.emit("session:closed");
        }, env.maxSessionSeconds * 1000);

        ack?.({ ok: true, mode: env.deepgramApiKey && env.geminiApiKey ? "production" : "demo" });
      } catch (error) {
        console.error("Interpreter session start failed:", error?.message || error);
        ack?.({ ok: false, error: "Unable to start interpreter session." });
        socket.emit("session_error", { message: "Unable to start interpreter session." });
        socket.emit("app-error", { message: "Unable to start interpreter session." });
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
