import { createDeepgramSession } from "./deepgram.js";
import { translateWithGemini } from "./gemini.js";
import { detectRegionAccent, normalizeMixedSpeech } from "../utils/translationEnhancer.js";

const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|hmm+|you know|i mean)\b[,\s]*/gi;
const MAX_TRANSCRIPT_HISTORY = 500;
const MAX_STORED_SESSIONS = 100;
const MAX_TARGET_LANGUAGES = 3;
const SENTENCE_DEBOUNCE_MS = 1000;
const SILENCE_DEBOUNCE_MS = 1400;
const TRANSLATION_RATE_LIMIT_DELAY_MS = 300;
const MAX_CONSECUTIVE_TRANSLATION_FAILURES = 3;
const MAX_STYLE_MEMORY_ENTRIES = 20;
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EMOTION_MARKERS = {
  happy: ["happy", "glad", "great", "good news", "thank", "thanks", "appreciate", "wonderful"],
  angry: ["angry", "upset", "mad", "stop", "unacceptable", "never again", "terrible", "frustrated"],
  sad: ["sad", "sorry", "miss", "lost", "hurt", "worried", "afraid", "unfortunately"],
  excited: ["wow", "amazing", "excellent", "can't wait", "cannot wait", "finally", "fantastic"],
  professional: ["meeting", "client", "deadline", "invoice", "project", "proposal", "contract", "business", "kindly", "please confirm"]
};

const EMOTION_PROFILES = {
  happy: "Keep the translation warm, friendly, and naturally positive.",
  angry: "Keep the urgency and firmness, but avoid adding insults or extra aggression.",
  sad: "Use a gentle, empathetic tone without exaggerating the emotion.",
  excited: "Keep the translation energetic and lively while staying natural.",
  professional: "Use polished, concise business language with a respectful tone.",
  neutral: "Keep the tone natural and faithful to the speaker."
};

const normalizeProfileText = (text = "") =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const countMarkerMatches = (normalizedText, markers) =>
  markers.reduce((count, marker) => count + (normalizedText.includes(normalizeProfileText(marker)) ? 1 : 0), 0);

const detectEmotionProfile = (text = "") => {
  const normalizedText = normalizeProfileText(text);
  const scores = Object.fromEntries(
    Object.entries(EMOTION_MARKERS).map(([tone, markers]) => [tone, countMarkerMatches(normalizedText, markers)])
  );

  if ((text.match(/!/g) || []).length >= 2) scores.excited += 2;
  if (/[A-Z]{4,}/.test(text)) scores.angry += 1;

  const [tone, score] = Object.entries(scores).sort(([, leftScore], [, rightScore]) => rightScore - leftScore)[0];
  const resolvedTone = score > 0 ? tone : "neutral";

  return {
    tone: resolvedTone,
    instruction: EMOTION_PROFILES[resolvedTone] || EMOTION_PROFILES.neutral,
    confidence: Math.min(1, Number((score / 4).toFixed(2)))
  };
};

const buildTranslationContext = ({ sentence, direction, detectedLanguage }) => {
  const accentProfile = detectRegionAccent({
    text: sentence,
    sourceLang: detectedLanguage || direction.source,
    targetLang: direction.target,
    targetLanguages: direction.targets
  });
  const emotionProfile = detectEmotionProfile(sentence);
  const mixedSpeech = normalizeMixedSpeech(sentence);

  return {
    accentProfile,
    emotionProfile,
    mixedSpeech,
    confidence: Number((((accentProfile.confidence || 0) + (emotionProfile.confidence || 0)) / 2).toFixed(2))
  };
};

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
  let consecutiveTranslationFailures = 0;
  const lastSuccessfulTranslations = new Map();
  const styleMemoryByLanguage = new Map();
  const sessionId = createSessionId();

  const clearTranslationTimer = () => {
    if (translationTimer) {
      clearTimeout(translationTimer);
      translationTimer = null;
    }
  };

  const resetTranslationState = () => {
    clearTranslationTimer();
    currentSentence = "";
    lastInterimTranscript = "";
    lastTranslatedTranscript = "";
    consecutiveTranslationFailures = 0;
  };

  const noteTranslationSuccess = (language, translatedText, translationContext) => {
    consecutiveTranslationFailures = 0;
    lastSuccessfulTranslations.set(language, translatedText);
    const previousMemory = styleMemoryByLanguage.get(language) || {};
    const recentTranslations = [...(previousMemory.recentTranslations || []), translatedText.slice(0, 180)].slice(-MAX_STYLE_MEMORY_ENTRIES);

    styleMemoryByLanguage.set(language, {
      lastTranslation: translatedText.slice(0, 220),
      recentTranslations,
      tone: translationContext?.emotionProfile?.tone || "neutral",
      region: translationContext?.accentProfile?.region || "General",
      mode: translationContext?.accentProfile?.mode || "neutral mode",
      confidence: translationContext?.confidence || 0
    });
  };

  const noteTranslationFailure = (language, error) => {
    consecutiveTranslationFailures += 1;
    console.warn("Translation failure", {
      targetLang: language,
      failures: consecutiveTranslationFailures,
      error: error?.message || error || "No valid translation returned"
    });

    if (consecutiveTranslationFailures >= MAX_CONSECUTIVE_TRANSLATION_FAILURES) {
      console.warn("Translation state reset after repeated failures", {
        failures: consecutiveTranslationFailures
      });
      resetTranslationState();
    }
  };

  const translateLanguageWithRecovery = async ({ language, translationInput, direction, translationContext }) => {
    let lastError = null;
    const languageTranslationContext = {
      ...translationContext,
      styleMemory: styleMemoryByLanguage.get(language) || null
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        console.log("Retrying Gemini translation", { targetLang: language, attempt: attempt + 1 });
        await delay(TRANSLATION_RATE_LIMIT_DELAY_MS);
      }

      const attemptStartedAt = Date.now();

      try {
        const translatedText = await translateWithGemini({
          apiKey: env.geminiApiKey,
          text: translationInput,
          sourceLang: direction.source,
          targetLang: language,
          translationContext: languageTranslationContext
        });
        const responseTimeMs = Date.now() - attemptStartedAt;
        const safeTranslatedText = String(translatedText || "").trim();

        console.log("Gemini translation response", {
          targetLang: language,
          attempt: attempt + 1,
          responseTimeMs,
          empty: !safeTranslatedText,
          region: languageTranslationContext.accentProfile?.region,
          tone: languageTranslationContext.emotionProfile?.tone,
          confidence: languageTranslationContext.confidence
        });

        if (safeTranslatedText) {
          noteTranslationSuccess(language, safeTranslatedText, languageTranslationContext);
          return safeTranslatedText;
        }

        lastError = new Error("Empty translation response");
      } catch (error) {
        lastError = error;
        console.warn("Gemini translation attempt failed", {
          targetLang: language,
          attempt: attempt + 1,
          responseTimeMs: Date.now() - attemptStartedAt,
          error: error?.message || error
        });
      }
    }

    noteTranslationFailure(language, lastError);

    const fallbackTranslation = String(lastSuccessfulTranslations.get(language) || "").trim();
    if (fallbackTranslation) {
      const fallbackStyle = styleMemoryByLanguage.get(language);
      console.warn("Using previous successful translation fallback", {
        targetLang: language,
        tone: fallbackStyle?.tone,
        region: fallbackStyle?.region
      });
    }

    return fallbackTranslation;
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
    const translationOutputs = [];
    const translationContext = buildTranslationContext({ sentence, direction, detectedLanguage });

    if (shouldTranslate) {
      const targetQueue = direction.targets.slice(0, MAX_TARGET_LANGUAGES);

      for (const language of targetQueue) {
        if (translationOutputs.length > 0) {
          await delay(TRANSLATION_RATE_LIMIT_DELAY_MS);
        }

        const translatedText = await translateLanguageWithRecovery({ language, translationInput, direction, translationContext });
        const safeTranslatedText = String(translatedText || "").trim();
        translationOutputs.push({ lang: language, text: safeTranslatedText });

        if (safeTranslatedText) {
          translations[language] = safeTranslatedText;
        }
      }
    }

    const translatedText = translations[direction.target] || Object.values(translations).find(Boolean) || "";

    if (shouldTranslate && !translatedText) {
      onResult?.({
        original: sentence,
        originalText: sentence,
        translatedText: "",
        translations: {},
        translationOutputs,
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
      translationOutputs,
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
      void emitStableSentence().catch((error) => {
        console.error("Translation processing failed:", error?.message || error);
        resetTranslationState();
        onWarning?.("Translation temporarily failed; continuing session.");
      });
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
