// @ts-nocheck
import { createDeepgramSession } from "./deepgram.js";
import { translateWithGemini } from "./gemini.js";
import { translateWithOpenAI } from "./openai.js";
import { detectRegionAccent, normalizeMixedSpeech, resolveLocalTranslation } from "../utils/translationEnhancer.js";

const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|hmm+|you know|i mean)\b[,\s]*/gi;
const MAX_TRANSCRIPT_HISTORY = 500;
const MAX_STORED_SESSIONS = 100;
const MAX_TARGET_LANGUAGES = 3;
const SENTENCE_DEBOUNCE_MS = 520;
const SHORT_PAUSE_DEBOUNCE_MS = 760;
const SILENCE_DEBOUNCE_MS = 940;
const TRANSLATION_RATE_LIMIT_DELAY_MS = 180;
const MAX_CONSECUTIVE_TRANSLATION_FAILURES = 3;
const MAX_STYLE_MEMORY_ENTRIES = 20;
const MAX_TRANSLATION_CACHE_ENTRIES = 180;
const TRANSLATION_ATTEMPT_TIMEOUT_MS = 8500;
const TRANSLATION_JOB_TIMEOUT_MS = 16000;
const PROVIDER_FAILURE_THRESHOLD = 2;
const PROVIDER_COOLDOWN_MS = 30000;
const SESSION_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_HEALTH_CHECK_MS = 2500;
const MAX_STALE_TRANSLATION_JOBS = 40;
const MAX_PENDING_SENTENCE_CHARS = 1400;
const QUEUED_TRANSLATION_RESCHEDULE_MS = 220;
const SAFE_FALLBACK_TRANSLATION = "Translation temporarily unavailable.";
const sessionHistoryStore = new Map();

const createSessionId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const cleanupSessionHistoryStore = () => {
  const now = Date.now();

  for (const [sessionId, entry] of sessionHistoryStore.entries()) {
    const updatedAt = entry?.updatedAt || 0;
    if (updatedAt && now - updatedAt > SESSION_HISTORY_TTL_MS) {
      sessionHistoryStore.delete(sessionId);
    }
  }

  while (sessionHistoryStore.size > MAX_STORED_SESSIONS) {
    const oldestSessionId = sessionHistoryStore.keys().next().value;
    sessionHistoryStore.delete(oldestSessionId);
  }
};

const rememberSessionHistory = (sessionId, transcriptHistory) => {
  sessionHistoryStore.set(sessionId, {
    history: transcriptHistory,
    updatedAt: Date.now()
  });
  cleanupSessionHistoryStore();
};

const touchSessionHistory = (sessionId) => {
  const entry = sessionHistoryStore.get(sessionId);
  if (!entry) return;

  if (Array.isArray(entry)) {
    sessionHistoryStore.set(sessionId, {
      history: entry,
      updatedAt: Date.now()
    });
    return;
  }

  entry.updatedAt = Date.now();
};

export const getInterpreterSessionHistory = (sessionId) => {
  cleanupSessionHistoryStore();
  const entry = sessionHistoryStore.get(sessionId);
  if (Array.isArray(entry)) return entry;
  return Array.isArray(entry?.history) ? entry.history : [];
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
const wordCount = (text = "") => text.split(/\s+/).filter(Boolean).length;

const trimTextWindow = (text = "", maxChars = MAX_PENDING_SENTENCE_CHARS) => {
  const cleanText = cleanTranscriptText(text);
  if (cleanText.length <= maxChars) return cleanText;
  return cleanText.slice(-maxChars).replace(/^\S+\s*/, "").trim();
};

const withTimeout = (promise, timeoutMs, message) => {
  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref?.();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
};

const translationCacheKey = ({ source, target, text }) =>
  [source || "auto", target || "", normalizeTranscript(text)].join("|");

const rememberCachedTranslation = (cache, key, value) => {
  if (!key || !value) return;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);

  while (cache.size > MAX_TRANSLATION_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
};

const adaptiveDebounceDelay = (sentence = "") => {
  const cleanSentence = cleanTranscriptText(sentence);
  const words = wordCount(cleanSentence);

  if (!cleanSentence) return SILENCE_DEBOUNCE_MS;
  if (sentenceEnds(cleanSentence)) return words <= 4 ? SHORT_PAUSE_DEBOUNCE_MS : SENTENCE_DEBOUNCE_MS;
  if (/[,:;]$/.test(cleanSentence)) return SHORT_PAUSE_DEBOUNCE_MS;
  if (words <= 3) return SHORT_PAUSE_DEBOUNCE_MS;
  return SILENCE_DEBOUNCE_MS;
};

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

const shouldRetryGeminiAttempt = (error) => !/timed out|stale/i.test(String(error?.message || error || ""));

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
  const translationCache = new Map();
  const staleTranslationJobs = new Set();
  let translationInFlight = false;
  let activeTranslationStartedAt = 0;
  let activeTranslationJobId = 0;
  let activeTranslationSnapshot = null;
  let translationJobSequence = 0;
  const sessionId = createSessionId();
  const providerHealth = {
    gemini: { failures: 0, cooldownUntil: 0 },
    openai: { failures: 0, cooldownUntil: 0 }
  };

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
    translationInFlight = false;
    activeTranslationStartedAt = 0;
    activeTranslationJobId = 0;
    activeTranslationSnapshot = null;
  };

  const trimStaleTranslationJobs = () => {
    while (staleTranslationJobs.size > MAX_STALE_TRANSLATION_JOBS) {
      staleTranslationJobs.delete(staleTranslationJobs.values().next().value);
    }
  };

  const providerAvailable = (provider) => {
    const health = providerHealth[provider];
    return Boolean(health) && Date.now() >= health.cooldownUntil;
  };

  const noteProviderSuccess = (provider) => {
    const health = providerHealth[provider];
    if (!health) return;
    health.failures = 0;
    health.cooldownUntil = 0;
  };

  const noteProviderFailure = (provider, error) => {
    const health = providerHealth[provider];
    if (!health) return;

    health.failures += 1;
    if (health.failures < PROVIDER_FAILURE_THRESHOLD) return;

    health.cooldownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
    console.warn("Translation provider cooldown started", {
      provider,
      failures: health.failures,
      cooldownMs: PROVIDER_COOLDOWN_MS,
      error: error?.message || error || "Provider failed"
    });
  };

  const refreshProviderCooldowns = () => {
    const now = Date.now();

    for (const health of Object.values(providerHealth)) {
      if (health.cooldownUntil && now >= health.cooldownUntil) {
        health.failures = 0;
        health.cooldownUntil = 0;
      }
    }
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

  const translateLanguageWithRecovery = async ({ language, translationInput, direction, translationContext, jobId }) => {
    let lastError = null;
    const languageTranslationContext = {
      ...translationContext,
      styleMemory: styleMemoryByLanguage.get(language) || null
    };
    const cacheKey = translationCacheKey({ source: direction.source, target: language, text: translationInput });
    const cachedTranslation = translationCache.get(cacheKey);

    if (cachedTranslation) {
      console.log("Translation cache hit", { targetLang: language });
      noteTranslationSuccess(language, cachedTranslation, languageTranslationContext);
      return cachedTranslation;
    }

    if (env.geminiApiKey && providerAvailable("gemini")) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (staleTranslationJobs.has(jobId)) {
          lastError = new Error("Translation job became stale");
          break;
        }

        if (attempt > 0) {
          console.log("Retrying Gemini translation", { targetLang: language, attempt: attempt + 1 });
          await delay(TRANSLATION_RATE_LIMIT_DELAY_MS);
        }

        const attemptStartedAt = Date.now();

        try {
          const translatedText = await withTimeout(
            translateWithGemini({
              apiKey: env.geminiApiKey,
              text: translationInput,
              sourceLang: direction.source,
              targetLang: language,
              translationContext: languageTranslationContext
            }),
            TRANSLATION_ATTEMPT_TIMEOUT_MS,
            `Gemini translation timed out for ${language}`
          );
          const responseTimeMs = Date.now() - attemptStartedAt;
          const safeTranslatedText = String(translatedText || "").trim();

          console.log("Gemini translation response", {
            provider: "gemini",
            targetLang: language,
            attempt: attempt + 1,
            responseTimeMs,
            empty: !safeTranslatedText,
            region: languageTranslationContext.accentProfile?.region,
            tone: languageTranslationContext.emotionProfile?.tone,
            confidence: languageTranslationContext.confidence
          });

          if (safeTranslatedText) {
            noteProviderSuccess("gemini");
            noteTranslationSuccess(language, safeTranslatedText, languageTranslationContext);
            rememberCachedTranslation(translationCache, cacheKey, safeTranslatedText);
            return safeTranslatedText;
          }

          lastError = new Error("Empty Gemini translation response");
          noteProviderFailure("gemini", lastError);
        } catch (error) {
          lastError = error;
          noteProviderFailure("gemini", error);
          console.warn("Gemini translation attempt failed", {
            provider: "gemini",
            targetLang: language,
            attempt: attempt + 1,
            responseTimeMs: Date.now() - attemptStartedAt,
            error: error?.message || error
          });

          if (!shouldRetryGeminiAttempt(error)) {
            break;
          }
        }
      }
    } else {
      console.warn("Skipping Gemini translation provider", {
        targetLang: language,
        reason: env.geminiApiKey ? "cooldown" : "missing_api_key"
      });
    }

    if (env.openaiApiKey && providerAvailable("openai") && !staleTranslationJobs.has(jobId)) {
      await delay(TRANSLATION_RATE_LIMIT_DELAY_MS);
      const attemptStartedAt = Date.now();

      try {
        const translatedText = await withTimeout(
          translateWithOpenAI({
            apiKey: env.openaiApiKey,
            text: translationInput,
            sourceLang: direction.source,
            targetLang: language,
            translationContext: languageTranslationContext
          }),
          TRANSLATION_ATTEMPT_TIMEOUT_MS,
          `OpenAI translation timed out for ${language}`
        );
        const responseTimeMs = Date.now() - attemptStartedAt;
        const safeTranslatedText = String(translatedText || "").trim();

        console.log("OpenAI fallback translation response", {
          provider: "openai",
          targetLang: language,
          responseTimeMs,
          empty: !safeTranslatedText,
          region: languageTranslationContext.accentProfile?.region,
          tone: languageTranslationContext.emotionProfile?.tone,
          confidence: languageTranslationContext.confidence
        });

        if (safeTranslatedText) {
          noteProviderSuccess("openai");
          noteTranslationSuccess(language, safeTranslatedText, languageTranslationContext);
          rememberCachedTranslation(translationCache, cacheKey, safeTranslatedText);
          return safeTranslatedText;
        }

        lastError = new Error("Empty OpenAI translation response");
        noteProviderFailure("openai", lastError);
      } catch (error) {
        lastError = error;
        noteProviderFailure("openai", error);
        console.warn("OpenAI fallback translation failed", {
          provider: "openai",
          targetLang: language,
          responseTimeMs: Date.now() - attemptStartedAt,
          error: error?.message || error
        });
      }
    } else if (env.openaiApiKey) {
      console.warn("Skipping OpenAI fallback provider", {
        targetLang: language,
        reason: providerAvailable("openai") ? "stale_job" : "cooldown"
      });
    }

    const localTranslation = resolveLocalTranslation({ text: translationInput, targetLang: language });
    if (localTranslation) {
      console.warn("Using local translation enhancer fallback", { targetLang: language });
      noteTranslationSuccess(language, localTranslation, languageTranslationContext);
      rememberCachedTranslation(translationCache, cacheKey, localTranslation);
      return localTranslation;
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
      return fallbackTranslation;
    }

    console.warn("Using safe translation fallback", {
      targetLang: language,
      error: lastError?.message || lastError || "No provider returned a valid translation"
    });
    return SAFE_FALLBACK_TRANSLATION;
  };

  const emitStableSentence = async () => {
    clearTranslationTimer();

    if (translationInFlight) {
      if (currentSentence.trim()) {
        scheduleStableTranslation(QUEUED_TRANSLATION_RESCHEDULE_MS);
      }
      return;
    }

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
    const jobId = translationJobSequence + 1;
    translationJobSequence = jobId;
    activeTranslationJobId = jobId;
    activeTranslationStartedAt = startedAt;
    activeTranslationSnapshot = {
      sentence,
      normalizedSentence,
      direction,
      detectedLanguage
    };
    translationInFlight = true;

    try {
    const translationInput = prepareTextForTranslation(sentence);
    const translations = {};
    const translationOutputs = [];
    const translationContext = buildTranslationContext({ sentence, direction, detectedLanguage });

    if (shouldTranslate) {
      onResult?.({
        original: sentence,
        originalText: sentence,
        translatedText: "",
        translations: {},
        translationOutputs,
        isFinal: true,
        isTranscriptOnly: true,
        sourceLang: direction.source,
        targetLang: direction.target,
        targetLanguages: direction.targets,
        detectedLanguage,
        latencyMs: Date.now() - startedAt,
        mode: "production"
      });
    }

    if (shouldTranslate) {
      const targetQueue = direction.targets.slice(0, MAX_TARGET_LANGUAGES);

      for (const language of targetQueue) {
        if (staleTranslationJobs.has(jobId)) break;

        if (translationOutputs.length > 0) {
          await delay(TRANSLATION_RATE_LIMIT_DELAY_MS);
        }

        const translatedText = await translateLanguageWithRecovery({ language, translationInput, direction, translationContext, jobId });
        if (staleTranslationJobs.has(jobId)) break;

        const safeTranslatedText = String(translatedText || "").trim();
        translationOutputs.push({ lang: language, text: safeTranslatedText });

        if (safeTranslatedText) {
          translations[language] = safeTranslatedText;
          onResult?.({
            original: sentence,
            originalText: sentence,
            translatedText: translations[direction.target] || safeTranslatedText,
            translations: { ...translations },
            translationOutputs: [...translationOutputs],
            isFinal: true,
            isTranslationPartial: true,
            translationComplete: false,
            sourceLang: direction.source,
            targetLang: direction.target,
            targetLanguages: direction.targets,
            detectedLanguage,
            latencyMs: Date.now() - startedAt,
            mode: "production"
          });
        }
      }
    }

    if (staleTranslationJobs.has(jobId)) {
      return;
    }

    const translatedText = translations[direction.target] || Object.values(translations).find(Boolean) || "";

    if (shouldTranslate && !translatedText) {
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

      const lastTranscriptEntry = session.transcriptHistory[session.transcriptHistory.length - 1];
      const duplicateTranscriptEntry =
        lastTranscriptEntry?.original === transcriptEntry.original &&
        lastTranscriptEntry?.translated === transcriptEntry.translated &&
        JSON.stringify(lastTranscriptEntry?.translations || {}) === JSON.stringify(transcriptEntry.translations || {});

      if (!duplicateTranscriptEntry) {
        session.transcriptHistory.push(transcriptEntry);
      }

      if (session.transcriptHistory.length > MAX_TRANSCRIPT_HISTORY) {
        session.transcriptHistory.splice(0, session.transcriptHistory.length - MAX_TRANSCRIPT_HISTORY);
      }
      touchSessionHistory(sessionId);
    }

    onResult?.({
      original: sentence,
      originalText: sentence,
      translatedText,
      translations,
      translationOutputs,
      isFinal: true,
      isTranslationComplete: shouldTranslate,
      sourceLang: direction.source,
      targetLang: direction.target,
      targetLanguages: direction.targets,
      detectedLanguage,
      latencyMs: Date.now() - startedAt,
      mode: "production"
    });
    } finally {
      staleTranslationJobs.delete(jobId);
      trimStaleTranslationJobs();
      if (activeTranslationJobId === jobId) {
        translationInFlight = false;
        activeTranslationStartedAt = 0;
        activeTranslationJobId = 0;
        activeTranslationSnapshot = null;
      }

      if (currentSentence.trim()) {
        scheduleStableTranslation(120);
      }
    }
  };

  const scheduleStableTranslation = (delayOverride) => {
    clearTranslationTimer();
    const delay = Number.isFinite(delayOverride) ? delayOverride : adaptiveDebounceDelay(currentSentence);
    translationTimer = setTimeout(() => {
      void emitStableSentence().catch((error) => {
        console.error("Translation processing failed:", error?.message || error);
        resetTranslationState();
        onWarning?.("Translation temporarily failed; continuing session.");
      });
    }, delay);
    translationTimer.unref?.();
  };

  const recoverStalledTranslationJob = (reason) => {
    const stalledJobId = activeTranslationJobId;
    const stalledForMs = activeTranslationStartedAt ? Date.now() - activeTranslationStartedAt : 0;
    const stalledSentence = activeTranslationSnapshot?.sentence || "";

    if (stalledJobId) staleTranslationJobs.add(stalledJobId);
    if (stalledSentence) currentSentence = trimTextWindow(appendSentenceChunk(stalledSentence, currentSentence));

    translationInFlight = false;
    activeTranslationStartedAt = 0;
    activeTranslationJobId = 0;
    activeTranslationSnapshot = null;
    trimStaleTranslationJobs();

    console.warn("Translation health monitor recovered a stalled job", {
      jobId: stalledJobId,
      reason,
      activeForMs: stalledForMs
    });

    if (currentSentence.trim()) {
      scheduleStableTranslation(QUEUED_TRANSLATION_RESCHEDULE_MS);
    }
  };

  const sessionHealthMonitor = setInterval(() => {
    cleanupSessionHistoryStore();
    refreshProviderCooldowns();
    trimStaleTranslationJobs();

    if (currentSentence.length > MAX_PENDING_SENTENCE_CHARS) {
      currentSentence = trimTextWindow(currentSentence);
    }

    if (!translationInFlight || !activeTranslationStartedAt) return;

    const activeForMs = Date.now() - activeTranslationStartedAt;
    if (activeForMs >= TRANSLATION_JOB_TIMEOUT_MS) {
      recoverStalledTranslationJob("job_timeout");
    }
  }, SESSION_HEALTH_CHECK_MS);
  sessionHealthMonitor.unref?.();

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
      currentSentence = trimTextWindow(appendSentenceChunk(currentSentence, displayText));
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
    clearInterval(sessionHealthMonitor);
    staleTranslationJobs.add(activeTranslationJobId);
    trimStaleTranslationJobs();
    translationInFlight = false;
    activeTranslationStartedAt = 0;
    activeTranslationJobId = 0;
    activeTranslationSnapshot = null;
    touchSessionHistory(sessionId);
    stopDeepgramSession?.();
  };

  await session.start();
  return session;
};
