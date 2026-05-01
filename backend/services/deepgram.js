// @ts-nocheck
import { DeepgramClient } from "@deepgram/sdk";

export const createDeepgramSession = ({
  apiKey,
  sourceLang,
  onOpen,
  onTranscript,
  onError,
  onClose
}) => {
  if (!apiKey) {
    throw new Error("Deepgram key is missing");
  }

  let connection = null;
  let isOpen = false;
  let keepAliveTimer = null;

  const start = async () => {
    const deepgram = new DeepgramClient({ apiKey });
    const options = {
      model: "nova-3",
      Authorization: `Token ${apiKey}`,
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
      vad_events: "true"
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
        if (isOpen && connection?.sendKeepAlive) {
          connection.sendKeepAlive({ type: "KeepAlive" });
        }
      }, 8000);
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
      onError?.(error?.message || "Deepgram streaming error");
    });

    connection.on("close", () => {
      isOpen = false;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      onClose?.();
    });

    connection.connect();
    await connection.waitForOpen();
  };

  const sendAudio = (buffer) => {
    if (isOpen && connection?.sendMedia && buffer?.length) {
      connection.sendMedia(buffer);
    }
  };

  const stop = () => {
    isOpen = false;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;

    try {
      connection?.sendCloseStream?.({ type: "CloseStream" });
      connection?.close?.();
    } catch {
      // Ignore close errors. The socket may already be closed by the provider.
    }
  };

  return { start, sendAudio, stop };
};
