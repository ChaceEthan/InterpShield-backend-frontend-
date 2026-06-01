// @ts-nocheck
import { DeepgramClient } from "@deepgram/sdk";
import { normalizeLanguageCode } from "../../shared/languages.mjs";

const createClient = (apiKey) => new DeepgramClient({ apiKey });
const DEEPGRAM_LANGUAGE_ALIASES = {
  lg: "multi",
  luganda: "multi",
  ug: "multi",
  rw: "multi",
  rn: "multi",
  sw: "multi"
};

const normalizeDeepgramLanguage = (sourceLang = "") => {
  const normalized = normalizeLanguageCode(sourceLang) || String(sourceLang || "").trim().toLowerCase().replace("_", "-");
  if (!normalized || normalized === "auto") return { language: "multi" };
  if (DEEPGRAM_LANGUAGE_ALIASES[normalized]) return { language: DEEPGRAM_LANGUAGE_ALIASES[normalized] };
  return { language: normalized };
};

const isConnectionOpen = (connection) => {
  const readyState = connection?.readyState ?? connection?.socket?.readyState;
  return readyState === 1 || readyState === "OPEN";
};

export const createDeepgramSession = ({
  apiKey,
  sourceLang,
  onOpen,
  onTranscript,
  onError,
  onClose
}) => {
  if (!apiKey) {
    throw new Error("Missing Deepgram API key");
  }

  let connection = null;
  let isOpen = false;
  let stopped = false;
  let keepAliveTimer = null;
  let reconnectTimer = null;
  let reconnecting = false;
  let reconnectAttempt = 0;
  const queuedAudio = [];
  const maxQueuedChunks = 160;
  const maxReconnectDelayMs = 15000;

  const clearKeepAlive = () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  };

  const clearReconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnecting = false;
  };

  const sendToDeepgram = (buffer) => {
    if (connection?.sendMedia) {
      connection.sendMedia(buffer);
      return;
    }

    if (connection?.socket?.send) {
      connection.socket.send(buffer);
    }
  };

  const flushQueuedAudio = () => {
    while (isOpen && isConnectionOpen(connection) && queuedAudio.length > 0) {
      sendToDeepgram(queuedAudio.shift());
    }
  };

  const scheduleReconnect = (reason = "stream_closed") => {
    if (stopped || reconnecting) return;

    reconnecting = true;
    reconnectAttempt += 1;
    const delayMs = Math.min(maxReconnectDelayMs, 500 * 2 ** Math.min(reconnectAttempt - 1, 5));
    console.warn("[DEEPGRAM_RECONNECT_SCHEDULED]", {
      reason,
      attempt: reconnectAttempt,
      delayMs,
      queuedAudio: queuedAudio.length
    });
    onError?.(`Deepgram reconnecting (${reason}).`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnecting = false;
      void start({ reconnect: true }).catch((error) => {
        console.error("[DEEPGRAM_RECONNECT_FAILED]", error?.message || error);
        scheduleReconnect(error?.message || "reconnect_failed");
      });
    }, delayMs);
    reconnectTimer.unref?.();
  };

  const start = async ({ reconnect = false } = {}) => {
    const deepgram = createClient(apiKey);
    stopped = false;
    clearKeepAlive();
    const options = {
      model: "nova-3",
      Authorization: `Token ${apiKey}`,
      interim_results: true,
      punctuate: true,
      smart_format: true,
      endpointing: 300,
      utterance_end_ms: 1000,
      vad_events: true,
      reconnectAttempts: 3,
      connectionTimeoutInSeconds: 10
    };

    Object.assign(options, normalizeDeepgramLanguage(sourceLang));

    try {
      connection?.close?.();
    } catch {
      // Ignore stale connection close errors during reconnect.
    }

    connection = await deepgram.listen.v1.connect(options);

    connection.on("open", () => {
      isOpen = true;
      reconnectAttempt = 0;
      reconnecting = false;
      console.info("[DEEPGRAM_OPEN]", { reconnect, queuedAudio: queuedAudio.length });
      keepAliveTimer = setInterval(() => {
        if (isOpen && isConnectionOpen(connection) && connection?.sendKeepAlive) {
          connection.sendKeepAlive();
        }
      }, 8000);
      flushQueuedAudio();
      onOpen?.();
    });

    connection.on("message", (message) => {
      if (message?.type !== "Results") {
        return;
      }

      const alternative = message.channel?.alternatives?.[0];
      const transcript = alternative?.transcript?.trim();

      if (!transcript) {
        return;
      }

      onTranscript?.({
        text: transcript,
        isFinal: Boolean(message.is_final),
        detectedLanguage: message.detected_language || alternative?.languages?.[0]
      });
    });

    connection.on("error", (error) => {
      console.error("Deepgram error:", error);
      onError?.(error?.message || "Deepgram streaming error");
      scheduleReconnect(error?.message || "provider_error");
    });

    connection.on("close", () => {
      isOpen = false;
      clearKeepAlive();
      if (!stopped) {
        scheduleReconnect("stream_closed");
        return;
      }
      onClose?.();
    });

    connection.connect();
    try {
      await connection.waitForOpen();
    } catch (error) {
      console.warn("[DEEPGRAM_WAIT_FOR_OPEN_FAILED]", {
        reconnect,
        error: error?.message || String(error)
      });
      scheduleReconnect(error?.message || "open_timeout");
    }
  };

  const sendAudio = (buffer) => {
    if (!buffer?.length) return;

    if (!isOpen || !isConnectionOpen(connection)) {
      queuedAudio.push(buffer);
      if (queuedAudio.length > maxQueuedChunks) queuedAudio.shift();
      return;
    }

    try {
      sendToDeepgram(buffer);
    } catch (error) {
      queuedAudio.push(buffer);
      if (queuedAudio.length > maxQueuedChunks) queuedAudio.shift();
      onError?.(error?.message || "Unable to send audio to Deepgram.");
    }
  };

  const stop = () => {
    const wasOpen = isOpen;
    stopped = true;
    isOpen = false;
    clearKeepAlive();
    clearReconnect();
    queuedAudio.length = 0;

    try {
      if (wasOpen) connection?.sendCloseStream?.({ type: "CloseStream" });
    } catch {
      // Ignore close errors. The socket may already be closed by the provider.
    }

    try {
      connection?.close?.();
    } catch {
      // Ignore close errors. The socket may already be closed by the provider.
    }
  };

  return { start, sendAudio, stop };
};
