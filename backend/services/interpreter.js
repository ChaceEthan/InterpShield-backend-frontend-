import { createDeepgramSession } from "./deepgram.js";
import { translateWithGemini } from "./gemini.js";

const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|hmm+|you know|i mean)\b[,\s]*/gi;
const MAX_TRANSCRIPT_HISTORY = 500;
const MAX_STORED_SESSIONS = 100;
const SENTENCE_DEBOUNCE_MS = 1000;
const SILENCE_DEBOUNCE_MS = 1400;
const sessionHistoryStore = new Map();

const createSessionId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const rememberSessionHistory = (sessionId, transcriptHistory) => {
  sessionHistoryStore.set(sessionId, transcriptHistory);

  while (sessionHistoryStore.size > MAX_STORED_SESSIONS) {
    const oldestSessionId = sessionHistoryStore.keys().next().value;
    sessionHistoryStore.delete(oldestSessionId);
  }
};

export const getInterpreterSessionHistory = (sessionId) => {
  const history = sessionHistoryStore.get(sessionId);
  return Array.isArray(history) ? history : [];
};

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
const sentenceEnds = (text = "") => /[.!?]$/.test(text.trim());

const appendSentenceChunk = (sentence = "", chunk = "") => {
  const cleanChunk = cleanTranscriptText(chunk);
  if (!cleanChunk) return sentence;

  const cleanSentence = cleanTranscriptText(sentence);
  if (!cleanSentence) return cleanChunk;

  const normalizedSentence = normalizeTranscript(cleanSentence);
  const normalizedChunk = normalizeTranscript(cleanChunk);

  if (normalizedSentence.endsWith(normalizedChunk)) return cleanSentence;
  if (normalizedChunk.startsWith(normalizedSentence)) return cleanChunk;

  return `${cleanSentence} ${cleanChunk}`.replace(/\s+/g, " ").trim();
};

const resolveDirection = ({ sourceLang, targetLang, detectedLanguage, twoWay }) => {
  void twoWay;
  return { source: detectedLanguage || sourceLang, target: targetLang };
};

export const createInterpreterSession = async ({
  env,
  sourceLang,
  targetLang,
  shouldTranslate,
  twoWay,
  onReady,
  onWarning,
  onError,
  onResult,
  onClosed
}) => {
  let lastFinalTranscript = "";
  let lastInterimTranscript = "";
  let lastTranslatedTranscript = "";
  let currentSentence = "";
  let currentDirection = { source: sourceLang, target: targetLang };
  let currentDetectedLanguage = null;
  let translationTimer = null;
  const sessionId = createSessionId();

  const clearTranslationTimer = () => {
    if (translationTimer) {
      clearTimeout(translationTimer);
      translationTimer = null;
    }
  };

  const emitStableSentence = async () => {
    clearTranslationTimer();

    const sentence = cleanTranscriptText(currentSentence);
    const normalizedSentence = normalizeTranscript(sentence);
    const direction = { ...currentDirection };
    const detectedLanguage = currentDetectedLanguage;
    currentSentence = "";
    lastInterimTranscript = "";

    if (!sentence || sentence.length < 3 || normalizedSentence === lastTranslatedTranscript) {
      return;
    }

    const startedAt = Date.now();
    const translationInput = prepareTextForTranslation(sentence);
    const translatedText = shouldTranslate
      ? await translateWithGemini({
          apiKey: env.geminiApiKey,
          text: translationInput,
          sourceLang: direction.source,
          targetLang: direction.target
        })
      : "";

    if (shouldTranslate && !translatedText) {
      onResult?.({
        originalText: sentence,
        translatedText: "",
        isFinal: true,
        sourceLang: direction.source,
        targetLang: direction.target,
        detectedLanguage,
        latencyMs: Date.now() - startedAt,
        mode: "production"
      });
      return;
    }

    lastTranslatedTranscript = normalizedSentence;

    if (translatedText) {
      const transcriptEntry = {
        original: sentence,
        translated: translatedText,
        timestamp: new Date(),
        sourceLang: direction.source,
        targetLang: direction.target
      };

      session.transcriptHistory.push(transcriptEntry);
      if (session.transcriptHistory.length > MAX_TRANSCRIPT_HISTORY) {
        session.transcriptHistory.splice(0, session.transcriptHistory.length - MAX_TRANSCRIPT_HISTORY);
      }
    }

    onResult?.({
      originalText: sentence,
      translatedText,
      isFinal: true,
      sourceLang: direction.source,
      targetLang: direction.target,
      detectedLanguage,
      latencyMs: Date.now() - startedAt,
      mode: "production"
    });
  };

  const scheduleStableTranslation = () => {
    clearTranslationTimer();
    const delay = sentenceEnds(currentSentence) ? SENTENCE_DEBOUNCE_MS : SILENCE_DEBOUNCE_MS;
    translationTimer = setTimeout(() => {
      void emitStableSentence();
    }, delay);
    translationTimer.unref?.();
  };

  const session = createDeepgramSession({
    apiKey: env.deepgramApiKey,
    sourceLang,
    onOpen: onReady,
    onError: (message) => {
      if (/closed unexpectedly/i.test(message || "")) {
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
        const previewText = appendSentenceChunk(currentSentence, displayText);
        const previewNormalized = normalizeTranscript(previewText);

        if (previewNormalized === lastInterimTranscript || normalized === lastFinalTranscript) {
          return;
        }

        lastInterimTranscript = previewNormalized;
        onResult?.({
          originalText: previewText,
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
      currentDirection = direction;
      currentDetectedLanguage = detectedLanguage;
      currentSentence = appendSentenceChunk(currentSentence, displayText);
      scheduleStableTranslation();
    }
  });

  session.id = sessionId;
  session.sessionId = sessionId;
  session.transcriptHistory = [];
  rememberSessionHistory(sessionId, session.transcriptHistory);
  const stopDeepgramSession = session.stop;
  session.stop = () => {
    clearTranslationTimer();
    stopDeepgramSession?.();
  };

  await session.start();
  return session;
};
