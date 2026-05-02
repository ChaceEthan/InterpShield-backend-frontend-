import { createDeepgramSession } from "./deepgram.js";
import { translateText } from "./translation.js";

const DEMO_TRANSCRIPTS = ["Hello", "Welcome to InterpShield", "This is a real-time interpreter demo"];
const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|hmm+|you know|i mean)\b[,\s]*/gi;
const TRANSLATION_DEBOUNCE_MS = 160;
const TRANSLATION_MAX_BATCH_CHARS = 420;
const TRANSLATION_MAX_QUEUE_ITEMS = 8;

const cleanTranscriptText = (text = "") => {
  return text
    .replace(FILLER_PATTERN, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?]){2,}/g, "$1")
    .trim();
};

const prepareTextForTranslation = (text = "") => {
  const cleanText = cleanTranscriptText(text);
  if (!cleanText) return "";
  return /[.!?]$/.test(cleanText) ? cleanText : `${cleanText}.`;
};

const normalizeTranscript = (text = "") => cleanTranscriptText(text).toLowerCase();

const resolveDirection = ({ sourceLang, targetLang, detectedLanguage, twoWay }) => {
  if (!twoWay || !detectedLanguage || sourceLang === "auto") {
    return { source: detectedLanguage || sourceLang, target: targetLang };
  }

  if (detectedLanguage === targetLang) {
    return { source: targetLang, target: sourceLang };
  }

  return { source: detectedLanguage || sourceLang, target: targetLang };
};

const createDemoInterpreter = ({ sourceLang, targetLang, shouldTranslate, twoWay, onReady, onWarning, onTranslation, onTranslationStatus, onResult }) => {
  let chunkCount = 0;
  let phraseIndex = 0;

  onReady?.();
  onWarning?.("Deepgram key is missing. Demo mode is enabled.");

  const emitDemoTranslation = ({ originalText, direction }) => {
    if (!shouldTranslate) return;

    onTranslationStatus?.({
      state: "pending",
      sourceLang: direction.source,
      targetLang: direction.target
    });

    onTranslation?.({
      originalText,
      translatedText: originalText,
      isFinal: true,
      sourceLang: direction.source,
      targetLang: direction.target,
      detectedLanguage: direction.source,
      latencyMs: 0,
      provider: "demo",
      stale: true
    });

    onTranslationStatus?.({
      state: "stale",
      provider: "demo",
      sourceLang: direction.source,
      targetLang: direction.target
    });
  };

  return {
    sendAudio: () => {
      chunkCount += 1;

      if (chunkCount === 1) {
        onResult?.({
          originalText: "Hello...",
          translatedText: "",
          isFinal: false,
          sourceLang,
          targetLang,
          mode: "demo"
        });
        return;
      }

      const originalText = DEMO_TRANSCRIPTS[phraseIndex % DEMO_TRANSCRIPTS.length];
      phraseIndex += 1;
      const direction = resolveDirection({ sourceLang, targetLang, detectedLanguage: sourceLang, twoWay });

      onResult?.({
        originalText,
        translatedText: "",
        isFinal: true,
        sourceLang: direction.source,
        targetLang: direction.target,
        latencyMs: 80,
        mode: "demo"
      });
      emitDemoTranslation({ originalText, direction });
    },
    stop: () => undefined
  };
};

export const createInterpreterSession = async ({
  env,
  sourceLang,
  targetLang,
  mimeType,
  shouldTranslate,
  twoWay,
  onReady,
  onWarning,
  onError,
  onTranslation,
  onTranslationStatus,
  onResult,
  onClosed
}) => {
  let lastFinalTranscript = "";
  let lastInterimTranscript = "";
  let lastSuccessfulTranslation = "";
  let translationInFlight = false;
  let translationTimer = null;
  let stopped = false;
  const pendingTranslations = [];

  if (!env.deepgramApiKey) {
    return createDemoInterpreter({ sourceLang, targetLang, shouldTranslate, twoWay, onReady, onWarning, onTranslation, onTranslationStatus, onResult });
  }

  const clearTranslationTimer = () => {
    if (translationTimer) {
      clearTimeout(translationTimer);
      translationTimer = null;
    }
  };

  const emitTranslationStatus = (payload) => {
    if (stopped) return;
    onTranslationStatus?.(payload);
  };

  const isSameTranslationDirection = (a, b) => {
    return a?.sourceLang === b?.sourceLang && a?.targetLang === b?.targetLang;
  };

  const resolveTranslationResult = ({ result, originalText }) => {
    const translatedText = result?.text?.trim() || "";

    if (translatedText && !result?.stale) {
      return {
        translatedText,
        provider: result.provider || "unknown",
        stale: false
      };
    }

    return {
      translatedText: lastSuccessfulTranslation || originalText,
      provider: lastSuccessfulTranslation ? "cache" : "source",
      stale: true
    };
  };

  const scheduleTranslationFlush = (delay = TRANSLATION_DEBOUNCE_MS) => {
    if (stopped || translationInFlight || translationTimer || pendingTranslations.length === 0) {
      return;
    }

    translationTimer = setTimeout(() => {
      translationTimer = null;
      void flushTranslationQueue();
    }, delay);
  };

  const flushTranslationQueue = async () => {
    if (stopped || translationInFlight || pendingTranslations.length === 0) {
      return;
    }

    translationInFlight = true;
    const firstItem = pendingTranslations[0];
    const batch = [];
    let batchChars = 0;

    while (pendingTranslations.length > 0) {
      const nextItem = pendingTranslations[0];
      const nextLength = nextItem.text.length + 1;

      if (batch.length > 0 && (!isSameTranslationDirection(firstItem, nextItem) || batchChars + nextLength > TRANSLATION_MAX_BATCH_CHARS)) {
        break;
      }

      batch.push(pendingTranslations.shift());
      batchChars += nextLength;
    }

    const originalText = batch.map((item) => item.text).join(" ");
    const translationInput = prepareTextForTranslation(originalText);
    const startedAt = Date.now();

    if (!translationInput) {
      translationInFlight = false;
      if (!stopped && pendingTranslations.length > 0) scheduleTranslationFlush(0);
      return;
    }

    emitTranslationStatus({
      state: "pending",
      sourceLang: firstItem.sourceLang,
      targetLang: firstItem.targetLang
    });
    console.log("AI pipeline translation request sent", {
      chars: translationInput.length,
      sourceLang: firstItem.sourceLang,
      targetLang: firstItem.targetLang
    });

    try {
      const result = await translateText({
        text: translationInput,
        sourceLang: firstItem.sourceLang,
        targetLang: firstItem.targetLang
      });

      if (stopped) {
        return;
      }

      const resolvedTranslation = resolveTranslationResult({ result, originalText });

      if (!resolvedTranslation.stale) {
        lastSuccessfulTranslation = resolvedTranslation.translatedText;
      }

      const latencyMs = Date.now() - startedAt;
      console.log("AI pipeline translation response received", {
        chars: resolvedTranslation.translatedText.length,
        provider: resolvedTranslation.provider,
        stale: resolvedTranslation.stale,
        latencyMs
      });

      onTranslation?.({
        originalText,
        translatedText: resolvedTranslation.translatedText,
        isFinal: true,
        sourceLang: firstItem.sourceLang,
        targetLang: firstItem.targetLang,
        detectedLanguage: firstItem.detectedLanguage,
        latencyMs,
        provider: resolvedTranslation.provider,
        stale: resolvedTranslation.stale
      });
      emitTranslationStatus({
        state: resolvedTranslation.stale ? "stale" : "live",
        provider: resolvedTranslation.provider,
        sourceLang: firstItem.sourceLang,
        targetLang: firstItem.targetLang
      });
    } catch (error) {
      console.error("Translation failed:", error?.message || error);

      if (stopped) {
        return;
      }

      console.warn("AI pipeline translation fallback used", {
        provider: lastSuccessfulTranslation ? "cache" : "source",
        sourceLang: firstItem.sourceLang,
        targetLang: firstItem.targetLang
      });

      onTranslation?.({
        originalText,
        translatedText: lastSuccessfulTranslation || originalText,
        isFinal: true,
        sourceLang: firstItem.sourceLang,
        targetLang: firstItem.targetLang,
        detectedLanguage: firstItem.detectedLanguage,
        latencyMs: Date.now() - startedAt,
        provider: lastSuccessfulTranslation ? "cache" : "source",
        stale: true
      });
      emitTranslationStatus({
        state: "stale",
        provider: lastSuccessfulTranslation ? "cache" : "source",
        sourceLang: firstItem.sourceLang,
        targetLang: firstItem.targetLang
      });
    } finally {
      translationInFlight = false;
      if (!stopped && pendingTranslations.length > 0) {
        scheduleTranslationFlush(0);
      }
    }
  };

  const enqueueTranslation = ({ text, direction, detectedLanguage }) => {
    const cleanText = cleanTranscriptText(text);

    if (!cleanText) {
      return;
    }

    const item = {
      text: cleanText,
      sourceLang: direction.source,
      targetLang: direction.target,
      detectedLanguage
    };

    const lastQueued = pendingTranslations.at(-1);
    if (pendingTranslations.length >= TRANSLATION_MAX_QUEUE_ITEMS && isSameTranslationDirection(lastQueued, item)) {
      lastQueued.text = `${lastQueued.text} ${item.text}`.slice(-TRANSLATION_MAX_BATCH_CHARS);
    } else {
      if (pendingTranslations.length >= TRANSLATION_MAX_QUEUE_ITEMS) pendingTranslations.shift();
      pendingTranslations.push(item);
    }

    scheduleTranslationFlush();
  };

  const session = createDeepgramSession({
    sourceLang,
    mimeType,
    onOpen: onReady,
    onError: (message) => {
      if (/reconnecting/i.test(message || "")) {
        onWarning?.(message);
        return;
      }
      onError?.(message || "Deepgram streaming error.");
      onWarning?.("Deepgram streaming failed.");
    },
    onClose: onClosed,
    onTranscript: async ({ text, isFinal, detectedLanguage }) => {
      const direction = resolveDirection({ sourceLang, targetLang, detectedLanguage, twoWay });
      const displayText = cleanTranscriptText(text);
      const normalized = normalizeTranscript(displayText);

      if (!normalized) {
        return;
      }

      if (!isFinal) {
        if (normalized === lastInterimTranscript || normalized === lastFinalTranscript) {
          return;
        }

        lastInterimTranscript = normalized;
        onResult?.({
          originalText: displayText,
          translatedText: "",
          isFinal: false,
          sourceLang: direction.source,
          targetLang: direction.target,
          detectedLanguage
        });
        return;
      }

      if (normalized === lastFinalTranscript) {
        return;
      }
      lastFinalTranscript = normalized;
      lastInterimTranscript = "";

      const startedAt = Date.now();
      console.log("AI pipeline final transcript received", {
        chars: displayText.length,
        sourceLang: direction.source,
        targetLang: direction.target,
        shouldTranslate
      });
      if (shouldTranslate) enqueueTranslation({ text: displayText, direction, detectedLanguage });

      onResult?.({
        originalText: displayText,
        translatedText: "",
        isFinal: true,
        sourceLang: direction.source,
        targetLang: direction.target,
        detectedLanguage,
        latencyMs: Date.now() - startedAt,
        translationPending: shouldTranslate,
        mode: env.geminiApiKey || env.googleTranslateApiKey ? "production" : "demo"
      });
    }
  });

  await session.start();
  return {
    sendAudio: session.sendAudio,
    stop: () => {
      stopped = true;
      clearTranslationTimer();
      pendingTranslations.length = 0;
      session.stop?.();
    }
  };
};
