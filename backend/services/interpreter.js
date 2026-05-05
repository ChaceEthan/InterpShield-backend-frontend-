import { createDeepgramSession } from "./deepgram.js";
import { translateWithGemini } from "./gemini.js";

const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|hmm+|you know|i mean)\b[,\s]*/gi;
const MAX_TRANSCRIPT_HISTORY = 500;
const MAX_STORED_SESSIONS = 100;
const MAX_TARGET_LANGUAGES = 3;
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
  const compactText = text
    .replace(FILLER_PATTERN, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?]){2,}/g, "$1")
    .trim();

  return removeRepeatedFragments(compactText);
};

const normalizeNoiseToken = (word = "") => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

const removeRepeatedFragments = (text = "") => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2) return text;

  const normalizedWords = () => words.map(normalizeNoiseToken);
  let changed = true;

  while (changed) {
    changed = false;
    const normalized = normalizedWords();
    const maxFragmentSize = Math.min(8, Math.floor(words.length / 2));

    for (let fragmentSize = maxFragmentSize; fragmentSize >= 1; fragmentSize -= 1) {
      for (let index = 0; index + fragmentSize * 2 <= words.length; index += 1) {
        const first = normalized.slice(index, index + fragmentSize);
        const second = normalized.slice(index + fragmentSize, index + fragmentSize * 2);

        if (first.some(Boolean) && first.join(" ") === second.join(" ")) {
          words.splice(index + fragmentSize, fragmentSize);
          changed = true;
          break;
        }
      }

      if (changed) break;
    }
  }

  return words.join(" ").trim();
};

const hasMeaningfulTranslationText = (text = "") =>
  text
    .split(/\s+/)
    .map(normalizeNoiseToken)
    .some((word) => word.length >= 3);

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

const resolveDirection = ({ sourceLang, targetLang, targetLanguages, detectedLanguage, twoWay }) => {
  void twoWay;
  const targets = normalizeTargetLanguages(targetLanguages, targetLang);
  return { source: detectedLanguage || sourceLang, target: targets[0], targets };
};

export const createInterpreterSession = async ({
  env,
  sourceLang,
  targetLang,
  targetLanguages,
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
  const sessionTargetLanguages = normalizeTargetLanguages(targetLanguages, targetLang);
  let currentDirection = { source: sourceLang, target: sessionTargetLanguages[0], targets: sessionTargetLanguages };
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

    if (!sentence || !hasMeaningfulTranslationText(sentence) || normalizedSentence === lastTranslatedTranscript) {
      return;
    }

    const startedAt = Date.now();
    const translationInput = prepareTextForTranslation(sentence);
    const translations = {};

    if (shouldTranslate) {
      const translatedEntries = await Promise.all(
        direction.targets.map(async (language) => [
          language,
          await translateWithGemini({
            apiKey: env.geminiApiKey,
            text: translationInput,
            sourceLang: direction.source,
            targetLang: language
          })
        ])
      );

      for (const [language, translatedText] of translatedEntries) {
        if (translatedText) translations[language] = translatedText;
      }
    }

    const translatedText = translations[direction.target] || Object.values(translations).find(Boolean) || "";

    if (shouldTranslate && !translatedText) {
      onResult?.({
        original: sentence,
        originalText: sentence,
        translatedText: "",
        translations: {},
        isFinal: true,
        sourceLang: direction.source,
        targetLang: direction.target,
        targetLanguages: direction.targets,
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
        translations,
        timestamp: new Date(),
        sourceLang: direction.source,
        targetLang: direction.target,
        targetLanguages: direction.targets
      };

      session.transcriptHistory.push(transcriptEntry);
      if (session.transcriptHistory.length > MAX_TRANSCRIPT_HISTORY) {
        session.transcriptHistory.splice(0, session.transcriptHistory.length - MAX_TRANSCRIPT_HISTORY);
      }
    }

    onResult?.({
      original: sentence,
      originalText: sentence,
      translatedText,
      translations,
      isFinal: true,
      sourceLang: direction.source,
      targetLang: direction.target,
      targetLanguages: direction.targets,
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
      const direction = resolveDirection({ sourceLang, targetLang, targetLanguages: sessionTargetLanguages, detectedLanguage, twoWay });
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
          targetLanguages: direction.targets,
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
