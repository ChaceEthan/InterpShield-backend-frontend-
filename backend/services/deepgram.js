// @ts-nocheck
import { DeepgramClient } from "@deepgram/sdk";

const createClient = (apiKey) => new DeepgramClient({ apiKey });

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
  const queuedAudio = [];
  const maxQueuedChunks = 8;

  const clearKeepAlive = () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
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

  const start = async () => {
    const deepgram = createClient(apiKey);
    stopped = false;
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

    if (sourceLang === "auto") {
      options.detect_language = "true";
    } else {
      options.language = sourceLang;
    }

    connection = await deepgram.listen.v1.connect(options);

    connection.on("open", () => {
      isOpen = true;
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
    });

    connection.on("close", () => {
      isOpen = false;
      clearKeepAlive();
      if (!stopped) {
        onError?.("Deepgram stream closed unexpectedly.");
        return;
      }
      onClose?.();
    });

    connection.connect();
    await connection.waitForOpen();
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
