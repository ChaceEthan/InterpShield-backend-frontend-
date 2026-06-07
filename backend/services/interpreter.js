// @ts-nocheck
import { createDeepgramSession } from "./deepgram.js";
import { translateWithGemini } from "./gemini.js";
import { translateWithOpenAI } from "./openai.js";
import {
  detectLocalSourceLanguage,
  detectRegionAccent,
  enhanceTranslation,
  normalizeMixedSpeech,
  resolveLocalTranslation
} from "../utils/translationEnhancer.js";
import { LOCAL_LANGUAGE_MARKERS } from "../data/languageMemory.js";
import {
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode as normalizeSharedLanguageCode
} from "../../shared/languages.mjs";

const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|hmm+|you know|i mean)\b[,\s]*/gi;
const MAX_TRANSCRIPT_HISTORY = 500;
const MAX_STORED_SESSIONS = 100;
const MAX_TARGET_LANGUAGES = 3;
const SENTENCE_DEBOUNCE_MS = 380;
const SHORT_PAUSE_DEBOUNCE_MS = 220;
const SILENCE_DEBOUNCE_MS = 650;
const LOCAL_LANGUAGE_CONFIDENCE_THRESHOLD = 0.7;
const TRANSLATION_LANE_FAST_LOCAL = "fastLocal";
const TRANSLATION_LANE_PROVIDER = "provider";
const LOCAL_BRIDGE_LANGUAGE_CODES = new Set(["rw", "rn", "lg"]);
const FAST_LOCAL_LANGUAGE_CODES = new Set(["sw", "rw", "rn", "lg"]);
const FAST_LOCAL_MAX_ACTIVE_TRANSLATIONS = 8;
const PROVIDER_MAX_ACTIVE_TRANSLATIONS = 6;
const MAX_TRANSLATION_LANE_QUEUE_SIZE = 24;
const MAX_SESSION_TRANSLATION_QUEUE_SIZE = 12;
const QUEUED_JOB_TIMEOUT = 90000;
const PROCESSING_JOB_TIMEOUT = 90000;
const SEQUENTIAL_JOB_HARD_TIMEOUT = 180000;
const TRANSLATION_RATE_LIMIT_DELAY_MS = 80;
const CIRCUIT_BREAKER_LATENCY_THRESHOLD_MS = 3000;
const LATENCY_WINDOW_SIZE = 5;
const MAX_CONSECUTIVE_TRANSLATION_FAILURES = 3;
const MAX_PROVIDER_RETRY_ATTEMPTS = 1;
const PROVIDER_RETRY_DELAY_MS = 900;

// Admin Dashboard Tracking (Simulated Persistent Store)
const globalUsageStats = {
  gemini: { tokens: 0, cost: 0, requests: 0 },
  openai: { tokens: 0, cost: 0, requests: 0 },
  history: [], // Hourly cost buckets for line chart
  lastUpdate: Date.now()
};
const MONTHLY_BUDGET = 100.00; // Example $100 budget
const alertedThresholds = new Set();
const ESTIMATED_RATES = { gemini: 0.000125 / 1000, openai: 0.03 / 1000 };

/**
 * Clears all global usage statistics and alert memory for the new billing month.
 */
export const resetGlobalBudget = () => {
  globalUsageStats.gemini = { tokens: 0, cost: 0, requests: 0 };
  globalUsageStats.openai = { tokens: 0, cost: 0, requests: 0 };
  globalUsageStats.history = [];
  globalUsageStats.lastUpdate = Date.now();
  alertedThresholds.clear();
};

const MAX_STYLE_MEMORY_ENTRIES = 20;
const MAX_TRANSLATION_CACHE_ENTRIES = 1200;
const FAST_LOCAL_TRANSLATION_CACHE_TTL_MS = 25 * 60 * 1000;
const PROVIDER_TRANSLATION_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const PARTIAL_TRANSLATION_PREVIEW_THROTTLE_MS = 140;
const PROVIDER_STREAMING_PREVIEW_THROTTLE_MS = 650;
const PROVIDER_STREAMING_PREVIEW_MIN_WORDS = 2;
const PROVIDER_STREAMING_PREVIEW_MIN_CHARS = 6;
const ADMIN_STATS_EMIT_MS = 10000;
const PROVIDER_TIMEOUT_MS = {
  gemini: 25000,
  openai: 22000
};
const PROVIDER_FAILURE_THRESHOLD = 6;
const PROVIDER_COOLDOWN_MS = 45000;
const PROVIDER_HARD_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const SESSION_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_HEALTH_CHECK_MS = 2500;
const MAX_STALE_TRANSLATION_JOBS = 40;
const MAX_PENDING_SENTENCE_CHARS = 1400;
const LOG_TEXT_PREVIEW_CHARS = 96;
const sessionHistoryStore = new Map();
const sharedTranslationCache = new Map();
const debugFlagEnabled = (flag) =>
  ["1", "true", "yes", "on"].includes(String(process.env[flag] || process.env.DEBUG || "").trim().toLowerCase());

const logTranslationEvent = (event, payload = {}, level = "info") => {
  const providerEvent = /^PROVIDER_|^TRANSLATION_REQUEST|^TRANSLATION_COMPLETE/.test(event);
  const shouldLog =
    process.env.NODE_ENV !== "production" ||
    debugFlagEnabled("TRANSLATION_DEBUG") ||
    (providerEvent && debugFlagEnabled("PROVIDER_DEBUG"));
  if (!shouldLog) return;

  const safePayload = {};

  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null || value === "") continue;
    safePayload[key] = typeof value === "string" && value.length > LOG_TEXT_PREVIEW_CHARS
      ? `${value.slice(0, LOG_TEXT_PREVIEW_CHARS)}...`
      : value;
  }

  const logger = level === "warn" ? console.warn : console.info;
  logger(`[${event}]`, safePayload);
};

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

const hasMeaningfulTranslationText = (text = "") => {
  const cleanText = cleanTranscriptText(text);
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(cleanText)) return true;

  return cleanText
    .split(/\s+/)
    .map(normalizeNoiseToken)
    .some((word) => word.length >= 2);
};

const normalizeTargetLanguages = (targetLanguages, fallbackTargetLang = "es") => {
  const requestedLanguages = Array.isArray(targetLanguages)
    ? targetLanguages
    : targetLanguages
      ? [targetLanguages]
      : [fallbackTargetLang];

  const uniqueLanguages = [];

  for (const language of requestedLanguages) {
    const code = normalizeInterpreterLanguageCode(language) || String(language || "").trim().toLowerCase();
    if (!code || !SUPPORTED_LANGUAGE_CODES.has(code) || uniqueLanguages.includes(code)) continue;
    uniqueLanguages.push(code);
    if (uniqueLanguages.length === MAX_TARGET_LANGUAGES) break;
  }

  if (uniqueLanguages.length > 0) return uniqueLanguages;
  const fallback = normalizeInterpreterLanguageCode(fallbackTargetLang);
  return fallback && SUPPORTED_LANGUAGE_CODES.has(fallback) ? [fallback] : ["en"];
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

const normalizeInterpreterLanguageCode = (language = "") => {
  const normalized = String(language || "").trim().toLowerCase().replace("_", "-");
  if (!normalized) return "";
  if (normalized === "auto") return "auto";
  return normalizeSharedLanguageCode(normalized) || normalized.split("-")[0] || normalized;
};

const isLocalBridgeLanguageCode = (language = "") => LOCAL_BRIDGE_LANGUAGE_CODES.has(normalizeInterpreterLanguageCode(language));

const sourceLanguageForProvider = (language = "") => {
  const code = normalizeInterpreterLanguageCode(language);
  if (!code || code === "auto") return "auto";
  if (!SUPPORTED_LANGUAGE_CODES.has(code)) return "auto";
  return code;
};

const shouldUseDetectedSourceLanguage = ({ configuredSourceLang = "", twoWay = false } = {}) => {
  const configured = normalizeInterpreterLanguageCode(configuredSourceLang);
  return Boolean(twoWay || !configured || configured === "auto");
};

const isFastLocalLaneLanguage = ({ sourceLang = "", targetLang = "" } = {}) => {
  const source = normalizeInterpreterLanguageCode(sourceLang);
  const target = normalizeInterpreterLanguageCode(targetLang);

  if (FAST_LOCAL_LANGUAGE_CODES.has(target)) return true;
  if (target === "en" && isLocalBridgeLanguageCode(source)) return true;
  if (target === "en" && FAST_LOCAL_LANGUAGE_CODES.has(source)) return true;
  return source === "en" && target === "en";
};

const translationLaneForLanguage = ({ sourceLang = "", targetLang = "" } = {}) =>
  isFastLocalLaneLanguage({ sourceLang, targetLang }) ? TRANSLATION_LANE_FAST_LOCAL : TRANSLATION_LANE_PROVIDER;

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

const translationMutex = (() => {
  const tails = new Map();

  return {
    async acquire(sessionId) {
      const key = sessionId || "default";
      const previousTail = tails.get(key) || Promise.resolve();
      let releaseCurrent = () => undefined;
      const currentTail = new Promise((resolve) => {
        releaseCurrent = resolve;
      });
      const chainedTail = previousTail.catch(() => undefined).then(() => currentTail);

      tails.set(key, chainedTail);
      await previousTail.catch(() => undefined);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseCurrent();
        if (tails.get(key) === chainedTail) {
          tails.delete(key);
        }
      };
    }
  };
})();

const hashTranslationCacheInput = (value = "") => {
  let hash = 2166136261;
  const input = String(value || "");

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
};

const translationCacheKey = ({ source, target, text }) =>
  hashTranslationCacheInput(
    [
      normalizeInterpreterLanguageCode(source) || source || "auto",
      normalizeInterpreterLanguageCode(target) || target || "",
      normalizeTranscript(text)
    ].join("|")
  );

const translationCacheTtlMs = ({ source, target } = {}) =>
  isFastLocalLaneLanguage({ sourceLang: source, targetLang: target })
    ? FAST_LOCAL_TRANSLATION_CACHE_TTL_MS
    : PROVIDER_TRANSLATION_CACHE_TTL_MS;

const isProviderFailureText = (text = "") =>
  /\b(temporar(?:il)y unavailable|temporar(?:il)y failed|translation unavailable|provider failed|timed out|timeout)\b/i.test(String(text || ""));

const providerErrorMessage = (error = {}) => String(error?.message || error || "");

const isProviderNonRetryableFailure = (error = {}) =>
  /\b(401|403|429)\b|rate[_ -]?limit|quota|insufficient|credit|billing|unauthori[sz]ed|forbidden|invalid api key|permission|resource_exhausted/i.test(
    providerErrorMessage(error)
  );

const isRetryableProviderError = (error = {}) => {
  const message = providerErrorMessage(error);
  if (!message) return false;
  return !isProviderNonRetryableFailure(error);
};

const isSourceTaggedFallbackText = (text = "") => /^\[[a-z]{2,12}(?:-[a-z0-9]{2,12})?\]\s+/i.test(cleanTranscriptText(text));

const isSourceEchoTranslation = ({ text = "", sourceText = "" } = {}) => {
  const cleanText = cleanTranscriptText(text);
  if (!cleanText) return false;
  const source = cleanTranscriptText(sourceText);
  if (!source || normalizeTranscript(cleanText) !== normalizeTranscript(source)) return false;

  const cleanTokens = languageTokens(cleanText);
  const sourceTokens = languageTokens(source);
  const looksLikeNameOrEntity =
    sourceTokens.length <= 3 &&
    /^[\p{Lu}\p{N}][\p{L}\p{N}'’.-]*(?:\s+[\p{Lu}\p{N}][\p{L}\p{N}'’.-]*){0,2}$/u.test(source);
  const shortConversationalFragment = sourceTokens.length <= 2 && cleanText.length <= 18;

  return !(looksLikeNameOrEntity || shortConversationalFragment || cleanTokens.length <= 1);
};

const TARGET_LANGUAGE_MARKERS = {
  es: {
    phrases: [
      "por favor",
      "muchas gracias",
      "buenos dias",
      "buenas tardes",
      "buenas noches",
      "me puedes",
      "puedes darme",
      "dame el",
      "dame la",
      "tu libro",
      "su libro",
      "de nada",
      "lo siento",
      "que tal"
    ],
    words: [
      "el",
      "la",
      "los",
      "las",
      "un",
      "una",
      "unos",
      "unas",
      "de",
      "del",
      "que",
      "para",
      "por",
      "con",
      "sin",
      "como",
      "hola",
      "gracias",
      "favor",
      "vale",
      "claro",
      "bueno",
      "bien",
      "perdon",
      "adios",
      "listo",
      "puedes",
      "puede",
      "puedo",
      "podemos",
      "dame",
      "darme",
      "libro",
      "libros",
      "necesito",
      "quiero",
      "tengo",
      "tienes",
      "tiene",
      "buenos",
      "buenas",
      "dias",
      "noches",
      "si",
      "aqui",
      "ahora",
      "usted",
      "ustedes",
      "tu",
      "mi",
      "su",
      "nuestro",
      "voy",
      "vaya",
      "hablar",
      "escuchar",
      "traducir",
      "pregunta",
      "respuesta",
      "ayuda",
      "medico",
      "hospital"
    ]
  },
  sw: {
    phrases: [
      ...(LOCAL_LANGUAGE_MARKERS.sw?.phrases || []),
      "unaweza kunipa",
      "kitabu chako",
      "asante sana"
    ],
    words: [
      ...(LOCAL_LANGUAGE_MARKERS.sw?.words || []),
      "unaweza",
      "kunipa",
      "kitabu",
      "chako",
      "tafadhali",
      "asante",
      "habari",
      "ndiyo",
      "hapana",
      "nina",
      "kwa",
      "hii",
      "hiyo",
      "mimi",
      "wewe",
      "sisi",
      "yeye",
      "wao",
      "ni",
      "na",
      "ya",
      "za",
      "wa",
      "watu",
      "mtu",
      "leo",
      "kesho",
      "sasa",
      "hapa",
      "kazi",
      "fedha",
      "familia",
      "afya",
      "msaada",
      "wako",
      "ninahitaji"
    ]
  }
};

const ENGLISH_LANGUAGE_MARKERS = {
  phrases: [
    "can you",
    "could you",
    "please give",
    "give me",
    "thank you",
    "how are you",
    "good morning",
    "good evening",
    "no problem",
    "i would",
    "i am",
    "you are"
  ],
  words: [
    "the",
    "and",
    "you",
    "your",
    "please",
    "give",
    "book",
    "hello",
    "thanks",
    "thank",
    "problem",
    "question",
    "answer",
    "friend",
    "okay",
    "need",
    "want",
    "have",
    "this",
    "that",
    "what",
    "when",
    "where",
    "why",
    "how",
    "can",
    "could",
    "would",
    "should"
  ]
};

const normalizeLanguageDetectionText = (text = "") =>
  cleanTranscriptText(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const languageTokens = (text = "") => normalizeLanguageDetectionText(text).match(/[\p{L}\p{N}']+/gu) || [];

const countLanguageMarkers = (text = "", markers = {}) => {
  const normalized = normalizeLanguageDetectionText(text);
  const tokens = new Set(languageTokens(text));
  let score = 0;

  for (const phrase of markers.phrases || []) {
    const normalizedPhrase = normalizeLanguageDetectionText(phrase);
    if (normalizedPhrase && normalized.includes(normalizedPhrase)) score += 2;
  }

  for (const word of markers.words || []) {
    const normalizedWord = normalizeLanguageDetectionText(word);
    if (normalizedWord && tokens.has(normalizedWord)) score += 1;
  }

  return score;
};

const hasSpanishOrthography = (text = "") => /[\u00e1\u00e9\u00ed\u00f3\u00fa\u00fc\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00dc\u00d1\u00bf\u00a1]/.test(text);
const hasChineseCharacters = (text = "") => /[\u3400-\u9fff\uf900-\ufaff]/.test(text);

const isTargetLanguageText = ({ text = "", targetLang = "" } = {}) => {
  const target = normalizeInterpreterLanguageCode(targetLang);
  const cleanText = cleanTranscriptText(text);
  if (!cleanText) return false;
  if (!target || target === "auto" || target === "en") return true;

  const tokenCount = languageTokens(cleanText).length;
  const englishScore = countLanguageMarkers(cleanText, ENGLISH_LANGUAGE_MARKERS);

  if (target === "zh") {
    return hasChineseCharacters(cleanText);
  }

  if (target === "es") {
    const spanishScore = countLanguageMarkers(cleanText, TARGET_LANGUAGE_MARKERS.es);
    return (
      hasSpanishOrthography(cleanText) ||
      spanishScore >= 2 ||
      (spanishScore >= 1 && englishScore === 0 && tokenCount <= 3)
    );
  }

  if (target === "sw") {
    const markerScore = countLanguageMarkers(cleanText, TARGET_LANGUAGE_MARKERS[target]);
    return markerScore >= 2 || (markerScore >= 1 && englishScore === 0 && tokenCount <= 4);
  }

  if (tokenCount <= 4) return true;
  if (englishScore >= 6) return false;
  return true;
};

export const isTranslationDisplayable = ({ text = "", sourceText = "", sourceLang = "", targetLang = "", provider = "" } = {}) => {
  const cleanText = cleanTranscriptText(text);
  if (!cleanText || isProviderFailureText(cleanText)) return false;
  if (isSourceTaggedFallbackText(cleanText)) return false;
  if (provider === "failed" || provider === "source") return false;
  if (!hasMeaningfulTranslationText(cleanText)) return false;

  if (isSourceEchoTranslation({ text: cleanText, sourceText })) return false;

  void targetLang;
  void sourceLang;
  return true;
};

const isCacheableTranslation = ({ text = "", sourceText = "", provider = "", sourceLang = "", targetLang = "" } = {}) =>
  isTranslationDisplayable({ text, sourceText, provider, sourceLang, targetLang });

const pruneTranslationCache = (cache = sharedTranslationCache) => {
  const now = Date.now();

  for (const [key, entry] of cache.entries()) {
    if (
      !entry?.expiresAt ||
      entry.expiresAt <= now ||
      !entry.text ||
      isProviderFailureText(entry.text) ||
      isSourceTaggedFallbackText(entry.text)
    ) {
      cache.delete(key);
    }
  }

  while (cache.size > MAX_TRANSLATION_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
};

const readCachedTranslation = (cache, key, metadata = {}) => {
  const entry = cache.get(key);
  if (!entry) return "";

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return "";
  }

  if (
    !isCacheableTranslation({
      text: entry.text,
      sourceText: metadata.sourceText || entry.sourceText,
      provider: entry.provider || metadata.provider || "cache",
      sourceLang: metadata.source || entry.source,
      targetLang: metadata.target || entry.target
    })
  ) {
    cache.delete(key);
    return "";
  }

  cache.delete(key);
  cache.set(key, entry);
  return entry.text;
};

const rememberCachedTranslation = (cache, key, value, metadata = {}) => {
  if (
    !key ||
    !isCacheableTranslation({
      text: value,
      sourceText: metadata.sourceText,
      provider: metadata.provider,
      sourceLang: metadata.source,
      targetLang: metadata.target
    })
  ) {
    return;
  }
  if (cache.has(key)) cache.delete(key);
  cache.set(key, {
    text: cleanTranscriptText(value),
    provider: metadata.provider || "unknown",
    source: metadata.source,
    target: metadata.target,
    sourceText: metadata.sourceText,
    createdAt: Date.now(),
    expiresAt: Date.now() + translationCacheTtlMs({ source: metadata.source, target: metadata.target })
  });

  pruneTranslationCache(cache);
};

const adaptiveDebounceDelay = (sentence = "") => {
  const cleanSentence = cleanTranscriptText(sentence);
  const words = wordCount(cleanSentence);

  if (!cleanSentence) return SILENCE_DEBOUNCE_MS;
  if (words <= 4) return SHORT_PAUSE_DEBOUNCE_MS;
  if (words <= 14) return SENTENCE_DEBOUNCE_MS;
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
  if (normalizedSentence.includes(normalizedChunk)) return cleanSentence;

  const sentenceWords = cleanSentence.split(/\s+/).filter(Boolean);
  const chunkWords = cleanChunk.split(/\s+/).filter(Boolean);
  const sentenceTokens = sentenceWords.map(normalizeNoiseToken);
  const chunkTokens = chunkWords.map(normalizeNoiseToken);
  const maxOverlap = Math.min(sentenceTokens.length, chunkTokens.length, 8);

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const sentenceTail = sentenceTokens.slice(-overlap).join(" ");
    const chunkHead = chunkTokens.slice(0, overlap).join(" ");
    if (sentenceTail && sentenceTail === chunkHead) {
      return `${sentenceWords.join(" ")} ${chunkWords.slice(overlap).join(" ")}`.replace(/\s+/g, " ").trim();
    }
  }

  return `${cleanSentence} ${cleanChunk}`.replace(/\s+/g, " ").trim();
};

const resolveDirection = ({ sourceLang, targetLang, targetLanguages, detectedLanguage, twoWay }) => {
  const targets = normalizeTargetLanguages(targetLanguages, targetLang);
  const source = shouldUseDetectedSourceLanguage({ configuredSourceLang: sourceLang, twoWay })
    ? detectedLanguage || sourceLang
    : sourceLang;
  return { source, target: targets[0], targets };
};

export const createInterpreterSession = async ({
  env,
  sourceLang,
  userPlan = "free",
  preferredProvider = "auto",
  targetLang,
  targetLanguages,
  shouldTranslate,
  twoWay,
  onReady,
  onWarning,
  onError,
  onProviderHealth,
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

  const trackUsage = (provider, tokens = 150) => {
    const stats = globalUsageStats[provider];
    if (!stats) return;
    stats.requests += 1;
    stats.tokens += tokens;
    stats.cost += tokens * (ESTIMATED_RATES[provider] || 0);
    globalUsageStats.lastUpdate = Date.now();
  };

  let translationTimer = null;
  let consecutiveTranslationFailures = 0;
  const styleMemoryByLanguage = new Map();
  const translationCache = sharedTranslationCache;
  const staleTranslationJobs = new Set();
  const translationJobs = new Map();
  const backgroundRetryTimers = new Set();
  const translationLanes = {};
  const providerAbortControllersByJob = new Map();
  const activeTranslationLanguageLocks = new Set();
  let activeSequentialTranslationJob = null;
  const sessionTranslationQueue = {
    queue: [],
    processing: false,
    activeJob: null,
    currentAbortController: null,
    sequence: 0
  };
  const createTranslationLane = ({ group, language }) => ({
    id: `${group}:${language || "default"}`,
    group,
    language,
    label: `${group === TRANSLATION_LANE_FAST_LOCAL ? "FAST_LOCAL" : "AI_PROVIDER"}:${language || "default"}`,
    queue: [],
    activeTasks: new Map(),
    maxActive: group === TRANSLATION_LANE_FAST_LOCAL ? FAST_LOCAL_MAX_ACTIVE_TRANSLATIONS : PROVIDER_MAX_ACTIVE_TRANSLATIONS,
    maxQueueSize: MAX_TRANSLATION_LANE_QUEUE_SIZE,
    drainScheduled: false,
    latencyHistory: [],
    tripped: false
  });
  const getTranslationLane = ({ sourceLang: laneSourceLang = "", targetLang: laneTargetLang = "" } = {}) => {
    const group = translationLaneForLanguage({ sourceLang: laneSourceLang, targetLang: laneTargetLang });
    const language = group === TRANSLATION_LANE_PROVIDER
      ? "default"
      : normalizeInterpreterLanguageCode(laneTargetLang) || String(laneTargetLang || "default").trim().toLowerCase() || "default";
    const laneId = `${group}:${language}`;

    if (!translationLanes[laneId]) {
      translationLanes[laneId] = createTranslationLane({ group, language });
    }

    return translationLanes[laneId];
  };
  const getProviderFallbackLane = (targetLanguage = "") => {
    const language = "default";
    const laneId = `${TRANSLATION_LANE_PROVIDER}:${language}`;

    void targetLanguage;
    if (!translationLanes[laneId]) {
      translationLanes[laneId] = createTranslationLane({ group: TRANSLATION_LANE_PROVIDER, language });
    }

    return translationLanes[laneId];
  };
  const localSourceMemory = {
    language: null,
    confidence: 0,
    transcriptHistory: []
  };
  let translationJobSequence = 0;
  let translationEmitSequence = 0;
  let lastStreamingPreviewAt = 0;
  let lastStreamingPreviewSignature = "";
  let lastProviderStreamingPreviewAt = 0;
  let lastProviderStreamingPreviewSignature = "";
  let providerStreamingPreviewSequence = 0;
  let lastAdminStatsAt = 0;
  const sessionId = createSessionId();
  const providerHealth = {
    gemini: { failures: 0, cooldownUntil: 0, lastSuccessAt: 0 },
    openai: { failures: 0, cooldownUntil: 0, lastSuccessAt: 0 }
  };
  const translationMetrics = {
    timeoutCount: 0,
    retryCount: 0,
    completedCount: 0,
    failedCount: 0,
    providerLatency: {
      gemini: [],
      openai: []
    }
  };

  let lastHealthState = "";

  const activeTranslationTaskCount = () =>
    allTranslationLanes().reduce((count, lane) => count + lane.activeTasks.size, activeTranslationLanguageLocks.size);

  const queuedTranslationTaskCount = () =>
    allTranslationLanes().reduce(
      (count, lane) => count + lane.queue.length,
      activeSequentialTranslationJob && !activeSequentialTranslationJob.completed && !activeSequentialTranslationJob.stale
        ? activeSequentialTranslationJob.pendingLanguages?.size || 0
        : 0
    );

  const rememberProviderLatency = (provider, latency) => {
    const bucket = translationMetrics.providerLatency[provider];
    if (!bucket || !Number.isFinite(latency)) return;

    bucket.push(latency);
    if (bucket.length > LATENCY_WINDOW_SIZE) bucket.shift();
  };

  const logTranslationMetrics = (reason, extra = {}) => {
    if (!debugFlagEnabled("TRANSLATION_DEBUG")) return;
    logTranslationEvent("TRANSLATION_METRICS", { reason, ...extra });
  };

  const getTranslationHealth = () => ({
    sessionId,
    sourceLang,
    targetLanguages: sessionTargetLanguages,
    queue: {
      fifoQueuedJobs: sessionTranslationQueue.queue.length,
      fifoProcessing: sessionTranslationQueue.processing,
      activeJobId: sessionTranslationQueue.activeJob?.id || null,
      activeSequentialJobId: activeSequentialTranslationJob?.id || null,
      trackedJobs: translationJobs.size,
      staleJobs: staleTranslationJobs.size,
      retryTimers: backgroundRetryTimers.size
    },
    lanes: allTranslationLanes().map((lane) => ({
      id: lane.id,
      group: lane.group,
      language: lane.language,
      queuedTasks: lane.queue.length,
      activeTasks: lane.activeTasks.size,
      tripped: lane.tripped,
      avgLatencyMs: lane.latencyHistory.length > 0
        ? Math.round(lane.latencyHistory.reduce((sum, value) => sum + value, 0) / lane.latencyHistory.length)
        : 0
    })),
    providers: {
      gemini: { ...providerHealth.gemini, available: providerAvailable("gemini") },
      openai: { ...providerHealth.openai, available: providerAvailable("openai") }
    },
    metrics: {
      timeoutCount: translationMetrics.timeoutCount,
      retryCount: translationMetrics.retryCount,
      completedCount: translationMetrics.completedCount,
      failedCount: translationMetrics.failedCount
    }
  });

  const createTranslationPayloadMetadata = (jobOrId = null) => {
    const jobId = typeof jobOrId === "object" && jobOrId !== null
      ? jobOrId.id
      : jobOrId || `preview-${translationEmitSequence + 1}`;
    const stableSequence = typeof jobOrId === "object" && jobOrId !== null && Number.isFinite(jobOrId.sequence)
      ? jobOrId.sequence
      : null;

    if (stableSequence) {
      translationEmitSequence = Math.max(translationEmitSequence, stableSequence);
    } else {
      translationEmitSequence += 1;
    }

    return {
      sessionId,
      jobId,
      timestamp: new Date().toISOString(),
      sequence: stableSequence || translationEmitSequence
    };
  };

  const emitProviderHealth = () => {
    const geminiAvailable = Boolean(env.geminiApiKey && providerAvailable("gemini"));
    const openaiAvailable = Boolean(env.openaiApiKey && providerAvailable("openai"));
    const current = {
      gemini: {
        status: geminiAvailable ? "healthy" : "cooldown",
        cooldownUntil: providerHealth.gemini.cooldownUntil
      },
      openai: {
        status: openaiAvailable ? "healthy" : "cooldown",
        cooldownUntil: providerHealth.openai.cooldownUntil
      }
    };
    const stateStr = JSON.stringify(current);
    if (stateStr === lastHealthState) return;
    lastHealthState = stateStr;
    onProviderHealth?.(current);
  };

  const notifyAdmin = async (message) => {
    const webhookUrl = env.adminWebhookUrl;
    if (!webhookUrl) return;

    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `InterpShield Alert: ${message}`,
          text: `InterpShield Alert: ${message}`
        })
      });
    } catch (error) {
      void error;
    }
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
    for (const job of translationJobs.values()) {
      staleTranslationJobs.add(job.id);
      job.stale = true;
      job.cancelled = true;
      job.pendingLanguages?.clear?.();
      job.runningLanguages?.clear?.();
    }
    for (const controllers of providerAbortControllersByJob.values()) {
      for (const controller of controllers) controller?.abort?.();
    }
    providerAbortControllersByJob.clear();
    activeSequentialTranslationJob = null;
    activeTranslationLanguageLocks.clear();
    sessionTranslationQueue.currentAbortController?.abort?.();
    sessionTranslationQueue.currentAbortController = null;
    sessionTranslationQueue.activeJob = null;
    sessionTranslationQueue.queue.length = 0;
    sessionTranslationQueue.processing = false;
    translationJobs.clear();
    for (const lane of Object.values(translationLanes)) {
      lane.queue.length = 0;
      lane.activeTasks.clear();
      lane.drainScheduled = false;
    }
    for (const retryTimer of backgroundRetryTimers) {
      clearTimeout(retryTimer);
    }
    backgroundRetryTimers.clear();
  };

  const updateLaneLatency = (lane, latency) => {
    // We primarily monitor the Provider lane for AI-related slowness
    if (lane.group !== TRANSLATION_LANE_PROVIDER) return;

    lane.latencyHistory.push(latency);
    if (lane.latencyHistory.length > LATENCY_WINDOW_SIZE) lane.latencyHistory.shift();

    const avg = lane.latencyHistory.reduce((a, b) => a + b, 0) / lane.latencyHistory.length;
    const previouslyTripped = lane.tripped;
    lane.tripped = lane.latencyHistory.length >= 5 && avg > CIRCUIT_BREAKER_LATENCY_THRESHOLD_MS * 2;

    if (lane.tripped && !previouslyTripped) {
      onWarning?.("AI_PROVIDER_DEGRADED");
      emitProviderHealth();
      notifyAdmin(`Circuit breaker tripped for ${lane.label}. Average latency exceeded ${CIRCUIT_BREAKER_LATENCY_THRESHOLD_MS}ms.`);
    }
  };

  const trimStaleTranslationJobs = () => {
    while (staleTranslationJobs.size > MAX_STALE_TRANSLATION_JOBS) {
      staleTranslationJobs.delete(staleTranslationJobs.values().next().value);
    }
  };

  const trackProviderAbortController = (jobId, controller) => {
    if (!jobId || !controller) return () => undefined;

    if (!providerAbortControllersByJob.has(jobId)) {
      providerAbortControllersByJob.set(jobId, new Set());
    }

    const controllers = providerAbortControllersByJob.get(jobId);
    controllers.add(controller);

    return () => {
      controllers.delete(controller);
      if (controllers.size === 0) {
        providerAbortControllersByJob.delete(jobId);
      }
    };
  };

  const abortProviderRequestsForJob = (jobId) => {
    const controllers = providerAbortControllersByJob.get(jobId);
    if (!controllers) return;

    for (const controller of controllers) {
      controller?.abort?.();
    }

    providerAbortControllersByJob.delete(jobId);
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
    health.lastSuccessAt = Date.now();
  };

  const noteProviderFailure = (provider, error) => {
    const health = providerHealth[provider];
    if (!health) return;
    const nonRetryable = isProviderNonRetryableFailure(error);

    health.failures = nonRetryable ? PROVIDER_FAILURE_THRESHOLD : health.failures + 1;
    if (health.failures < PROVIDER_FAILURE_THRESHOLD) return;

    health.cooldownUntil = Date.now() + (nonRetryable ? PROVIDER_HARD_FAILURE_COOLDOWN_MS : PROVIDER_COOLDOWN_MS);
    logTranslationEvent("PROVIDER_COOLDOWN", {
      sessionId,
      provider,
      reason: nonRetryable ? "non_retryable_failure" : "failure_threshold",
      error: providerErrorMessage(error)
    }, "warn");
    emitProviderHealth();
  };

  const refreshProviderCooldowns = () => {
    const now = Date.now();
    let recovered = [];

    for (const [name, health] of Object.entries(providerHealth)) {
      if (health.cooldownUntil && now >= health.cooldownUntil) {
        recovered.push(name);
        health.failures = 0;
        health.cooldownUntil = 0;
      }
    }

    if (recovered.length > 0) {
      onWarning?.(`PROVIDER_RECOVERED:${recovered.join(",")}`);
    }

    emitProviderHealth();
  };

  const getHealthyProviders = () => {
    refreshProviderCooldowns();
    let primaryChoice = userPlan === "pro" ? "openai" : "gemini";
    if (preferredProvider && preferredProvider !== "auto") {
      primaryChoice = preferredProvider;
    }
    const providers = Object.entries(providerHealth)
      .filter(([name, health]) => {
        const hasKey = name === "gemini" ? env.geminiApiKey : env.openaiApiKey;
        return hasKey && Date.now() >= health.cooldownUntil;
      });

    return providers.sort((a, b) => {
      if (a[1].failures !== b[1].failures) return a[1].failures - b[1].failures;

      if (a[0] === primaryChoice && b[0] !== primaryChoice) return -1;
      if (b[0] === primaryChoice && a[0] !== primaryChoice) return 1;

      return b[1].lastSuccessAt - a[1].lastSuccessAt;
    }).map(([name]) => name);
  };

  const rememberLocalSourceLanguage = ({ text = "", language, confidence = 0 } = {}) => {
    const cleanText = cleanTranscriptText(text);
    if (!cleanText || !language) return;

    localSourceMemory.language = language;
    localSourceMemory.confidence = Math.max(localSourceMemory.confidence || 0, confidence);
    localSourceMemory.transcriptHistory.push({ original: cleanText, language, confidence });

    if (localSourceMemory.transcriptHistory.length > 12) {
      localSourceMemory.transcriptHistory.splice(0, localSourceMemory.transcriptHistory.length - 12);
    }
  };

  const resolveSourceLanguage = ({ text = "", providerDetectedLanguage = "" } = {}) => {
    const detection = detectLocalSourceLanguage({
      text,
      transcriptHistory: localSourceMemory.transcriptHistory,
      previousLanguage: localSourceMemory.language || currentDetectedLanguage,
      providerLanguage: providerDetectedLanguage,
      configuredSourceLang: sourceLang
    });

    if (detection.language && detection.confidence >= LOCAL_LANGUAGE_CONFIDENCE_THRESHOLD) {
      rememberLocalSourceLanguage({ text, language: detection.language, confidence: detection.confidence });
      return {
        language: detection.language,
        confidence: detection.confidence,
        source: detection.source
      };
    }

    const fallbackLanguage = providerDetectedLanguage || localSourceMemory.language || currentDetectedLanguage || sourceLang;
    return {
      language: fallbackLanguage,
      confidence: detection.confidence,
      source: providerDetectedLanguage ? "provider" : "memory"
    };
  };

  const noteTranslationSuccess = (language, translatedText, translationContext) => {
    consecutiveTranslationFailures = 0;
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
    void language;
    void error;

    if (consecutiveTranslationFailures >= MAX_CONSECUTIVE_TRANSLATION_FAILURES) {
      consecutiveTranslationFailures = 0;
    }
  };

  const languageTranslationContextFor = (language, translationContext) => ({
    ...translationContext,
    styleMemory: styleMemoryByLanguage.get(language) || null
  });

  const resolveFastLocalTranslation = ({ language, translationInput, direction }) => {
    const localTranslation = resolveLocalTranslation({ text: translationInput, sourceLang: direction.source, targetLang: language });
    if (localTranslation) return localTranslation;

    const source = normalizeInterpreterLanguageCode(direction.source);
    const target = normalizeInterpreterLanguageCode(language);

    if (source && source === target) return "";

    if (target === "en" && FAST_LOCAL_LANGUAGE_CODES.has(source)) {
      const mixedSpeech = normalizeMixedSpeech(translationInput);
      if (mixedSpeech.isMixed) return cleanTranscriptText(mixedSpeech.normalizedText);
    }

    return "";
  };

  const translateFastLocalLanguage = async ({ language, translationInput, direction, translationContext }) => {
    const languageTranslationContext = languageTranslationContextFor(language, translationContext);
    const cacheKey = translationCacheKey({ source: direction.source, target: language, text: translationInput });
    const cachedTranslation = readCachedTranslation(translationCache, cacheKey, {
      source: direction.source,
      target: language,
      sourceText: translationInput,
      provider: "cache"
    });

    if (cachedTranslation) {
      noteTranslationSuccess(language, cachedTranslation, languageTranslationContext);
      return { text: cachedTranslation, provider: "cache" };
    }

    const localTranslation = String(resolveFastLocalTranslation({ language, translationInput, direction }) || "").trim();
    if (
      isTranslationDisplayable({
        text: localTranslation,
        sourceText: translationInput,
        sourceLang: direction.source,
        targetLang: language,
        provider: "local"
      })
    ) {
      noteTranslationSuccess(language, localTranslation, languageTranslationContext);
      rememberCachedTranslation(translationCache, cacheKey, localTranslation, {
        source: direction.source,
        target: language,
        sourceText: translationInput,
        provider: "local"
      });
      return { text: localTranslation, provider: "local" };
    }

    const source = normalizeInterpreterLanguageCode(direction.source);
    const target = normalizeInterpreterLanguageCode(language);
    return {
      text: "",
      provider: "local-miss",
      needsProviderFallback: Boolean(source && target && source !== target)
    };
  };

  const translateLocalFallbackLanguage = ({ language, translationInput, direction, translationContext }) => {
    const languageTranslationContext = languageTranslationContextFor(language, translationContext);
    const fallbackText = String(resolveFastLocalTranslation({ language, translationInput, direction }) || "").trim();

    if (
      isTranslationDisplayable({
        text: fallbackText,
        sourceText: translationInput,
        sourceLang: direction.source,
        targetLang: language,
        provider: "local-fallback"
      })
    ) {
      noteTranslationSuccess(language, fallbackText, languageTranslationContext);
      return { text: fallbackText, provider: "local-fallback" };
    }

    return { text: "", provider: "local-fallback" };
  };

  const providerRunner = (provider) => (provider === "gemini" ? translateWithGemini : translateWithOpenAI);

  const runProviderTranslationAttempt = async ({ provider, language, translationInput, direction, languageTranslationContext, jobId }) => {
    if (staleTranslationJobs.has(jobId)) {
      return {
        provider,
        stale: true,
        error: new Error("Translation job became stale")
      };
    }

    await delay(TRANSLATION_RATE_LIMIT_DELAY_MS);
    if (staleTranslationJobs.has(jobId)) {
      return {
        provider,
        stale: true,
        error: new Error("Translation job became stale")
      };
    }

    const providerName = provider === "gemini" ? "Gemini" : "OpenAI";
    const attemptStartedAt = Date.now();
    const timeoutMs = PROVIDER_TIMEOUT_MS[provider] || 3000;
    const abortController = typeof AbortController !== "undefined" ? new AbortController() : null;
    const unregisterAbortController = trackProviderAbortController(jobId, abortController);
    sessionTranslationQueue.currentAbortController = abortController;
    try {
      logTranslationEvent("TRANSLATION_REQUEST", {
        sessionId,
        jobId,
        provider,
        sourceLang: direction.source,
        targetLang: language,
        chars: translationInput.length
      });
      const translatedText = await withTimeout(
        providerRunner(provider)({
          apiKey: provider === "gemini" ? env.geminiApiKey : env.openaiApiKey,
          text: translationInput,
          sourceLang: sourceLanguageForProvider(direction.source),
          targetLang: language,
          translationContext: languageTranslationContext,
          signal: abortController?.signal
        }),
        timeoutMs,
        `${providerName} translation timed out for ${language}`
      ).finally(() => {
        abortController?.abort();
        unregisterAbortController();
        if (sessionTranslationQueue.currentAbortController === abortController) {
          sessionTranslationQueue.currentAbortController = null;
        }
      });
      const responseTimeMs = Date.now() - attemptStartedAt;
      rememberProviderLatency(provider, responseTimeMs);
      const safeTranslatedText = String(translatedText || "").trim();

      if (staleTranslationJobs.has(jobId)) {
        return {
          provider,
          stale: true,
          responseTimeMs,
          error: new Error("Translation job became stale")
        };
      }

      if (
        safeTranslatedText &&
        isTranslationDisplayable({
          text: safeTranslatedText,
          sourceText: translationInput,
          sourceLang: direction.source,
          targetLang: language,
          provider
        })
      ) {
        trackUsage(provider, 150);
        logTranslationEvent("TRANSLATION_COMPLETE", {
          sessionId,
          jobId,
          provider,
          targetLang: language,
          latencyMs: responseTimeMs,
          chars: safeTranslatedText.length
        });
        return {
          provider,
          translatedText: safeTranslatedText,
          responseTimeMs
        };
      }

      logTranslationEvent("TRANSLATION_FAILED", {
        sessionId,
        jobId,
        provider,
        targetLang: language,
        error: `Invalid ${providerName} translation response`
      }, "warn");
      rememberProviderLatency(provider, responseTimeMs);

      return {
        provider,
        responseTimeMs,
        error: new Error(`Invalid ${providerName} translation response for ${language}`)
      };
    } catch (error) {
      abortController?.abort();
      unregisterAbortController();
      if (sessionTranslationQueue.currentAbortController === abortController) {
        sessionTranslationQueue.currentAbortController = null;
      }
      const responseTimeMs = Date.now() - attemptStartedAt;
      const timedOut = /timed out|timeout/i.test(error?.message || "");
      if (timedOut) translationMetrics.timeoutCount += 1;
      rememberProviderLatency(provider, responseTimeMs);
      logTranslationEvent("TRANSLATION_FAILED", {
        sessionId,
        jobId,
        provider,
        targetLang: language,
        timeoutMs,
        error: error?.message || String(error)
      }, "warn");
      return {
        provider,
        error,
        timedOut,
        responseTimeMs
      };
    }
  };

  const translateProviderLanguageWithRecovery = async ({ language, translationInput, direction, translationContext, jobId }) => {
    let lastError = null;
    const languageTranslationContext = languageTranslationContextFor(language, translationContext);
    const cacheKey = translationCacheKey({ source: direction.source, target: language, text: translationInput });
    const cachedTranslation = readCachedTranslation(translationCache, cacheKey, {
      source: direction.source,
      target: language,
      sourceText: translationInput,
      provider: "cache"
    });

    if (cachedTranslation) {
      noteTranslationSuccess(language, cachedTranslation, languageTranslationContext);
      return { text: cachedTranslation, provider: "cache" };
    }

    refreshProviderCooldowns();
    const providerOrder = [
      ...getHealthyProviders()
    ];
    logTranslationEvent("PROVIDER_SELECTION", {
      sessionId,
      jobId,
      targetLang: language,
      provider: providerOrder.join(",") || "none",
      preferredProvider,
      userPlan
    });

    if (providerOrder.length === 0) {
      logTranslationEvent("TRANSLATION_FAILED", {
        sessionId,
        jobId,
        targetLang: language,
        error: "No healthy translation providers available"
      }, "warn");
    }

    const consumeProviderResult = (result) => {
      if (!result) return "";
      if (result.stale) {
        lastError = result.error;
        return "";
      }

      if (
        result.translatedText &&
        isTranslationDisplayable({
          text: result.translatedText,
          sourceText: translationInput,
          sourceLang: direction.source,
          targetLang: language,
          provider: result.provider
        })
      ) {
        noteProviderSuccess(result.provider);
        noteTranslationSuccess(language, result.translatedText, languageTranslationContext);
        rememberCachedTranslation(translationCache, cacheKey, result.translatedText, {
          source: direction.source,
          target: language,
          sourceText: translationInput,
          provider: result.provider
        });
        return { text: result.translatedText, provider: result.provider };
      }

      lastError = result.error || new Error(`${result.provider || "Provider"} did not return a valid ${language} translation`);
      if (result.provider) noteProviderFailure(result.provider, lastError);
      return { text: "", provider: result.provider };
    };

    for (const provider of providerOrder) {
      for (let attempt = 0; attempt <= MAX_PROVIDER_RETRY_ATTEMPTS; attempt += 1) {
        if (staleTranslationJobs.has(jobId)) break;

        if (attempt > 0) {
          translationMetrics.retryCount += 1;
          setTranslationLanguageStatus(translationJobs.get(jobId), language, "retrying");
          logTranslationEvent("PROVIDER_RETRY", {
            sessionId,
            jobId,
            provider,
            targetLang: language,
            attempt: attempt + 1
          }, "warn");
          await delay(PROVIDER_RETRY_DELAY_MS * attempt);
          if (staleTranslationJobs.has(jobId)) break;
        }

        const result = await runProviderTranslationAttempt({
          provider,
          language,
          translationInput,
          direction,
          languageTranslationContext,
          jobId
        });
        if (result?.stale) {
          lastError = result.error;
          return { text: "", provider, stale: true };
        }

        const translatedText = consumeProviderResult(result);
        if (translatedText?.text) return translatedText;

        const retryable = Boolean(result?.timedOut || (result?.error && isRetryableProviderError(result.error)));
        if (!retryable) break;
      }

      logTranslationEvent("PROVIDER_FALLBACK", {
        sessionId,
        jobId,
        provider,
        targetLang: language,
        nextProvider: providerOrder[providerOrder.indexOf(provider) + 1] || "none",
        error: lastError?.message || lastError
      }, "warn");
    }

    noteTranslationFailure(language, lastError);
    return { text: "", provider: providerOrder[providerOrder.length - 1] || "provider" };
  };

  const translationTaskKey = (jobId, language) => `${jobId}:${language}`;
  const allTranslationLanes = () => Object.values(translationLanes);

  const removeTranslationJob = (jobId) => {
    for (const lane of allTranslationLanes()) {
      for (let index = lane.queue.length - 1; index >= 0; index -= 1) {
        if (lane.queue[index]?.jobId === jobId) lane.queue.splice(index, 1);
      }

      for (const [taskKey, task] of lane.activeTasks.entries()) {
        if (task.jobId === jobId) lane.activeTasks.delete(taskKey);
      }
    }

    translationJobs.delete(jobId);
  };

  const markTranslationJobStale = (job, reason) => {
    if (!job || job.stale) return;

    job.stale = true;
    job.cancelled = true;
    job.activeLanguage = null;
    job.activeLanguageStartedAt = 0;
    staleTranslationJobs.add(job.id);
    job.pendingLanguages.clear();
    job.runningLanguages.clear();
    for (const language of job.direction?.targets || []) {
      if (!job.translations?.[language]) {
        setTranslationLanguageStatus(job, language, reason === "newer_final_transcript" ? "stale" : "cancelled");
      }
      activeTranslationLanguageLocks.delete(language);
    }
    abortProviderRequestsForJob(job.id);
    removeTranslationJob(job.id);
    if (activeSequentialTranslationJob?.id === job.id) {
      activeSequentialTranslationJob = null;
    }
    if (sessionTranslationQueue.activeJob?.id === job.id) {
      sessionTranslationQueue.activeJob = null;
    }

    logTranslationEvent("JOB_CANCEL", {
      sessionId,
      sequence: job.sequence,
      language: job.activeLanguage || job.direction?.targets?.join(",") || "all",
      provider: "queue",
      latency: Date.now() - (job.startedAt || job.createdAt || Date.now()),
      jobId: job.id,
      sourceLang: job.direction?.source,
      targetLanguages: job.direction?.targets,
      reason
    }, "warn");
    logTranslationEvent("TRANSLATION_STALE", {
      sessionId,
      jobId: job.id,
      sourceLang: job.direction?.source,
      targetLanguages: job.direction?.targets,
      reason
    }, "warn");
    trimStaleTranslationJobs();

    void reason;
  };

  const discardQueuedTranslationTask = (lane, task, reason) => {
    if (!task || task.stale) return;

    task.stale = true;
    const { job, language } = task;

    if (job && !job.stale && !staleTranslationJobs.has(job.id)) {
      markTranslationLanguageFailed(job, language, reason, "queue");
    }

    void reason;

    finalizeTranslationJobIfReady(job);
  };

  const pruneTranslationLaneQueue = (lane) => {
    while (lane.queue.length > lane.maxQueueSize) {
      const newestIndex = lane.queue.length - 1;
      let dropIndex = lane.queue.findIndex(
        (task, index) => index < newestIndex && task.job?.runningLanguages?.size === 0 && !task.job?.isFinalizedSentence
      );

      if (dropIndex < 0) {
        dropIndex = lane.queue.findIndex((task, index) => index < newestIndex && task.job?.runningLanguages?.size === 0);
      }

      if (dropIndex < 0) dropIndex = 0;

      const [droppedTask] = lane.queue.splice(dropIndex, 1);
      discardQueuedTranslationTask(lane, droppedTask, "lane_queue_overflow");
    }
  };

  const translationOutputsForTranslations = (direction, translations = {}) =>
    direction.targets
      .map((language) => {
        const text = translations[language];
        return text ? { lang: language, text } : null;
      })
      .filter(Boolean);

  const translationOutputsForJob = (job) =>
    translationOutputsForTranslations(job.direction, job.translations);

  const setTranslationLanguageStatus = (job, language, status) => {
    if (!job?.languageStatuses || !language) return;
    job.languageStatuses[language] = status;
    if (status === "failed") job.failedLanguages?.add?.(language);
    if (status === "translated") job.failedLanguages?.delete?.(language);
  };

  const translationStatusForJob = (job) => {
    const statuses = {};

    for (const language of job.direction.targets.slice(0, MAX_TARGET_LANGUAGES)) {
      if (job.translations?.[language]) {
        statuses[language] = "translated";
      } else if (job.failedLanguages?.has?.(language)) {
        statuses[language] = "failed";
      } else if (job.languageStatuses?.[language]) {
        statuses[language] = job.languageStatuses[language];
      } else if (job.runningLanguages?.has?.(language)) {
        statuses[language] = "processing";
      } else if (job.pendingLanguages?.has?.(language)) {
        statuses[language] = "queued";
      }
    }

    return statuses;
  };

  const failedLanguagesForJob = (job) => [...(job.failedLanguages || new Set())];

  const emitTranslationStatusUpdate = (job, language, status, provider = "queue") => {
    if (!job || job.stale || staleTranslationJobs.has(job.id)) return;
    setTranslationLanguageStatus(job, language, status);

    onResult?.({
      original: job.sentence,
      originalText: job.sentence,
      ...createTranslationPayloadMetadata(job),
      translatedText: job.translations[language] || "",
      translations: { ...job.translations },
      translationOutputs: translationOutputsForJob(job),
      translationStatus: translationStatusForJob(job),
      failedLanguages: failedLanguagesForJob(job),
      lang: language,
      status,
      isFinal: true,
      isTranslationPartial: true,
      translationComplete: false,
      sourceLang: job.direction.source,
      targetLang: job.direction.target,
      targetLanguages: job.direction.targets,
      detectedLanguage: job.detectedLanguage,
      latencyMs: Date.now() - job.startedAt,
      provider,
      mode: "production"
    });
    logTranslationEvent("LANGUAGE_EMIT", {
      sessionId,
      sequence: job.sequence,
      language,
      jobId: job.id,
      sourceLang: job.direction.source,
      targetLang: language,
      provider,
      status,
      latency: Date.now() - job.startedAt
    });
  };

  const markTranslationLanguageFailed = (job, language, reason = "failed", provider = "queue") => {
    if (!job || !language || job.translations?.[language]) return;
    job.pendingLanguages?.delete?.(language);
    job.runningLanguages?.delete?.(language);
    job.completedLanguages?.add?.(language);
    setTranslationLanguageStatus(job, language, "failed");
    translationMetrics.failedCount += 1;
    logTranslationMetrics("language_failed", {
      jobId: job.id,
      targetLang: language,
      reason
    });
    logTranslationEvent("TRANSLATION_FAILED", {
      sessionId,
      jobId: job.id,
      sourceLang: job.direction?.source,
      targetLang: language,
      completedLanguages: [...(job.completedLanguages || new Set())],
      remainingLanguages: [...(job.pendingLanguages || new Set()), ...(job.runningLanguages || new Set())],
      provider,
      latencyMs: Date.now() - job.startedAt,
      error: reason
    }, "warn");
    emitTranslationStatusUpdate(job, language, "failed", provider);
  };

  const emitStreamingProviderPreviewForLanguage = ({ previewId, cleanSentence, translationInput, direction, detectedLanguage, language }) => {
    const providers = getHealthyProviders();
    if (providers.length === 0) return;

    const languageTranslationContext = languageTranslationContextFor(
      language,
      buildTranslationContext({ sentence: cleanSentence, direction, detectedLanguage })
    );

    logTranslationEvent("STREAMING_PREVIEW_REQUEST", {
      sessionId,
      previewId,
      sourceLang: direction.source,
      targetLang: language,
      provider: providers.join(","),
      chars: translationInput.length,
      text: cleanSentence
    });

    void (async () => {
      for (const provider of providers) {
        const result = await runProviderTranslationAttempt({
          provider,
          language,
          translationInput,
          direction,
          languageTranslationContext,
          jobId: `preview-${previewId}-${language}`
        });

        if (previewId !== providerStreamingPreviewSequence || result?.stale) return;

        const safeTranslatedText = cleanTranscriptText(result?.translatedText || "");
        if (
          safeTranslatedText &&
          isTranslationDisplayable({
            text: safeTranslatedText,
            sourceText: translationInput,
            sourceLang: direction.source,
            targetLang: language,
            provider: result.provider
          })
        ) {
          noteProviderSuccess(result.provider);
          noteTranslationSuccess(language, safeTranslatedText, languageTranslationContext);
          rememberCachedTranslation(
            translationCache,
            translationCacheKey({ source: direction.source, target: language, text: translationInput }),
            safeTranslatedText,
            {
              source: direction.source,
              target: language,
              sourceText: translationInput,
              provider: result.provider
            }
          );

          onResult?.({
            original: cleanSentence,
            originalText: cleanSentence,
            ...createTranslationPayloadMetadata(),
            translatedText: safeTranslatedText,
            translations: { [language]: safeTranslatedText },
            translationOutputs: translationOutputsForTranslations(direction, { [language]: safeTranslatedText }),
            translationStatus: { [language]: "translated" },
            failedLanguages: [],
            lang: language,
            status: "translated",
            isFinal: true,
            isTranslationPartial: true,
            isStreamingPreview: true,
            translationComplete: false,
            sourceLang: direction.source,
            targetLang: direction.target,
            targetLanguages: direction.targets,
            detectedLanguage,
            latencyMs: result.responseTimeMs || 0,
            provider: result.provider || provider,
            mode: "production"
          });
          return;
        }

        if (result?.error && isProviderNonRetryableFailure(result.error)) {
          noteProviderFailure(provider, result.error);
          break;
        }
      }

      logTranslationEvent("STREAMING_PREVIEW_SKIPPED", {
        sessionId,
        previewId,
        targetLang: language,
        reason: "no_displayable_preview"
      }, "warn");
    })();
  };

  const emitStreamingTranslationPreview = ({ sentence = "", direction, detectedLanguage }) => {
    if (!shouldTranslate || !direction?.targets?.length) return;

    const cleanSentence = cleanTranscriptText(sentence);
    if (!cleanSentence || !hasMeaningfulTranslationText(cleanSentence)) return;

    const now = Date.now();
    if (now - lastStreamingPreviewAt < PARTIAL_TRANSLATION_PREVIEW_THROTTLE_MS) return;

    const translationInput = prepareTextForTranslation(cleanSentence);
    const translations = {};

    for (const language of direction.targets.slice(0, MAX_TARGET_LANGUAGES)) {
      const cacheKey = translationCacheKey({ source: direction.source, target: language, text: translationInput });
      const cachedTranslation = readCachedTranslation(translationCache, cacheKey, {
        source: direction.source,
        target: language,
        sourceText: translationInput,
        provider: "cache"
      });
      const laneGroup = translationLaneForLanguage({ sourceLang: direction.source, targetLang: language });
      let translatedText = cachedTranslation;

      if (!translatedText && laneGroup === TRANSLATION_LANE_FAST_LOCAL) {
        translatedText = resolveFastLocalTranslation({ language, translationInput, direction });
      }

      if (
        isTranslationDisplayable({
          text: translatedText,
          sourceText: translationInput,
          sourceLang: direction.source,
          targetLang: language,
          provider: laneGroup === TRANSLATION_LANE_FAST_LOCAL ? "local" : "cache"
        })
      ) {
        translations[language] = cleanTranscriptText(translatedText);
      }
    }

    const translatedText = translations[direction.target] || Object.values(translations).find(Boolean) || "";
    const signature = `${normalizeTranscript(cleanSentence)}|${JSON.stringify(translations)}`;
    if (translatedText && signature !== lastStreamingPreviewSignature) {
      lastStreamingPreviewAt = now;
      lastStreamingPreviewSignature = signature;

      onResult?.({
        original: cleanSentence,
        originalText: cleanSentence,
        ...createTranslationPayloadMetadata(),
        translatedText,
        translations,
        translationOutputs: translationOutputsForTranslations(direction, translations),
        isFinal: true,
        isTranslationPartial: true,
        isStreamingPreview: true,
        translationComplete: false,
        sourceLang: direction.source,
        targetLang: direction.target,
        targetLanguages: direction.targets,
        detectedLanguage,
        latencyMs: 0,
        provider: "stream",
        mode: "production"
      });
    }

    const missingLanguages = direction.targets
      .slice(0, MAX_TARGET_LANGUAGES)
      .filter((language) => !translations[language]);
    const providerPreviewReady =
      missingLanguages.length > 0 &&
      cleanSentence.length >= PROVIDER_STREAMING_PREVIEW_MIN_CHARS &&
      wordCount(cleanSentence) >= PROVIDER_STREAMING_PREVIEW_MIN_WORDS;
    const providerSignature = `${normalizeTranscript(cleanSentence)}|${missingLanguages.join(",")}`;

    if (
      providerPreviewReady &&
      providerSignature !== lastProviderStreamingPreviewSignature &&
      now - lastProviderStreamingPreviewAt >= PROVIDER_STREAMING_PREVIEW_THROTTLE_MS
    ) {
      lastProviderStreamingPreviewAt = now;
      lastProviderStreamingPreviewSignature = providerSignature;
      providerStreamingPreviewSequence += 1;
      const previewId = providerStreamingPreviewSequence;

      onResult?.({
        original: cleanSentence,
        originalText: cleanSentence,
        ...createTranslationPayloadMetadata(),
        translatedText: "",
        translations: {},
        translationOutputs: [],
        translationStatus: Object.fromEntries(missingLanguages.map((language) => [language, "processing"])),
        failedLanguages: [],
        isFinal: true,
        isTranslationPartial: true,
        isStreamingPreview: true,
        translationComplete: false,
        sourceLang: direction.source,
        targetLang: direction.target,
        targetLanguages: direction.targets,
        detectedLanguage,
        latencyMs: 0,
        provider: "stream",
        mode: "production"
      });

      for (const language of missingLanguages) {
        emitStreamingProviderPreviewForLanguage({
          previewId,
          cleanSentence,
          translationInput,
          direction,
          detectedLanguage,
          language
        });
      }
    }
  };

  const rememberTranscriptEntry = (job, translatedText) => {
    if (!translatedText) return;

    const transcriptEntry = {
      original: job.sentence,
      translated: translatedText,
      translations: { ...job.translations },
      timestamp: new Date(),
      sourceLang: job.direction.source,
      targetLang: job.direction.target,
      targetLanguages: job.direction.targets
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
  };

  const emitTranslationUpdate = (job, language, translatedText, provider) => {
    if (!translatedText || job.stale || staleTranslationJobs.has(job.id)) return false;
    const safeTranslatedText = cleanTranscriptText(translatedText);
    if (
      !isTranslationDisplayable({
        text: safeTranslatedText,
        sourceText: job.translationInput,
        sourceLang: job.direction.source,
        targetLang: language,
        provider
      })
    ) {
      return false;
    }

    job.translations[language] = safeTranslatedText;
    job.lastProviderUsed = provider;
    setTranslationLanguageStatus(job, language, "translated");
    const translationOutputs = translationOutputsForJob(job);
    translationMetrics.completedCount += 1;

    logTranslationEvent("TRANSLATION_SUCCESS", {
      jobId: job.id,
      provider,
      sourceLang: job.direction.source,
      targetLang: language,
      latencyMs: Date.now() - job.startedAt,
      text: safeTranslatedText
    });

    onResult?.({
      original: job.sentence,
      originalText: job.sentence,
      ...createTranslationPayloadMetadata(job),
      translatedText: safeTranslatedText,
      translations: { ...job.translations },
      translationOutputs,
      translationStatus: translationStatusForJob(job),
      failedLanguages: failedLanguagesForJob(job),
      lang: language,
      status: "translated",
      isFinal: true,
      isTranslationPartial: true,
      translationComplete: false,
      sourceLang: job.direction.source,
      targetLang: job.direction.target,
      targetLanguages: job.direction.targets,
      detectedLanguage: job.detectedLanguage,
      latencyMs: Date.now() - job.startedAt,
      provider,
      mode: "production"
    });
    logTranslationEvent("LANGUAGE_EMIT", {
      sessionId,
      sequence: job.sequence,
      language,
      jobId: job.id,
      sourceLang: job.direction.source,
      targetLang: language,
      provider,
      status: "translated",
      latency: Date.now() - job.startedAt
    });
    return true;
  };

  const finalizeTranslationJobIfReady = (job) => {
    if (!job || job.completed || job.stale || staleTranslationJobs.has(job.id)) return;
    if (job.pendingLanguages.size > 0 || job.runningLanguages.size > 0) return;

    job.completed = true;
    removeTranslationJob(job.id);
    staleTranslationJobs.delete(job.id);
    trimStaleTranslationJobs();

    const translatedText = job.translations[job.direction.target] || Object.values(job.translations).find(Boolean) || "";
    const provider = job.lastProviderUsed || "unknown";
    lastTranslatedTranscript = job.normalizedSentence;

    if (translatedText) {
      rememberTranscriptEntry(job, translatedText);
    } else if (job.shouldTranslate) {
      translationMetrics.failedCount += 1;
      logTranslationEvent("TRANSLATION_FAILED", {
        jobId: job.id,
        sourceLang: job.direction.source,
        targetLanguages: job.direction.targets,
        error: "Translation job completed without displayable output"
      }, "warn");
    }

    onResult?.({
      original: job.sentence,
      originalText: job.sentence,
      ...createTranslationPayloadMetadata(job),
      translatedText,
      translations: { ...job.translations },
      translationOutputs: translationOutputsForJob(job),
      translationStatus: translationStatusForJob(job),
      failedLanguages: failedLanguagesForJob(job),
      isFinal: true,
      isTranslationComplete: job.shouldTranslate,
      sourceLang: job.direction.source,
      targetLang: job.direction.target,
      targetLanguages: job.direction.targets,
      detectedLanguage: job.detectedLanguage,
      latencyMs: Date.now() - job.startedAt,
      provider,
      mode: "production"
    });
    logTranslationEvent("TRANSLATION_EMIT", {
      sessionId,
      jobId: job.id,
      sourceLang: job.direction.source,
      targetLanguages: job.direction.targets,
      provider,
      status: translatedText ? "translated" : "failed",
      latencyMs: Date.now() - job.startedAt
    });
    logTranslationMetrics("job_finalized", {
      jobId: job.id,
      durationMs: Date.now() - job.createdAt,
      targetLanguages: job.direction.targets
    });
  };

  const scheduleTranslationLaneDrain = (lane) => {
    if (!lane || lane.drainScheduled) return;
    lane.drainScheduled = true;

    setTimeout(() => {
      lane.drainScheduled = false;
      drainTranslationLane(lane);
    }, 0).unref?.();
  };

  const scheduleTranslationDrain = (laneId) => {
    if (laneId) {
      scheduleTranslationLaneDrain(translationLanes[laneId]);
      return;
    }

    for (const lane of allTranslationLanes()) {
      scheduleTranslationLaneDrain(lane);
    }
  };

  const finishTranslationTask = (lane, job, language, taskKey, options = {}) => {
    const activeTask = lane.activeTasks.get(taskKey);
    if (!activeTask) return false;

    updateLaneLatency(lane, Date.now() - activeTask.startedAt);
    lane.activeTasks.delete(taskKey);
    job.runningLanguages.delete(language);
    if (options.completeLanguage !== false) job.completedLanguages.add(language);
    return true;
  };

  const queueProviderFallbackTranslation = (job, language) => {
    if (!job || job.stale || job.completed || staleTranslationJobs.has(job.id)) return false;
    if (job.translations?.[language] || job.runningLanguages.has(language) || job.pendingLanguages.has(language)) return false;
    if (job.providerFallbackLanguages?.has(language)) return false;
    if (getHealthyProviders().length === 0) return false;

    job.providerFallbackLanguages?.add(language);
    job.pendingLanguages.add(language);
    setTranslationLanguageStatus(job, language, "retrying");
    emitTranslationStatusUpdate(job, language, "retrying", "provider-fallback");

    const lane = getProviderFallbackLane(language);
    lane.queue.push({
      id: `${translationTaskKey(job.id, language)}:providerFallback`,
      jobId: job.id,
      job,
      language,
      laneId: lane.id,
      createdAt: Date.now(),
      startedAt: 0,
      stale: false,
      fallbackFromLocal: true
    });

    pruneTranslationLaneQueue(lane);
    scheduleTranslationDrain(lane.id);
    return true;
  };

  const queueProviderRetryTranslation = (job, language) => {
    if (!job || job.stale || job.completed || staleTranslationJobs.has(job.id)) return false;
    if (job.translations?.[language] || job.runningLanguages.has(language) || job.pendingLanguages.has(language)) return false;
    if (getHealthyProviders().length === 0) return false;

    const retryAttempts = job.providerRetryAttempts || new Map();
    job.providerRetryAttempts = retryAttempts;
    const attempt = retryAttempts.get(language) || 0;
    if (attempt >= MAX_PROVIDER_RETRY_ATTEMPTS) return false;

    retryAttempts.set(language, attempt + 1);
    translationMetrics.retryCount += 1;
    job.pendingLanguages.add(language);
    setTranslationLanguageStatus(job, language, "retrying");
    emitTranslationStatusUpdate(job, language, "retrying", "retry");

    const retryTimer = setTimeout(() => {
      backgroundRetryTimers.delete(retryTimer);

      if (job.stale || job.completed || staleTranslationJobs.has(job.id) || job.translations?.[language]) {
        job.pendingLanguages.delete(language);
        finalizeTranslationJobIfReady(job);
        return;
      }

      const lane = getProviderFallbackLane(language);
      lane.queue.push({
        id: `${translationTaskKey(job.id, language)}:providerRetry:${attempt + 1}`,
        jobId: job.id,
        job,
        language,
        laneId: lane.id,
        createdAt: Date.now(),
        startedAt: 0,
        stale: false,
        retryAttempt: attempt + 1
      });

      pruneTranslationLaneQueue(lane);
      scheduleTranslationDrain(lane.id);
    }, PROVIDER_RETRY_DELAY_MS * (attempt + 1));
    retryTimer.unref?.();
    backgroundRetryTimers.add(retryTimer);

    return true;
  };

  const startTranslationTask = (lane, task) => {
    const { job, language } = task;
    const taskKey = task.id;
    if (!job || job.stale || staleTranslationJobs.has(job.id)) return;
    if (lane.activeTasks.has(taskKey) || job.runningLanguages.has(language) || job.completedLanguages.has(language)) return;
    if (!job.pendingLanguages.has(language)) return;

    job.startedAt = job.startedAt || Date.now();
    job.pendingLanguages.delete(language);
    job.runningLanguages.add(language);
    task.startedAt = Date.now();
    lane.activeTasks.set(taskKey, {
      ...task,
      jobId: job.id,
      language,
      startedAt: task.startedAt
    });
    emitTranslationStatusUpdate(job, language, "processing", lane.group);

    void (async () => {
      let result = null;
      const translateInLane =
        lane.group === TRANSLATION_LANE_FAST_LOCAL ? translateFastLocalLanguage : translateProviderLanguageWithRecovery;

      try {
        result = await translateInLane({
          language,
          translationInput: job.translationInput,
          direction: job.direction,
          translationContext: job.translationContext,
          jobId: job.id
        });
      } catch (error) {
        if (lane.group === TRANSLATION_LANE_PROVIDER) noteTranslationFailure(language, error);
      }

      const translatedText = result?.text || "";
      const provider = result?.provider || (lane.group === TRANSLATION_LANE_FAST_LOCAL ? "local" : "unknown");
      const needsProviderFallback = Boolean(result?.needsProviderFallback);
      const safeTranslatedText = cleanTranscriptText(translatedText);
      const hasValidTranslation = Boolean(
        safeTranslatedText &&
          isTranslationDisplayable({
            text: safeTranslatedText,
            sourceText: job.translationInput,
            sourceLang: job.direction.source,
            targetLang: language,
            provider
          })
      );
      job.lastProviderUsed = provider;

      if (
        !finishTranslationTask(lane, job, language, taskKey, {
          completeLanguage:
            hasValidTranslation ||
            (lane.group !== TRANSLATION_LANE_PROVIDER &&
              !(lane.group === TRANSLATION_LANE_FAST_LOCAL && needsProviderFallback))
        })
      ) {
        scheduleTranslationDrain(lane.id);
        return;
      }

      if (!job.stale && !staleTranslationJobs.has(job.id)) {
        if (hasValidTranslation) {
          emitTranslationUpdate(job, language, safeTranslatedText, provider);
        } else if (needsProviderFallback && lane.group === TRANSLATION_LANE_FAST_LOCAL) {
          if (!queueProviderFallbackTranslation(job, language)) {
            markTranslationLanguageFailed(job, language, "provider_fallback_unavailable", provider);
          }
        } else if (lane.group === TRANSLATION_LANE_PROVIDER) {
          if (!queueProviderRetryTranslation(job, language)) {
            markTranslationLanguageFailed(job, language, "provider_failed", provider);
          }
        } else {
          markTranslationLanguageFailed(job, language, "local_failed", provider);
        }

        finalizeTranslationJobIfReady(job);
      }

      scheduleTranslationDrain(lane.id);
    })();
  };

  const nextTranslationTask = (lane) => {
    while (lane.queue.length > 0) {
      const task = lane.queue.shift();
      const { job, language } = task;

      if (task.stale || !job || job.stale || job.completed || staleTranslationJobs.has(job.id)) continue;
      if (job.completedLanguages.has(language) || job.runningLanguages.has(language) || !job.pendingLanguages.has(language)) {
        finalizeTranslationJobIfReady(job);
        continue;
      }

      return task;
    }

    return null;
  };

  const cleanupStaleTranslationWork = (laneToClean) => {
    const now = Date.now();
    const lanes = laneToClean ? [laneToClean] : allTranslationLanes();

    for (const job of [...translationJobs.values()]) {
      if (!job || job.completed || job.stale || staleTranslationJobs.has(job.id)) continue;
      const isActiveFifoJob = sessionTranslationQueue.activeJob?.id === job.id || activeSequentialTranslationJob?.id === job.id;
      const isQueuedInSessionFifo = sessionTranslationQueue.queue.some((queuedJob) => queuedJob?.id === job.id);
      const isWaitingBehindActiveFifoJob = isQueuedInSessionFifo && Boolean(sessionTranslationQueue.activeJob || activeSequentialTranslationJob);
      const activeAge = now - (job.activeLanguageStartedAt || job.startedAt || job.createdAt || now);

      const queuedTooLong =
        job.pendingLanguages?.size > 0 &&
        job.runningLanguages?.size === 0 &&
        !isActiveFifoJob &&
        !isWaitingBehindActiveFifoJob &&
        now - (job.createdAt || now) > QUEUED_JOB_TIMEOUT;
      const processingTimeoutMs = isActiveFifoJob ? SEQUENTIAL_JOB_HARD_TIMEOUT : PROCESSING_JOB_TIMEOUT;
      const processingTooLong =
        job.runningLanguages?.size > 0 &&
        activeAge > processingTimeoutMs;

      if (queuedTooLong || processingTooLong) {
        markTranslationJobStale(job, queuedTooLong ? "queued_too_long" : "processing_timeout");
      }
    }

    for (const lane of lanes) {
      for (const [taskKey, task] of lane.activeTasks.entries()) {
        if (now - task.startedAt < PROCESSING_JOB_TIMEOUT) continue;

        const job = task.job || translationJobs.get(task.jobId);
        lane.activeTasks.delete(taskKey);
        task.stale = true;

        if (job) {
          logTranslationEvent("LANGUAGE_TIMEOUT", {
            sessionId,
            jobId: task.jobId,
            language: task.language,
            provider: lane.group,
            latency: now - task.startedAt,
            preservedTranslations: Object.keys(job.translations || {})
          }, "warn");
          markTranslationLanguageFailed(job, task.language, "processing_timeout", lane.group);
          if (lane.group === TRANSLATION_LANE_PROVIDER) noteTranslationFailure(task.language, new Error("Translation task became stale"));
          finalizeTranslationJobIfReady(job);
        }

      }

      for (let index = lane.queue.length - 1; index >= 0; index -= 1) {
        const task = lane.queue[index];
        if (!task?.createdAt || now - task.createdAt < QUEUED_JOB_TIMEOUT) continue;

        lane.queue.splice(index, 1);
        logTranslationEvent("LANE_QUEUE_TIMEOUT", {
          sessionId,
          lane: lane.id,
          jobId: task.jobId,
          language: task.language,
          latency: now - task.createdAt
        }, "warn");
        discardQueuedTranslationTask(lane, task, "queued_too_long");
      }
    }
  };

  function drainTranslationLane(lane) {
    cleanupStaleTranslationWork(lane);
    if (lane.group === TRANSLATION_LANE_PROVIDER) refreshProviderCooldowns();
    pruneTranslationLaneQueue(lane);

    while (lane.activeTasks.size < lane.maxActive) {
      const nextTask = nextTranslationTask(lane);
      if (!nextTask) break;
      startTranslationTask(lane, nextTask);
    }
  }

  function drainTranslationQueue() {
    for (const lane of allTranslationLanes()) {
      drainTranslationLane(lane);
    }
  }

  const clearPendingTranslationQueue = (reason = "newer_final_transcript", nextJob = null) => {
    const droppedJobs = sessionTranslationQueue.queue.splice(0);
    const pendingCount = droppedJobs.length;
    logTranslationEvent("QUEUE_CLEAR", {
      sessionId,
      sequence: nextJob?.sequence || sessionTranslationQueue.sequence,
      language: nextJob?.direction?.targets?.join(",") || "all",
      provider: "queue",
      latency: 0,
      reason,
      pendingCount
    });

    for (const droppedJob of droppedJobs) {
      if (!droppedJob || droppedJob.id === nextJob?.id || droppedJob.completed || droppedJob.stale) continue;
      markTranslationJobStale(droppedJob, reason);
    }

    for (const retryTimer of backgroundRetryTimers) {
      clearTimeout(retryTimer);
    }
    backgroundRetryTimers.clear();
  };

  const pruneSessionTranslationQueue = (reason = "session_queue_overflow", nextJob = null) => {
    const droppedJobs = [];

    while (sessionTranslationQueue.queue.length > MAX_SESSION_TRANSLATION_QUEUE_SIZE) {
      const droppedJob = sessionTranslationQueue.queue.shift();
      if (droppedJob) droppedJobs.push(droppedJob);
    }

    if (droppedJobs.length === 0) return;

    logTranslationEvent("QUEUE_CLEAR", {
      sessionId,
      sequence: nextJob?.sequence || sessionTranslationQueue.sequence,
      language: nextJob?.direction?.targets?.join(",") || "all",
      provider: "queue",
      latency: 0,
      reason,
      pendingCount: droppedJobs.length
    }, "warn");

    for (const droppedJob of droppedJobs) {
      if (!droppedJob || droppedJob.id === nextJob?.id || droppedJob.completed || droppedJob.stale) continue;
      markTranslationJobStale(droppedJob, reason);
    }
  };

  const finishSequentialLanguage = (job, language, status) => {
    job.pendingLanguages?.delete?.(language);
    job.runningLanguages?.delete?.(language);
    activeTranslationLanguageLocks.delete(language);
    job.completedLanguages?.add?.(language);
    if (status) setTranslationLanguageStatus(job, language, status);
  };

  const processSequentialTranslationJob = async (job) => {
    const targetLanguages = job.direction.targets.slice(0, MAX_TARGET_LANGUAGES);

    const processLanguage = async (language) => {
      if (job.stale || job.completed || staleTranslationJobs.has(job.id)) return;
      if (job.translations?.[language] || job.completedLanguages?.has?.(language)) return;

      job.pendingLanguages.delete(language);
      job.runningLanguages.add(language);
      if (!job.activeLanguage) {
        job.activeLanguage = language;
        job.activeLanguageStartedAt = Date.now();
      }
      activeTranslationLanguageLocks.add(language);
      setTranslationLanguageStatus(job, language, "processing");
      logTranslationEvent("LANGUAGE_START", {
        sessionId,
        sequence: job.sequence,
        language,
        provider: "queue",
        latency: 0,
        jobId: job.id
      });

      const languageStartedAt = Date.now();
      let result = null;

      try {
        const englishBridgeText = isLocalBridgeLanguageCode(job.direction.source)
          ? cleanTranscriptText(resolveLocalTranslation({
            text: job.translationInput,
            sourceLang: job.direction.source,
            targetLang: "en"
          }) || "")
          : "";
        const effectiveTranslationInput = englishBridgeText || job.translationInput;
        const effectiveDirection = englishBridgeText
          ? { ...job.direction, source: "en" }
          : job.direction;

        if (englishBridgeText && language === "en") {
          result = { text: englishBridgeText, provider: "local-bridge" };
        }

        const localResult = await translateFastLocalLanguage({
          language,
          translationInput: effectiveTranslationInput,
          direction: effectiveDirection,
          translationContext: job.translationContext,
          jobId: job.id
        });

        if (job.stale || staleTranslationJobs.has(job.id)) return;
        result = result?.text ? result : localResult?.text ? localResult : null;

        if (!result?.text && localResult?.needsProviderFallback !== false) {
          result = await translateProviderLanguageWithRecovery({
            language,
            translationInput: effectiveTranslationInput,
            direction: effectiveDirection,
            translationContext: job.translationContext,
            jobId: job.id
          });
        }

        if (job.stale || staleTranslationJobs.has(job.id) || result?.stale) return;

        const provider = result?.provider || "unknown";
        const translatedText = cleanTranscriptText(result?.text || "");

        if (
          translatedText &&
          isTranslationDisplayable({
            text: translatedText,
            sourceText: job.translationInput,
            sourceLang: job.direction.source,
            targetLang: language,
            provider
          })
        ) {
          finishSequentialLanguage(job, language, "translated");
          emitTranslationUpdate(job, language, translatedText, provider);
          logTranslationEvent("LANGUAGE_SUCCESS", {
            sessionId,
            sequence: job.sequence,
            language,
            provider,
            latency: Date.now() - languageStartedAt,
            jobId: job.id
          });
        } else {
          finishSequentialLanguage(job, language, "failed");
          markTranslationLanguageFailed(job, language, "empty_or_invalid_translation", provider);
          logTranslationEvent("LANGUAGE_FAILED", {
            sessionId,
            sequence: job.sequence,
            language,
            provider,
            latency: Date.now() - languageStartedAt,
            jobId: job.id
          });
        }
      } catch (error) {
        if (!job.stale && !staleTranslationJobs.has(job.id)) {
          noteTranslationFailure(language, error);
          finishSequentialLanguage(job, language, "failed");
          markTranslationLanguageFailed(job, language, error?.message || "translation_failed", "orchestrator");
          logTranslationEvent("LANGUAGE_FAILED", {
            sessionId,
            sequence: job.sequence,
            language,
            provider: "orchestrator",
            latency: Date.now() - languageStartedAt,
            jobId: job.id
          });
        }
      } finally {
        activeTranslationLanguageLocks.delete(language);
        job.runningLanguages.delete(language);
        if (job.activeLanguage === language) {
          job.activeLanguage = null;
          job.activeLanguageStartedAt = 0;
        }
        logTranslationMetrics("language_processed", {
          jobId: job.id,
          targetLang: language,
          durationMs: Date.now() - languageStartedAt
        });
      }
    };

    await Promise.allSettled(targetLanguages.map((language) => processLanguage(language)));

    finalizeTranslationJobIfReady(job);
  };

  const processSessionTranslationQueue = async () => {
    if (sessionTranslationQueue.processing) return;
    sessionTranslationQueue.processing = true;

    try {
      while (sessionTranslationQueue.queue.length > 0) {
        const job = sessionTranslationQueue.queue.shift();
        if (!job || job.stale || job.completed || staleTranslationJobs.has(job.id)) continue;

        sessionTranslationQueue.activeJob = job;
        activeSequentialTranslationJob = job;
        logTranslationEvent("JOB_START", {
          sessionId,
          sequence: job.sequence,
          language: job.direction.targets.join(","),
          provider: "queue",
          latency: Date.now() - (job.createdAt || Date.now()),
          jobId: job.id
        });

        await processSequentialTranslationJob(job);

        if (sessionTranslationQueue.activeJob?.id === job.id) {
          sessionTranslationQueue.activeJob = null;
        }
        if (activeSequentialTranslationJob?.id === job.id) {
          activeSequentialTranslationJob = null;
        }
        logTranslationEvent("QUEUE_NEXT", {
          sessionId,
          sequence: job.sequence,
          language: job.direction.targets.join(","),
          provider: job.lastProviderUsed || "queue",
          latency: Date.now() - job.startedAt,
          remaining: sessionTranslationQueue.queue.length
        });
      }
    } finally {
      sessionTranslationQueue.processing = false;
      sessionTranslationQueue.activeJob = null;
      activeSequentialTranslationJob = null;
      if (sessionTranslationQueue.queue.length > 0) {
        void processSessionTranslationQueue();
      }
    }
  };

  const enqueueTranslationJob = (job) => {
    translationJobs.set(job.id, job);

    for (const language of job.direction.targets.slice(0, MAX_TARGET_LANGUAGES)) {
      setTranslationLanguageStatus(job, language, "queued");
    }

    sessionTranslationQueue.queue.push(job);
    pruneSessionTranslationQueue("session_queue_overflow", job);
    logTranslationEvent("QUEUE_ADD", {
      sessionId,
      sequence: job.sequence,
      language: job.direction.targets.join(","),
      provider: "queue",
      latency: 0,
      jobId: job.id,
      queueLength: sessionTranslationQueue.queue.length
    });
    logTranslationMetrics("job_enqueued", {
      jobId: job.id,
      targetLanguages: job.direction.targets
    });

    void processSessionTranslationQueue().catch((error) => {
      const activeJob = sessionTranslationQueue.activeJob;
      if (!activeJob || activeJob.stale || staleTranslationJobs.has(activeJob.id)) return;
      for (const language of activeJob.direction.targets.slice(0, MAX_TARGET_LANGUAGES)) {
        if (activeJob.translations?.[language] || activeJob.completedLanguages?.has?.(language)) continue;
        markTranslationLanguageFailed(activeJob, language, error?.message || "translation_orchestrator_failed", "orchestrator");
      }
      finalizeTranslationJobIfReady(activeJob);
    });
  };

  const hasQueuedTranslationForSentence = (normalizedSentence) =>
    [...translationJobs.values()].some((job) => !job.stale && !job.completed && job.normalizedSentence === normalizedSentence);

  const emitStableSentence = async () => {
    clearTranslationTimer();
    cleanupStaleTranslationWork();

    const sentence = cleanTranscriptText(currentSentence);
    const normalizedSentence = normalizeTranscript(sentence);
    const baseDirection = { ...currentDirection, targets: [...currentDirection.targets] };
    const detectedLanguage = currentDetectedLanguage;
    currentSentence = "";
    lastInterimTranscript = "";

    if (
      !sentence ||
      !hasMeaningfulTranslationText(sentence) ||
      normalizedSentence === lastTranslatedTranscript ||
      hasQueuedTranslationForSentence(normalizedSentence)
    ) {
      return;
    }

    const localDetection = shouldUseDetectedSourceLanguage({ configuredSourceLang: sourceLang, twoWay })
      ? resolveSourceLanguage({ text: sentence, providerDetectedLanguage: detectedLanguage })
      : { language: sourceLang, confidence: 1, source: "configured" };
    const direction = {
      ...baseDirection,
      source: localDetection.language || baseDirection.source
    };
    const effectiveDetectedLanguage = localDetection.language || detectedLanguage;
    const isFinalizedSentence = sentenceEnds(sentence);
    const looksLikeTinyFragment = wordCount(sentence) <= 1 && !isFinalizedSentence && sentence.length < 4;

    if (looksLikeTinyFragment) {
      return;
    }

    const startedAt = Date.now();
    const jobId = translationJobSequence + 1;
    translationJobSequence = jobId;
    sessionTranslationQueue.sequence += 1;
    const jobSequence = sessionTranslationQueue.sequence;
    const translationInput = prepareTextForTranslation(sentence);
    const translationContext = buildTranslationContext({ sentence, direction, detectedLanguage: effectiveDetectedLanguage });

    if (!shouldTranslate) {
      lastTranslatedTranscript = normalizedSentence;
      onResult?.({
        original: sentence,
        originalText: sentence,
        translatedText: "",
        translations: {},
        translationOutputs: [],
        isFinal: true,
        sourceLang: direction.source,
        targetLang: direction.target,
        targetLanguages: direction.targets,
        detectedLanguage: effectiveDetectedLanguage,
        latencyMs: Date.now() - startedAt,
        mode: "production"
      });
      return;
    }

    const job = {
      id: jobId,
      sequence: jobSequence,
      sentence,
      normalizedSentence,
      translationInput,
      direction,
      detectedLanguage: effectiveDetectedLanguage,
      translationContext,
      translations: {},
      pendingLanguages: new Set(direction.targets.slice(0, MAX_TARGET_LANGUAGES)),
      runningLanguages: new Set(),
      completedLanguages: new Set(),
      failedLanguages: new Set(),
      languageStatuses: Object.fromEntries(direction.targets.slice(0, MAX_TARGET_LANGUAGES).map((language) => [language, "queued"])),
      providerFallbackLanguages: new Set(),
      providerRetryAttempts: new Map(),
      activeLanguage: null,
      activeLanguageStartedAt: 0,
      createdAt: startedAt,
      startedAt,
      completed: false,
      stale: false,
      shouldTranslate,
      isFinalizedSentence
    };

    onResult?.({
      original: sentence,
      originalText: sentence,
      ...createTranslationPayloadMetadata(job),
      translatedText: "",
      translations: {},
      translationOutputs: [],
      isFinal: true,
      isTranscriptOnly: true,
      sourceLang: direction.source,
      targetLang: direction.target,
      targetLanguages: direction.targets,
      detectedLanguage: effectiveDetectedLanguage,
      latencyMs: Date.now() - startedAt,
      mode: "production"
    });

    logTranslationEvent("TRANSLATION_STARTED", {
      sessionId,
      jobId,
      sourceLang: direction.source,
      targetLanguages: direction.targets,
      chars: translationInput.length,
      text: sentence
    });

    enqueueTranslationJob(job);

    if (currentSentence.trim()) {
      scheduleStableTranslation(120);
    }
  };

  const scheduleStableTranslation = (delayOverride) => {
    clearTranslationTimer();
    const delay = Number.isFinite(delayOverride) ? delayOverride : adaptiveDebounceDelay(currentSentence);
    translationTimer = setTimeout(() => {
      void emitStableSentence().catch((error) => {
        void error;
        resetTranslationState();
      });
    }, delay);
    translationTimer.unref?.();
  };

  const sessionHealthMonitor = setInterval(() => {
    cleanupSessionHistoryStore();
    refreshProviderCooldowns();
    trimStaleTranslationJobs();
    cleanupStaleTranslationWork();
    drainTranslationQueue();
    pruneTranslationCache(translationCache);

    const now = Date.now();
    if (now - lastAdminStatsAt >= ADMIN_STATS_EMIT_MS) {
      lastAdminStatsAt = now;
      onResult?.({
        type: "admin_stats",
        stats: { ...globalUsageStats, budget: MONTHLY_BUDGET }
      });
    }

    if (currentSentence.length > MAX_PENDING_SENTENCE_CHARS) {
      currentSentence = trimTextWindow(currentSentence);
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
      const displayText = cleanTranscriptText(text);
      const normalized = normalizeTranscript(displayText);

      if (!normalized) {
        return;
      }

      const localDetection = shouldUseDetectedSourceLanguage({ configuredSourceLang: sourceLang, twoWay })
        ? resolveSourceLanguage({ text: displayText, providerDetectedLanguage: detectedLanguage })
        : { language: sourceLang, confidence: 1, source: "configured" };
      const effectiveDetectedLanguage = localDetection.language || detectedLanguage;
      const direction = resolveDirection({
        sourceLang,
        targetLang,
        targetLanguages: sessionTargetLanguages,
        detectedLanguage: effectiveDetectedLanguage,
        twoWay
      });

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
          detectedLanguage: effectiveDetectedLanguage
        });
        emitStreamingTranslationPreview({
          sentence: previewText,
          direction,
          detectedLanguage: effectiveDetectedLanguage
        });
        return;
      }

      if (normalized === lastFinalTranscript) {
        return;
      }
      lastFinalTranscript = normalized;
      logTranslationEvent("TRANSCRIPT_RECEIVED", {
        sourceLang: direction.source,
        targetLanguages: direction.targets,
        detectedLanguage: effectiveDetectedLanguage,
        chars: displayText.length,
        text: displayText
      });
      currentDirection = direction;
      currentDetectedLanguage = effectiveDetectedLanguage;
      rememberLocalSourceLanguage({
        text: displayText,
        language: effectiveDetectedLanguage,
        confidence: localDetection.confidence
      });
      currentSentence = trimTextWindow(appendSentenceChunk(currentSentence, displayText));
      scheduleStableTranslation();
    }
  });

  session.id = sessionId;
  session.sessionId = sessionId;
  session.transcriptHistory = [];
  session.getTranslationHealth = getTranslationHealth;
  rememberSessionHistory(sessionId, session.transcriptHistory);
  const stopDeepgramSession = session.stop;
  session.stop = () => {
    clearTranslationTimer();
    clearInterval(sessionHealthMonitor);
    for (const job of [...translationJobs.values()]) {
      markTranslationJobStale(job, "session_stop");
    }
    for (const lane of allTranslationLanes()) {
      for (const task of lane.activeTasks.values()) {
        staleTranslationJobs.add(task.jobId);
      }
      lane.queue.length = 0;
      lane.activeTasks.clear();
      lane.drainScheduled = false;
    }
    sessionTranslationQueue.currentAbortController?.abort?.();
    sessionTranslationQueue.currentAbortController = null;
    sessionTranslationQueue.queue.length = 0;
    sessionTranslationQueue.activeJob = null;
    sessionTranslationQueue.processing = false;
    for (const retryTimer of backgroundRetryTimers) {
      clearTimeout(retryTimer);
    }
    backgroundRetryTimers.clear();
    translationJobs.clear();
    trimStaleTranslationJobs();
    touchSessionHistory(sessionId);
    stopDeepgramSession?.();
  };

  await session.start();
  return session;
};
