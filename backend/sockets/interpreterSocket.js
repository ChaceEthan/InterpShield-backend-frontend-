// @ts-nocheck
import { verifyToken } from "../services/authService.js";
import { createInterpreterSession } from "../services/interpreter.js";

const audioPayloadToBuffer = (audio) => {
  const payload = typeof audio === "string" && audio.includes(",") ? audio.split(",").pop() : audio;
  return Buffer.from(payload || "", "base64");
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

    socket.on("session:start", async (payload = {}, ack) => {
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
          onReady: () => socket.emit("session:ready"),
          onWarning: (message) => socket.emit("warning", { message }),
          onClosed: () => socket.emit("session:closed"),
          onResult: (result) => socket.emit("result", result)
        });

        sessionTimer = setTimeout(() => {
          stopSession();
          socket.emit("warning", { message: "Two minute session limit reached." });
          socket.emit("session:closed");
        }, env.maxSessionSeconds * 1000);

        ack?.({ ok: true, mode: env.deepgramApiKey && env.geminiApiKey ? "production" : "demo" });
      } catch {
        ack?.({ ok: false, error: "Unable to start interpreter session." });
        socket.emit("app-error", { message: "Unable to start interpreter session." });
      }
    });

    socket.on("audio-chunk", (payload = {}) => {
      if (!session) return;

      try {
        const sequence = Number(payload.sequence);
        if (Number.isFinite(sequence) && sequence <= lastSequence) return;
        if (Number.isFinite(sequence)) lastSequence = sequence;

        const audioBuffer = audioPayloadToBuffer(payload.audio);
        if (audioBuffer.length < 64) return;

        session.sendAudio(audioBuffer);
      } catch {
        socket.emit("warning", { message: "Invalid audio chunk received." });
      }
    });

    socket.on("session:stop", () => {
      stopSession();
      socket.emit("session:closed");
    });

    socket.on("disconnect", stopSession);
  });
};
