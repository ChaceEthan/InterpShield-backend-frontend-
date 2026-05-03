import { createDeepgramSession } from "./deepgram.js";
import { translateWithGemini } from "./gemini.js";

const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|hmm+|you know|i mean)\b[,\s]*/gi;
const MAX_TRANSCRIPT_HISTORY = 500;
const MAX_STORED_SESSIONS = 100;
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
  const sessionId = createSessionId();

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
      const translationInput = prepareTextForTranslation(displayText);
      const translatedText = shouldTranslate
        ? await translateWithGemini({
            apiKey: env.geminiApiKey,
            text: translationInput,
            sourceLang: direction.source,
            targetLang: direction.target
          })
        : "";
      const transcriptEntry = {
        original: displayText,
        translated: translatedText,
        timestamp: new Date(),
        sourceLang: direction.source,
        targetLang: direction.target
      };

      session.transcriptHistory.push(transcriptEntry);
      if (session.transcriptHistory.length > MAX_TRANSCRIPT_HISTORY) {
        session.transcriptHistory.splice(0, session.transcriptHistory.length - MAX_TRANSCRIPT_HISTORY);
      }

      onResult?.({
        originalText: displayText,
        translatedText,
        isFinal: true,
        sourceLang: direction.source,
        targetLang: direction.target,
        detectedLanguage,
        latencyMs: Date.now() - startedAt,
        mode: "production"
      });
    }
  });

  session.id = sessionId;
  session.sessionId = sessionId;
  session.transcriptHistory = [];
  rememberSessionHistory(sessionId, session.transcriptHistory);

  await session.start();
  return session;
};
