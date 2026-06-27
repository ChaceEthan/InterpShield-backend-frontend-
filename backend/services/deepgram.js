// @ts-nocheck
import { DeepgramClient } from "@deepgram/sdk";
import { normalizeLanguageCode } from "../../shared/languages.mjs";

const createClient = (apiKey) => new DeepgramClient({ apiKey });
const MAX_QUEUED_CHUNKS = 2400;
const MAX_RECENT_AUDIO_CHUNKS = 18;
const MAX_RECONNECT_DELAY_MS = 15000;
const DEEPGRAM_KEEPALIVE_MS = 8000;
const DEEPGRAM_HEALTH_CHECK_MS = 5000;
const DEEPGRAM_STALL_MS = 45000;
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
  let healthTimer = null;
  let reconnecting = false;
  let reconnectAttempt = 0;
  let connectionGeneration = 0;
  const queuedAudio = [];
  const recentAudio = [];
  const maxQueuedChunks = MAX_QUEUED_CHUNKS;
  const health = {
    state: "idle",
    isOpen: false,
    reconnecting: false,
    reconnectAttempt: 0,
    reconnects: 0,
    restarts: 0,
    queuedChunks: 0,
    maxQueuedChunks,
    recentChunks: 0,
    sentChunks: 0,
    resentChunks: 0,
    droppedChunks: 0,
    transcripts: 0,
    lastOpenAt: 0,
    lastCloseAt: 0,
    lastTranscriptAt: 0,
    lastMessageAt: 0,
    lastAudioSentAt: 0,
    lastAudioQueuedAt: 0,
    lastKeepAliveAt: 0,
    lastError: "",
    stallDetectedAt: 0
  };

  const updateQueueHealth = () => {
    health.queuedChunks = queuedAudio.length;
    health.recentChunks = recentAudio.length;
    health.isOpen = isOpen && isConnectionOpen(connection);
    health.reconnecting = reconnecting;
    health.reconnectAttempt = reconnectAttempt;
  };

  const clearKeepAlive = () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  };

  const clearHealthTimer = () => {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
  };

  const clearReconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnecting = false;
    updateQueueHealth();
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

  const rememberRecentAudio = (buffer) => {
    if (!buffer?.length) return;
    recentAudio.push(Buffer.from(buffer));
    while (recentAudio.length > MAX_RECENT_AUDIO_CHUNKS) recentAudio.shift();
    updateQueueHealth();
  };

  const enqueueAudio = (buffer, { front = false, resend = false } = {}) => {
    if (!buffer?.length) return;
    const copy = Buffer.from(buffer);
    if (front) queuedAudio.unshift(copy);
    else queuedAudio.push(copy);

    if (resend) health.resentChunks += 1;
    health.lastAudioQueuedAt = Date.now();

    while (queuedAudio.length > maxQueuedChunks) {
      queuedAudio.shift();
      health.droppedChunks += 1;
      health.lastError = "Deepgram audio backlog exceeded protection limit.";
      onError?.("Deepgram audio backlog exceeded protection limit; preserving newest audio.");
    }

    updateQueueHealth();
  };

  const enqueueRecentAudioForResend = () => {
    if (recentAudio.length === 0) return;
    for (let index = recentAudio.length - 1; index >= 0; index -= 1) {
      enqueueAudio(recentAudio[index], { front: true, resend: true });
    }
  };

  const flushQueuedAudio = () => {
    while (isOpen && isConnectionOpen(connection) && queuedAudio.length > 0) {
      const buffer = queuedAudio.shift();
      sendToDeepgram(buffer);
      rememberRecentAudio(buffer);
      health.sentChunks += 1;
      health.lastAudioSentAt = Date.now();
      updateQueueHealth();
    }
  };

  const scheduleReconnect = (reason = "stream_closed") => {
    if (stopped || reconnecting) return;

    reconnecting = true;
    reconnectAttempt += 1;
    health.state = "reconnecting";
    health.reconnects += 1;
    health.lastError = reason;
    updateQueueHealth();
    const delayMs = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(reconnectAttempt - 1, 5));
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
        health.lastError = error?.message || String(error);
        scheduleReconnect(error?.message || "reconnect_failed");
      });
    }, delayMs);
    reconnectTimer.unref?.();
  };

  const restartStream = (reason = "stream_restart") => {
    if (stopped) return;
    health.restarts += 1;
    health.state = "restarting";
    health.lastError = reason;
    enqueueRecentAudioForResend();
    try {
      connection?.close?.();
    } catch {
      // Ignore stale connection close errors during health restart.
    }
    isOpen = false;
    clearKeepAlive();
    scheduleReconnect(reason);
  };

  const startHealthMonitor = () => {
    clearHealthTimer();
    healthTimer = setInterval(() => {
      updateQueueHealth();
      if (stopped || reconnecting || !isOpen || !isConnectionOpen(connection)) return;

      const now = Date.now();
      const lastActivityAt = Math.max(health.lastMessageAt || 0, health.lastTranscriptAt || 0, health.lastOpenAt || 0);
      const audioActive = health.lastAudioSentAt && now - health.lastAudioSentAt < DEEPGRAM_STALL_MS * 2;

      if (audioActive && lastActivityAt && now - lastActivityAt > DEEPGRAM_STALL_MS) {
        health.stallDetectedAt = now;
        restartStream("stream_stalled");
      }
    }, DEEPGRAM_HEALTH_CHECK_MS);
    healthTimer.unref?.();
  };

  const start = async ({ reconnect = false } = {}) => {
    const deepgram = createClient(apiKey);
    stopped = false;
    clearKeepAlive();
    clearHealthTimer();
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

    const generation = connectionGeneration + 1;
    connectionGeneration = generation;
    health.state = reconnect ? "reconnecting" : "connecting";
    updateQueueHealth();
    connection = await deepgram.listen.v1.connect(options);
    const activeConnection = connection;
    const isCurrentConnectionEvent = () => !stopped && generation === connectionGeneration && connection === activeConnection;

    connection.on("open", () => {
      if (!isCurrentConnectionEvent()) return;
      clearReconnect();
      isOpen = true;
      reconnectAttempt = 0;
      reconnecting = false;
      health.state = "open";
      health.lastOpenAt = Date.now();
      health.lastError = "";
      console.info("[DEEPGRAM_OPEN]", { reconnect, queuedAudio: queuedAudio.length });
      keepAliveTimer = setInterval(() => {
        if (isOpen && isConnectionOpen(connection) && connection?.sendKeepAlive) {
          connection.sendKeepAlive();
          health.lastKeepAliveAt = Date.now();
        }
      }, DEEPGRAM_KEEPALIVE_MS);
      startHealthMonitor();
      flushQueuedAudio();
      onOpen?.();
    });

    connection.on("message", (message) => {
      if (!isCurrentConnectionEvent()) return;
      health.lastMessageAt = Date.now();
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
      health.transcripts += 1;
      health.lastTranscriptAt = Date.now();
    });

    connection.on("error", (error) => {
      if (!isCurrentConnectionEvent()) return;
      console.error("Deepgram error:", error);
      health.state = "error";
      health.lastError = error?.message || String(error);
      onError?.(error?.message || "Deepgram streaming error");
      enqueueRecentAudioForResend();
      scheduleReconnect(error?.message || "provider_error");
    });

    connection.on("close", () => {
      if (generation !== connectionGeneration || connection !== activeConnection) return;
      isOpen = false;
      health.state = stopped ? "closed" : "closed_unexpectedly";
      health.lastCloseAt = Date.now();
      clearKeepAlive();
      if (!stopped) {
        enqueueRecentAudioForResend();
        scheduleReconnect("stream_closed");
        return;
      }
      onClose?.();
    });

    connection.connect();
    try {
      await connection.waitForOpen();
    } catch (error) {
      if (!isCurrentConnectionEvent()) return;
      console.warn("[DEEPGRAM_WAIT_FOR_OPEN_FAILED]", {
        reconnect,
        error: error?.message || String(error)
      });
      health.lastError = error?.message || String(error);
      scheduleReconnect(error?.message || "open_timeout");
    }
  };

  const sendAudio = (buffer) => {
    if (!buffer?.length) return;

    if (!isOpen || !isConnectionOpen(connection)) {
      enqueueAudio(buffer);
      return;
    }

    try {
      sendToDeepgram(buffer);
      rememberRecentAudio(buffer);
      health.sentChunks += 1;
      health.lastAudioSentAt = Date.now();
      updateQueueHealth();
    } catch (error) {
      enqueueAudio(buffer, { front: true });
      health.lastError = error?.message || String(error);
      onError?.(error?.message || "Unable to send audio to Deepgram.");
      restartStream("send_failed");
    }
  };

  const stop = () => {
    const wasOpen = isOpen;
    stopped = true;
    connectionGeneration += 1;
    isOpen = false;
    health.state = "stopped";
    clearKeepAlive();
    clearHealthTimer();
    clearReconnect();
    queuedAudio.length = 0;
    recentAudio.length = 0;
    updateQueueHealth();

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

  return {
    start,
    sendAudio,
    stop,
    getHealth: () => ({
      ...health,
      queuedChunks: queuedAudio.length,
      recentChunks: recentAudio.length,
      isOpen: isOpen && isConnectionOpen(connection),
      reconnecting
    })
  };
};
