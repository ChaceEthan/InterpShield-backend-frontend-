// @ts-nocheck
import { createDeepgramSession } from "./deepgram.js";
import { classifyGeminiError, translateWithGemini } from "./gemini.js";
import { classifyOpenAIError, translateWithOpenAI } from "./openai.js";
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
import { delay as waitForMs, getErrorStatusCode, getRetryDelay, providerErrorMessage as getProviderErrorMessage } from "./providerUtils.js";

const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|hmm+|you know|i mean)\b[,\s]*/gi;
const MAX_TRANSCRIPT_HISTORY = 500;
const MAX_STORED_SESSIONS = 100;
const MAX_TARGET_LANGUAGES = 3;
const MAX_CONCURRENT_TRANSLATION_LANGUAGES = 3;
const DEFAULT_TRANSLATION_DISPATCH_DELAY_MS = 180;
const MIN_TRANSLATION_DISPATCH_DELAY_MS = 100;
const MAX_TRANSLATION_DISPATCH_DELAY_MS = 300;
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
const MAX_TRANSLATION_LANE_QUEUE_SIZE = 96;
const MAX_SESSION_TRANSLATION_QUEUE_SIZE = 96;
const QUEUED_JOB_TIMEOUT = 10 * 60 * 1000;
const PROCESSING_JOB_TIMEOUT = 3 * 60 * 1000;
const SEQUENTIAL_JOB_HARD_TIMEOUT = 8 * 60 * 1000;
const TRANSLATION_RATE_LIMIT_DELAY_MS = 80;
const CIRCUIT_BREAKER_LATENCY_THRESHOLD_MS = 3000;
const LATENCY_WINDOW_SIZE = 5;
const MAX_CONSECUTIVE_TRANSLATION_FAILURES = 3;
const MAX_PROVIDER_RETRY_ATTEMPTS = 3;
const PROVIDER_RETRY_DELAY_MS = 1000;
const PROVIDER_RETRY_MAX_DELAY_MS = 4000;
// Single source of truth for which provider is tried first whenever the caller does not (or
// cannot) explicitly request one: Gemini is the paid, actively-billed provider; OpenAI is the
// fallback used only when Gemini genuinely fails/is unavailable. Read from an env override if
// operators ever need to flip this without a deploy, but default to Gemini.
export const DEFAULT_TRANSLATION_PROVIDER = ["gemini", "openai"].includes(String(process.env.DEFAULT_TRANSLATION_PROVIDER || "").trim().toLowerCase())
  ? String(process.env.DEFAULT_TRANSLATION_PROVIDER).trim().toLowerCase()
  : "gemini";

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
const PARTIAL_TRANSLATION_PREVIEW_THROTTLE_MS = 450;
const PROVIDER_STREAMING_PREVIEW_THROTTLE_MS = 500;
const PROVIDER_STREAMING_PREVIEW_MIN_WORDS = 2;
const PROVIDER_STREAMING_PREVIEW_MIN_CHARS = 6;
const ADMIN_STATS_EMIT_MS = 10000;
const FINAL_TRANSCRIPT_DUPLICATE_WINDOW_MS = 1500;
const TRANSLATED_SENTENCE_DUPLICATE_WINDOW_MS = 2500;
const PROVIDER_TIMEOUT_MS = {
  gemini: 25000,
  openai: 22000
};
const PROVIDER_FAILURE_THRESHOLD = 6;
const PROVIDER_NON_RETRYABLE_FAILURE_THRESHOLD = 2;
const PROVIDER_COOLDOWN_MS = 45000;
const PROVIDER_HARD_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
export const OPENAI_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
export const PROVIDER_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
const SESSION_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_HEALTH_CHECK_MS = 2500;
const MAX_STALE_TRANSLATION_JOBS = 40;
const MAX_PENDING_SENTENCE_CHARS = 1400;
const LOG_TEXT_PREVIEW_CHARS = 96;
const sessionHistoryStore = new Map();
const sharedTranslationCache = new Map();
const createProviderHealthState = () => ({
  failures: 0,
  cooldownUntil: 0,
  lastSuccessAt: 0,
  lastFailure: null,
  errorCategory: null,
  quotaExhausted: false
});
const sharedProviderHealth = {
  gemini: createProviderHealthState(),
  openai: createProviderHealthState()
};
const debugFlagEnabled = (flag) =>
  ["1", "true", "yes", "on"].includes(String(process.env[flag] || process.env.DEBUG || "").trim().toLowerCase());

const logTranslationEvent = (event, payload = {}, level = "info") => {
  const providerEvent = /^PROVIDER_|^TRANSLATION_PROVIDER_|^TRANSLATION_REQUEST|^TRANSLATION_COMPLETE|^TRANSLATION_FAILED|^TRANSLATION_QUEUE_STATE|^JOB_START|^QUEUE_ADD|^QUEUE_NEXT|^LANGUAGE_/.test(event);
  const shouldLog =
    process.env.NODE_ENV !== "production" ||
    debugFlagEnabled("TRANSLATION_DEBUG") ||
    providerEvent ||
    (providerEvent && debugFlagEnabled("PROVIDER_DEBUG"));
  if (!shouldLog) return;

  const safePayload = {};

  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null || value === "") continue;
    safePayload[key] = typeof value === "string" && value.length > LOG_TEXT_PREVIEW_CHARS
      ? `${value.slice(0, LOG_TEXT_PREVIEW_CHARS)}...`
      : value;
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    severity: level === "warn" ? "WARNING" : "INFO",
    event,
    ...safePayload
  };
  console.log(JSON.stringify(logEntry));
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

export const runSequentialTasks = async (items = [], worker = async () => undefined, concurrency = 1) => {
  const safeConcurrency = Math.max(1, Number.isFinite(concurrency) ? concurrency : 1);
  const results = new Array(items.length);
  let nextIndex = 0;

  const runNext = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(safeConcurrency, items.length || 1) }, runNext));
  return results;
};

export const createPerLanguageDispatchQueue = ({
  languages = [],
  concurrency = 1,
  requestDelayMs = DEFAULT_TRANSLATION_DISPATCH_DELAY_MS,
  maxRetries = 3,
  worker = async () => undefined,
  onEvent = () => undefined
} = {}) => {
  const orderedLanguages = Array.from(new Set((Array.isArray(languages) ? languages : []).filter(Boolean)));
  const safeConcurrency = Math.max(1, Math.min(orderedLanguages.length || 1, Number.isFinite(concurrency) ? concurrency : 1));
  const safeMaxRetries = Math.max(0, Number.isFinite(maxRetries) ? maxRetries : 3);
  const safeRequestDelayMs = (() => {
    const parsedDelay = Number(requestDelayMs);
    if (!Number.isFinite(parsedDelay)) return DEFAULT_TRANSLATION_DISPATCH_DELAY_MS;
    if (parsedDelay < MIN_TRANSLATION_DISPATCH_DELAY_MS) return MIN_TRANSLATION_DISPATCH_DELAY_MS;
    if (parsedDelay > MAX_TRANSLATION_DISPATCH_DELAY_MS) return MAX_TRANSLATION_DISPATCH_DELAY_MS;
    return parsedDelay;
  })();
  const languageIndex = new Map(orderedLanguages.map((language, index) => [language, index]));
  const queue = [...orderedLanguages];
  const results = new Array(orderedLanguages.length);
  let activeWorkers = 0;

  const dispatchNextLanguage = async () => {
    while (queue.length > 0) {
      const language = queue.shift();
      if (!language) continue;

      activeWorkers += 1;
      const queueLength = queue.length;
      onEvent?.({ type: "dispatch_start", language, queueLength, activeWorkers, requestDelayMs: safeRequestDelayMs });

      try {
        let lastError = null;
        let succeeded = false;
        let attempt = 0;

        while (attempt <= safeMaxRetries) {
          const requestId = `${language}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const currentQueueLength = queue.length;
          onEvent?.({ type: "dispatch_request", language, requestId, queueLength: currentQueueLength, activeWorkers, attempt, requestDelayMs: safeRequestDelayMs });

          try {
            if (safeRequestDelayMs > 0 && attempt > 0) {
              await waitForMs(safeRequestDelayMs);
            }
            const result = await worker(language, { requestId, queueLength: currentQueueLength, activeWorkers, attempt });
            results[languageIndex.get(language)] = result;
            lastError = null;
            succeeded = true;
            break;
          } catch (error) {
            lastError = error;
            if (attempt >= safeMaxRetries) throw error;
            attempt += 1;
          }
        }

        if (!succeeded && lastError) {
          throw lastError;
        }
      } finally {
        activeWorkers = Math.max(0, activeWorkers - 1);
        onEvent?.({ type: "dispatch_complete", language, queueLength, activeWorkers });
      }
    }
  };

  return {
    async run() {
      const workers = Array.from({ length: safeConcurrency }, () => dispatchNextLanguage());
      await Promise.all(workers);
      return results;
    }
  };
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

const isProviderNonRetryableFailure = (error = {}) => {
  const message = getProviderErrorMessage(error);
  const statusCode = getErrorStatusCode(error);

  if ([400, 401, 403, 404].includes(statusCode)) return true;
  return /\b(400|401|403|404)\b|quota|insufficient|credit|billing|unauthori[sz]ed|forbidden|invalid api key|permission|resource_exhausted/i.test(message);
};

export const isRetryableProviderError = (error = {}) => {
  const message = getProviderErrorMessage(error);
  if (!message) return false;
  if (error?.providerRetryExhausted) return false;

  const statusCode = getErrorStatusCode(error);
  if ([408, 409, 429, 500, 502, 503, 504].includes(statusCode)) return true;
  return !isProviderNonRetryableFailure(error) && /timed out|timeout|temporar|network|socket hang up|econnreset|fetch failed|reset|retry|overload|unavailable|busy/i.test(message);
};

export const isProviderAvailableFromHealth = (providerHealth = {}, provider = "", now = Date.now()) => {
  const health = providerHealth?.[provider];
  return Boolean(health) && now >= Number(health.cooldownUntil || 0);
};

export const applyProviderFailureToHealth = ({ provider, health, error, now = Date.now() } = {}) => {
  if (!health) return { cooldownApplied: false, reason: "missing_health" };

  const statusCode = getErrorStatusCode(error);
  const retryAfterMs = Number(error?.retryAfterMs);
  const classifiedCategory = provider === "openai" ? classifyOpenAIError(error) : classifyGeminiError(error);
  const errorCategory = classifiedCategory || (statusCode === 429 ? "daily_quota_exhausted" : "unknown_provider_error");
  const quotaExhausted = ["daily_quota_exhausted", "billing_quota_exhausted"].includes(errorCategory);
  const reason = error?.reason || getProviderErrorMessage(error) || "Provider request failed";
  const existingQuotaActive = health.quotaExhausted &&
    ["daily_quota_exhausted", "billing_quota_exhausted"].includes(health.errorCategory) &&
    now < Number(health.cooldownUntil || 0);

  if (existingQuotaActive && !quotaExhausted) {
    health.failures = Number(health.failures || 0) + 1;
    return {
      cooldownApplied: true,
      cooldownMs: Math.max(0, Number(health.cooldownUntil || 0) - now),
      reason: "quota_exhausted",
      errorCategory: health.errorCategory,
      preserved: true
    };
  }

  health.failures = Number(health.failures || 0) + 1;
  health.errorCategory = errorCategory;
  health.quotaExhausted = quotaExhausted;
  health.lastFailure = {
    provider,
    providerModel: error?.providerModel || error?.model || null,
    httpStatus: statusCode,
    reason,
    errorCode: error?.errorCode || null,
    errorCategory,
    retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
    at: now
  };

  if (quotaExhausted) {
    const cooldownMs = Math.max(provider === "openai" ? OPENAI_QUOTA_COOLDOWN_MS : PROVIDER_QUOTA_COOLDOWN_MS, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
    health.cooldownUntil = Math.max(Number(health.cooldownUntil || 0), now + cooldownMs);
    return { cooldownApplied: true, cooldownMs, reason: "quota_exhausted", errorCategory };
  }

  if (["temporary_rate_limit", "provider_overloaded", "network_timeout"].includes(errorCategory)) {
    const cooldownMs = Math.max(PROVIDER_COOLDOWN_MS, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
    health.cooldownUntil = Math.max(Number(health.cooldownUntil || 0), now + cooldownMs);
    return { cooldownApplied: true, cooldownMs, reason: errorCategory, errorCategory };
  }

  const nonRetryable = isProviderNonRetryableFailure(error);
  const failureThreshold = nonRetryable ? PROVIDER_NON_RETRYABLE_FAILURE_THRESHOLD : PROVIDER_FAILURE_THRESHOLD;
  if (health.failures < failureThreshold) {
    return { cooldownApplied: false, reason: nonRetryable ? "non_retryable_threshold" : "failure_threshold", errorCategory };
  }

  const cooldownMs = nonRetryable ? PROVIDER_HARD_FAILURE_COOLDOWN_MS : PROVIDER_COOLDOWN_MS;
  health.cooldownUntil = Math.max(Number(health.cooldownUntil || 0), now + cooldownMs);
  return { cooldownApplied: true, cooldownMs, reason: nonRetryable ? "non_retryable_failure" : "failure_threshold", errorCategory };
};

export const getLatestConfiguredProviderFailure = ({ providerHealth = {}, env = {} } = {}) =>
  Object.entries(providerHealth)
    .filter(([name]) => name === "gemini" ? Boolean(env.geminiApiKey) : Boolean(env.openaiApiKey))
    .map(([, health]) => health?.lastFailure)
    .filter(Boolean)
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0] || null;

export const createProviderUnavailableError = ({ providerHealth = {}, env = {} } = {}) => {
  const lastFailure = getLatestConfiguredProviderFailure({ providerHealth, env });
  const hasConfiguredProvider = Boolean(env.geminiApiKey || env.openaiApiKey);
  const error = new Error(
    lastFailure?.reason ||
    (hasConfiguredProvider
      ? "All configured translation providers are temporarily unavailable"
      : "No translation provider is configured")
  );
  error.provider = lastFailure?.provider || "provider";
  error.providerModel = lastFailure?.providerModel || null;
  error.status = lastFailure?.httpStatus || null;
  error.httpStatus = lastFailure?.httpStatus || null;
  error.reason = lastFailure?.reason || error.message;
  error.errorCode = lastFailure?.errorCode || null;
  error.errorCategory = lastFailure?.errorCategory || null;
  error.retryAfterMs = lastFailure?.retryAfterMs || null;
  error.providerRetryExhausted = true;
  return error;
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

export const shouldDegradeProviderHealth = ({ result = null, error = null, sourceText = "", sourceLang = "", targetLang = "", provider = "" } = {}) => {
  if (result?.stale) return false;

  const candidateError = error || result?.error;
  const providerName = result?.provider || provider;
  const translatedText = result?.translatedText || "";
  const displayable = Boolean(
    translatedText && isTranslationDisplayable({
      text: translatedText,
      sourceText,
      sourceLang,
      targetLang,
      provider: providerName
    })
  );

  if (translatedText && !displayable) return false;
  if (translatedText && displayable) return false;

  if (result?.timedOut || candidateError?.name === "AbortError") return true;

  return Boolean(
    candidateError && (
      isProviderNonRetryableFailure(candidateError) ||
      isRetryableProviderError(candidateError)
    )
  );
};

export const buildProviderExecutionOrder = ({ providerHealth = {}, env = {}, preferredProvider = "auto" } = {}) => {
  const now = Date.now();
  const preferred = ["gemini", "openai"].includes(preferredProvider) ? preferredProvider : DEFAULT_TRANSLATION_PROVIDER;

  return ["gemini", "openai"]
    .filter((name) => name === "gemini" ? Boolean(env.geminiApiKey) : Boolean(env.openaiApiKey))
    .filter((name) => isProviderAvailableFromHealth(providerHealth, name, now))
    .sort((a, b) => {
      if (a === preferred && b !== preferred) return -1;
      if (b === preferred && a !== preferred) return 1;
      const failureDifference = Number(providerHealth[a]?.failures || 0) - Number(providerHealth[b]?.failures || 0);
      if (failureDifference !== 0) return failureDifference;
      return a === "gemini" ? -1 : 1;
    });
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
  mimeType = "",
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
  onClosed,
  onAudioStreamReset,
  deepgramClientFactory
}) => {
  let lastFinalTranscript = "";
  let lastFinalTranscriptAt = 0;
  let lastInterimTranscript = "";
  let lastTranslatedTranscript = "";
  let lastTranslatedTranscriptAt = 0;
  let currentSentence = "";
  let finalizedUtteranceCount = 0;
  let sessionStopped = false;
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
  const providerHealth = sharedProviderHealth;
  const logPipelineDecision = (decision, extra = {}) => {
    console.info("[TRANSLATION_PIPELINE_DIAGNOSTICS]", {
      decision,
      sessionId,
      ...extra
    });
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

  const getOrCreateLanguageState = (job, language) => {
    if (!job || !language) return null;

    if (!job.languageStates) {
      job.languageStates = new Map();
    }

    let state = job.languageStates.get(language);
    if (!state) {
      state = {
        language,
        requestId: `${job.id}:${language}`,
        socketId: session?.socketId || "",
        retryCount: 0,
        provider: null,
        providerModel: null,
        providerSelected: null,
        fallbackProvider: null,
        httpStatus: null,
        lastError: null,
        abortController: null,
        timeoutTimer: null,
        promise: null,
        status: "queued"
      };
      job.languageStates.set(language, state);
    }

    return state;
  };

  const abortLanguageState = (job, language) => {
    const state = job?.languageStates?.get?.(language);
    if (!state) return;

    state.abortController?.abort?.();
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = null;
    }
    state.promise = null;
    state.status = "cancelled";
  };

  const abortJobLanguageStates = (job) => {
    if (!job?.languageStates) return;
    for (const language of job.languageStates.keys()) {
      abortLanguageState(job, language);
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
    deepgram: session?.getHealth?.() || null,
    metrics: {
      timeoutCount: translationMetrics.timeoutCount,
      retryCount: translationMetrics.retryCount,
      completedCount: translationMetrics.completedCount,
      failedCount: translationMetrics.failedCount
    }
  });

  const createTranslationDiagnostics = ({ language, provider, providerModel = null, reason, errorCode = null, errorCategory = null, retryCount = 0, latencyMs, requestId, socketId, status = "unknown", fallbackProvider, httpStatus, providerResponse, queueLength = null, activeWorkers = null }) => ({
    language,
    provider,
    providerModel,
    retryCount,
    latencyMs,
    httpStatus,
    reason,
    errorCode,
    errorCategory,
    requestId,
    socketId,
    status,
    fallbackProvider,
    providerSelected: provider || "unknown",
    providerResponse,
    queueLength,
    activeWorkers
  });

  const buildTranslationFailureDiagnostic = ({ provider = "unknown", providerModel = null, statusCode = null, reason = "failed", errorCode = null, errorCategory = null, retryAfterMs = null, requestId = null, latencyMs = 0, fallbackProvider = null, providerResponse = null, attempt = 0, queueLength = null, activeWorkers = null }) => {
    const providerName = typeof provider === "string" && provider.trim()
      ? provider.charAt(0).toUpperCase() + provider.slice(1)
      : "Provider";
    const summaryReason = String(reason || "failed").trim() || "Unknown failure";
    const retryAfterSeconds = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : null;
    const lines = [
      "FAILED",
      `Provider: ${providerName}`,
      `Provider Model: ${providerModel || "unknown"}`,
      `HTTP Status: ${statusCode || "unknown"}`,
      `Failure Reason: ${summaryReason}`,
      `Latency: ${Number.isFinite(latencyMs) ? latencyMs : 0}ms`,
      `Retry Count: ${Number.isFinite(attempt) ? attempt : 0}`,
      `Queue Length: ${Number.isFinite(queueLength) ? queueLength : "unknown"}`,
      `Active Workers: ${Number.isFinite(activeWorkers) ? activeWorkers : "unknown"}`,
      `Request ID: ${requestId || "unknown"}`
    ];

    if (retryAfterSeconds) lines.push(`Retry After: ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}`);
    if (errorCode) lines.push(`Error Code: ${errorCode}`);
    if (providerResponse) lines.push(`Provider Response: ${String(providerResponse).slice(0, 240)}`);
    if (fallbackProvider) lines.push(`Fallback Provider: ${fallbackProvider}`);

    return {
      message: lines.join("\n"),
      provider: providerName,
      providerModel,
      httpStatus: statusCode,
      reason: summaryReason,
      errorCode,
      errorCategory,
      retryAfterMs,
      requestId,
      latencyMs,
      fallbackProvider,
      providerResponse,
      attempt,
      queueLength,
      activeWorkers,
      status: "failed"
    };
  };

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
        cooldownUntil: providerHealth.gemini.cooldownUntil,
        errorCategory: providerHealth.gemini.errorCategory || null,
        lastFailure: providerHealth.gemini.lastFailure || null
      },
      openai: {
        status: openaiAvailable ? "healthy" : "cooldown",
        cooldownUntil: providerHealth.openai.cooldownUntil,
        errorCategory: providerHealth.openai.errorCategory || null,
        quotaExhausted: Boolean(providerHealth.openai.quotaExhausted),
        lastFailure: providerHealth.openai.lastFailure || null
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
    lastFinalTranscriptAt = 0;
    lastTranslatedTranscriptAt = 0;
    consecutiveTranslationFailures = 0;
    for (const job of translationJobs.values()) {
      staleTranslationJobs.add(job.id);
      job.stale = true;
      job.cancelled = true;
      job.pendingLanguages?.clear?.();
      job.runningLanguages?.clear?.();
      abortJobLanguageStates(job);
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
    return isProviderAvailableFromHealth(providerHealth, provider);
  };

  const noteProviderSuccess = (provider) => {
    const health = providerHealth[provider];
    if (!health) return;
    health.failures = 0;
    health.cooldownUntil = 0;
    health.lastSuccessAt = Date.now();
    health.lastFailure = null;
    health.errorCategory = null;
    health.quotaExhausted = false;
  };

  const noteProviderFailure = (provider, error) => {
    const outcome = applyProviderFailureToHealth({
      provider,
      health: providerHealth[provider],
      error
    });
    if (outcome.cooldownApplied) {
      logTranslationEvent("PROVIDER_COOLDOWN", {
        sessionId,
        provider,
        reason: outcome.reason,
        cooldownMs: outcome.cooldownMs,
        httpStatus: getErrorStatusCode(error),
        errorCategory: outcome.errorCategory || error?.errorCategory || null,
        error: error?.reason || getProviderErrorMessage(error)
      }, "warn");
    }
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
        health.errorCategory = null;
        health.quotaExhausted = false;
      }
    }

    if (recovered.length > 0) {
      onWarning?.(`PROVIDER_RECOVERED:${recovered.join(",")}`);
    }

    emitProviderHealth();
  };

  const getHealthyProviders = () => {
    refreshProviderCooldowns();
    const primaryChoice = ["gemini", "openai"].includes(preferredProvider)
      ? preferredProvider
      : DEFAULT_TRANSLATION_PROVIDER;
    const order = buildProviderExecutionOrder({
      providerHealth,
      env,
      preferredProvider: primaryChoice
    });
    return order;
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

  const runProviderTranslationAttempt = async ({ provider, language, translationInput, direction, languageTranslationContext, jobId, languageState, job, queueLength = 0, activeWorkers = 0, attempt = 0, requestId = null }) => {
    if (staleTranslationJobs.has(jobId)) {
      return {
        provider,
        stale: true,
        error: new Error("Translation job became stale")
      };
    }

    await waitForMs(TRANSLATION_RATE_LIMIT_DELAY_MS);
    if (staleTranslationJobs.has(jobId)) {
      return {
        provider,
        stale: true,
        error: new Error("Translation job became stale")
      };
    }

    const providerName = provider === "gemini" ? "Gemini" : "OpenAI";
    const attemptStartedAt = Date.now();
    const timeoutMs = PROVIDER_TIMEOUT_MS[provider] || 22000;
    const abortController = typeof AbortController !== "undefined" ? new AbortController() : null;
    const unregisterAbortController = trackProviderAbortController(jobId, abortController);
    const state = languageState || getOrCreateLanguageState(job, language);
    state?.abortController?.abort?.();
    state?.promise && (state.promise = null);
    if (state) {
      state.abortController = abortController;
      state.timeoutTimer = null;
      state.provider = provider;
      state.providerSelected = provider;
      state.providerModel = provider === "gemini" ? env.geminiModel || null : state.providerModel;
      state.requestId = requestId || `${jobId}:${language}:${Date.now().toString(36)}`;
      state.socketId = session?.socketId || "";
      state.queueLength = queueLength;
      state.activeWorkers = activeWorkers;
      state.status = "processing";
      state.lastError = null;
      state.httpStatus = null;
    }
    const timeoutTimer = abortController ? setTimeout(() => abortController.abort(), timeoutMs) : null;
    if (state) {
      state.timeoutTimer = timeoutTimer;
    }
    const attemptPromise = (async () => {
      try {
        logTranslationEvent("TRANSLATION_REQUEST", {
          sessionId,
          requestId: requestId || `${jobId}:${language}:${provider}:${Date.now().toString(36)}`,
          provider,
          targetLang: language,
          queueLength,
          activeWorkers,
          retries: attempt,
          sourceLang: direction.source,
          chars: translationInput.length
        });
        if (provider === "openai") {
          logPipelineDecision("OpenAI request started", {
            jobId,
            language,
            provider,
            requestId: requestId || `${jobId}:${language}:${provider}:${Date.now().toString(36)}`
          });
        }
        if (provider === "gemini") {
          logPipelineDecision("Gemini fallback started", {
            jobId,
            language,
            provider,
            requestId: requestId || `${jobId}:${language}:${provider}:${Date.now().toString(36)}`
          });
        }
        const providerResult = await withTimeout(
          providerRunner(provider)({
            apiKey: provider === "gemini" ? env.geminiApiKey : env.openaiApiKey,
            ...(provider === "gemini" ? { model: env.geminiModel } : {}),
            text: translationInput,
            sourceLang: sourceLanguageForProvider(direction.source),
            targetLang: language,
            translationContext: languageTranslationContext,
            signal: abortController?.signal,
            includeMetadata: true
          }),
          timeoutMs,
          `${providerName} translation timed out for ${language}`
        );
        const responseTimeMs = Date.now() - attemptStartedAt;
        rememberProviderLatency(provider, responseTimeMs);
        const providerModel = providerResult && typeof providerResult === "object"
          ? providerResult.providerModel || providerResult.model || null
          : null;
        const providerRetryCount = providerResult && typeof providerResult === "object"
          ? Number(providerResult.retryCount) || 0
          : 0;
        const providerHttpStatus = providerResult && typeof providerResult === "object"
          ? Number(providerResult.httpStatus) || 200
          : 200;
        const providerLatencyMs = providerResult && typeof providerResult === "object" && Number.isFinite(providerResult.latencyMs)
          ? providerResult.latencyMs
          : responseTimeMs;
        const translatedText = providerResult && typeof providerResult === "object"
          ? providerResult.text
          : providerResult;
        const safeTranslatedText = String(translatedText || "").trim();
        if (state) {
          state.providerModel = providerModel;
          state.retryCount = Math.max(state.retryCount || 0, attempt + providerRetryCount);
          state.httpStatus = providerHttpStatus;
        }

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
            requestId: requestId || `${jobId}:${language}:${provider}:${Date.now().toString(36)}`,
            jobId,
            provider,
            providerModel,
            targetLang: language,
            latencyMs: responseTimeMs,
            queueLength,
            activeWorkers,
            retries: attempt,
            httpStatus: 200,
            providerResponse: safeTranslatedText.slice(0, 240),
            chars: safeTranslatedText.length
          });
          return {
            provider,
            providerModel,
            translatedText: safeTranslatedText,
            httpStatus: providerHttpStatus,
            retryCount: attempt + providerRetryCount,
            latencyMs: providerLatencyMs,
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
          providerModel,
          httpStatus: providerHttpStatus,
          retryCount: attempt + providerRetryCount,
          latencyMs: providerLatencyMs,
          responseTimeMs,
          error: new Error(`Invalid ${providerName} translation response for ${language}`)
        };
      } catch (error) {
        const responseTimeMs = Date.now() - attemptStartedAt;
        const timedOut = /timed out|timeout/i.test(error?.message || "");
        if (timedOut) translationMetrics.timeoutCount += 1;
        rememberProviderLatency(provider, responseTimeMs);
        if (state) {
          state.providerModel = error?.providerModel || error?.model || state.providerModel || null;
          state.retryCount = Math.max(state.retryCount || 0, attempt + (Number(error?.retryCount) || 0));
          state.httpStatus = getErrorStatusCode(error);
        }
        logTranslationEvent("TRANSLATION_FAILED", {
          sessionId,
          requestId: requestId || `${jobId}:${language}:${provider}:${Date.now().toString(36)}`,
          jobId,
          provider,
          providerModel: error?.providerModel || error?.model || state?.providerModel || null,
          targetLang: language,
          queueLength,
          activeWorkers,
          retries: attempt,
          latencyMs: responseTimeMs,
          httpStatus: getErrorStatusCode(error),
          reason: error?.reason || error?.message || String(error),
          providerResponse: error?.reason || error?.message || String(error),
          timeoutMs
        }, "warn");
        return {
          provider,
          providerModel: error?.providerModel || error?.model || state?.providerModel || null,
          httpStatus: getErrorStatusCode(error),
          retryCount: attempt + (Number(error?.retryCount) || 0),
          latencyMs: responseTimeMs,
          error,
          timedOut,
          responseTimeMs
        };
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        abortController?.abort();
        unregisterAbortController();
        if (state && state.abortController === abortController) {
          state.abortController = null;
        }
        if (state && state.timeoutTimer === timeoutTimer) {
          state.timeoutTimer = null;
        }
        if (state && state.promise === attemptPromise) {
          state.promise = null;
        }
      }
    })();

    state && (state.promise = attemptPromise);
    return attemptPromise;
  };

  const translateProviderLanguageWithRecovery = async ({ language, translationInput, direction, translationContext, jobId, job = null, queueLength = 0, activeWorkers = 0, requestId = null }) => {
    let lastError = null;
    let lastAttemptedProvider = null;
    const languageTranslationContext = languageTranslationContextFor(language, translationContext);
    const languageState = getOrCreateLanguageState(job, language);
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
    const providerOrder = [...getHealthyProviders()];
    const providerSelectionDiagnostics = Object.entries(providerHealth).map(([name, health]) => {
      const hasKey = name === "gemini" ? Boolean(env.geminiApiKey) : Boolean(env.openaiApiKey);
      const cooldownRemainingMs = Math.max(0, (health.cooldownUntil || 0) - Date.now());
      return {
        name,
        configured: hasKey,
        available: hasKey && Date.now() >= (health.cooldownUntil || 0),
        cooldownRemainingMs,
        failures: health.failures,
        lastSuccessAt: health.lastSuccessAt,
        errorCategory: health.errorCategory || null,
        quotaExhausted: Boolean(health.quotaExhausted),
        lastFailure: health.lastFailure || null
      };
    });
    logTranslationEvent("PROVIDER_SELECTION", {
      sessionId,
      jobId,
      targetLang: language,
      provider: providerOrder.join(",") || "none",
      selectedProviderCount: providerOrder.length,
      providers: providerSelectionDiagnostics,
      preferredProvider,
      userPlan
    });

    if (providerOrder.length === 0) {
      lastError = createProviderUnavailableError({ providerHealth, env });
      logTranslationEvent("TRANSLATION_FAILED", {
        sessionId,
        jobId,
        targetLang: language,
        error: `No healthy translation providers available. Diagnostics: ${providerSelectionDiagnostics.map(({ name, configured, available, cooldownRemainingMs, failures }) => `${name} configured=${configured} available=${available} cooldownMs=${cooldownRemainingMs} failures=${failures}`).join(" | ")}`
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
        if (languageState) {
          languageState.providerSelected = result.provider;
          languageState.provider = result.provider;
          languageState.providerModel = result.providerModel || null;
          languageState.fallbackProvider = null;
          languageState.httpStatus = result.httpStatus || 200;
          languageState.retryCount = Math.max(languageState.retryCount || 0, result.retryCount || 0);
          languageState.lastError = null;
          languageState.status = "translated";
        }
        noteProviderSuccess(result.provider);
        logTranslationEvent("TRANSLATION_PROVIDER_SUCCESS", {
          sessionId,
          jobId,
          utteranceId: jobId,
          targetLanguage: language,
          provider: result.provider
        });
        noteTranslationSuccess(language, result.translatedText, languageTranslationContext);
        rememberCachedTranslation(translationCache, cacheKey, result.translatedText, {
          source: direction.source,
          target: language,
          sourceText: translationInput,
          provider: result.provider
        });
        return {
          text: result.translatedText,
          provider: result.provider,
          providerModel: result.providerModel || null,
          httpStatus: result.httpStatus || 200,
          retryCount: result.retryCount || 0,
          latencyMs: result.latencyMs || result.responseTimeMs || 0
        };
      }

      lastError = result.error || new Error(`${result.provider || "Provider"} did not return a valid ${language} translation`);
      if (languageState) {
        languageState.lastError = lastError;
        languageState.httpStatus = getErrorStatusCode(lastError);
        languageState.providerModel = result.providerModel || lastError?.providerModel || lastError?.model || languageState.providerModel || null;
        languageState.fallbackProvider = providerOrder[providerOrder.indexOf(result.provider) + 1] || null;
      }
      if (
        result.provider && shouldDegradeProviderHealth({
          result,
          error: result.error,
          sourceText: translationInput,
          sourceLang: direction.source,
          targetLang: language,
          provider: result.provider
        })
      ) {
        noteProviderFailure(result.provider, lastError);
      }
      return {
        text: "",
        provider: result.provider,
        providerModel: result.providerModel || lastError?.providerModel || lastError?.model || null,
        httpStatus: result.httpStatus || getErrorStatusCode(lastError),
        retryCount: result.retryCount || 0,
        latencyMs: result.latencyMs || result.responseTimeMs || 0,
        error: lastError
      };
    };

    for (const provider of providerOrder) {
      if (!providerAvailable(provider)) {
        logTranslationEvent("PROVIDER_SKIPPED", {
          sessionId,
          jobId,
          provider,
          targetLang: language,
          reason: providerHealth[provider]?.errorCategory || "cooldown"
        }, "warn");
        continue;
      }

      for (let attempt = 0; attempt <= MAX_PROVIDER_RETRY_ATTEMPTS; attempt += 1) {
        if (staleTranslationJobs.has(jobId)) break;
        if (!providerAvailable(provider)) break;

        if (attempt > 0) {
          translationMetrics.retryCount += 1;
          if (languageState) {
            languageState.retryCount = attempt + 1;
            languageState.status = "retrying";
          }
          setTranslationLanguageStatus(translationJobs.get(jobId), language, "retrying");
          logTranslationEvent("PROVIDER_RETRY", {
            sessionId,
            jobId,
            provider,
            targetLang: language,
            attempt: attempt + 1
          }, "warn");
          await waitForMs(getRetryDelay({ attempt, baseMs: PROVIDER_RETRY_DELAY_MS, maxMs: PROVIDER_RETRY_MAX_DELAY_MS, error: lastError }));
          if (staleTranslationJobs.has(jobId)) break;
          if (!providerAvailable(provider)) break;
        }

        lastAttemptedProvider = provider;
        logTranslationEvent("TRANSLATION_PROVIDER_ATTEMPT", {
          sessionId,
          jobId,
          utteranceId: jobId,
          targetLanguage: language,
          provider,
          attempt: attempt + 1
        });
        const result = await runProviderTranslationAttempt({
          provider,
          language,
          translationInput,
          direction,
          languageTranslationContext,
          jobId,
          job,
          languageState,
          queueLength,
          activeWorkers,
          attempt,
          requestId
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

      const nextProviderInOrder = providerOrder[providerOrder.indexOf(provider) + 1] || null;
      if (languageState) {
        languageState.fallbackProvider = nextProviderInOrder;
      }
      logTranslationEvent("PROVIDER_FALLBACK", {
        sessionId,
        jobId,
        provider,
        providerModel: lastError?.providerModel || lastError?.model || languageState?.providerModel || null,
        targetLang: language,
        nextProvider: nextProviderInOrder || "none",
        error: lastError?.message || lastError
      }, "warn");
      if (nextProviderInOrder) {
        logTranslationEvent("TRANSLATION_PROVIDER_FALLBACK", {
          sessionId,
          jobId,
          utteranceId: jobId,
          targetLanguage: language,
          from: provider,
          to: nextProviderInOrder,
          reason: lastError?.errorCategory || lastError?.reason || lastError?.message || "provider_failed"
        }, "warn");
      }
    }

    if (!lastError) {
      lastError = createProviderUnavailableError({ providerHealth, env });
    }
    logTranslationEvent("TRANSLATION_PROVIDER_FINAL_FAILURE", {
      sessionId,
      jobId,
      utteranceId: jobId,
      targetLanguage: language,
      providersAttempted: providerOrder,
      reason: lastError?.errorCategory || lastError?.reason || lastError?.message || "unknown"
    }, "warn");
    noteTranslationFailure(language, lastError);
    return {
      text: "",
      provider: lastAttemptedProvider || lastError?.provider || "provider",
      providerModel: lastError?.providerModel || lastError?.model || languageState?.providerModel || null,
      httpStatus: getErrorStatusCode(lastError),
      retryCount: languageState?.retryCount || 0,
      latencyMs: Number(lastError?.latencyMs) || 0,
      error: lastError
    };
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
    abortJobLanguageStates(job);
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
    const languageState = getOrCreateLanguageState(job, language);

    const errorPayload = status === "failed" ? (job.languageErrors?.[language] || {
      language,
      provider,
      statusCode: null,
      attempt: (job.providerRetryAttempts?.get?.(language) || 0) + 1,
      latencyMs: Date.now() - job.startedAt,
      reason: "failed"
    }) : undefined;

    onResult?.({
      original: job.sentence,
      originalText: job.sentence,
      ...createTranslationPayloadMetadata(job),
      translatedText: job.translations[language] || "",
      diagnostics: status === "failed" && errorPayload?.diagnostics
        ? {
            ...errorPayload.diagnostics,
            language,
            providerModel: errorPayload.diagnostics.providerModel || languageState?.providerModel || null,
            requestId: errorPayload.diagnostics.requestId || languageState?.requestId || `${job.id}:${language}`
          }
        : createTranslationDiagnostics({
            language,
            provider,
            providerModel: languageState?.providerModel || null,
            reason: status,
            retryCount: languageState?.retryCount || job.providerRetryAttempts?.get?.(language) || 0,
            latencyMs: Date.now() - job.startedAt,
            requestId: languageState?.requestId || `${job.id}:${language}`,
            socketId: languageState?.socketId || session?.socketId || "",
            status,
            fallbackProvider: languageState?.fallbackProvider || (job.providerFallbackLanguages?.has?.(language) ? "provider-fallback" : undefined),
            httpStatus: languageState?.httpStatus || null,
            providerResponse: null,
            queueLength: languageState?.queueLength ?? null,
            activeWorkers: languageState?.activeWorkers ?? null
          }),
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
      mode: "production",
      ...(errorPayload ? { error: errorPayload } : {})
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

  const markTranslationLanguageFailed = (job, language, errorOrReason = "failed", provider = "queue") => {
    if (!job || !language || job.translations?.[language]) return;
    job.pendingLanguages?.delete?.(language);
    job.runningLanguages?.delete?.(language);
    job.completedLanguages?.add?.(language);
    setTranslationLanguageStatus(job, language, "failed");
    translationMetrics.failedCount += 1;

    const languageState = getOrCreateLanguageState(job, language);
    const latencyMs = Date.now() - job.startedAt;
    const attempt = Math.max(languageState?.retryCount || 0, job.providerRetryAttempts?.get?.(language) || 0);

    let reason = "failed";
    let failureProvider = provider;
    let statusCode = null;
    let providerResponse = null;
    let providerModel = languageState?.providerModel || null;
    let retryAfterMs = null;
    let requestId = null;
    let errorCode = null;
    let errorCategory = null;

    if (errorOrReason && typeof errorOrReason === "object") {
      failureProvider = errorOrReason.provider || provider;
      reason = errorOrReason.reason || errorOrReason.message || "failed";
      statusCode = getErrorStatusCode(errorOrReason) || null;
      providerResponse = errorOrReason.providerResponse || errorOrReason.response || errorOrReason.message || null;
      providerModel = errorOrReason.providerModel || errorOrReason.model || providerModel;
      retryAfterMs = errorOrReason.retryAfterMs || null;
      requestId = errorOrReason.requestId || languageState?.requestId || null;
      errorCode = errorOrReason.errorCode || null;
      errorCategory = errorOrReason.errorCategory || null;
    } else {
      reason = String(errorOrReason || "failed");
      requestId = languageState?.requestId || null;
    }

    const diagnostic = buildTranslationFailureDiagnostic({
      provider: failureProvider,
      providerModel,
      statusCode,
      reason,
      errorCode,
      errorCategory,
      retryAfterMs,
      requestId,
      latencyMs,
      providerResponse,
      attempt,
      queueLength: languageState?.queueLength ?? null,
      activeWorkers: languageState?.activeWorkers ?? null
    });

    if (!job.languageErrors) job.languageErrors = {};
    job.languageErrors[language] = {
      language,
      provider: failureProvider,
      providerModel,
      statusCode,
      attempt,
      latencyMs,
      reason: diagnostic.message,
      diagnostics: diagnostic,
      providerResponse,
      retryAfterMs,
      requestId,
      errorCode,
      errorCategory
    };

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
      provider: failureProvider,
      latencyMs,
      error: reason,
      statusCode,
      attempt
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
      try {
        for (const provider of providers) {
          if (sessionStopped) return;
          const result = await runProviderTranslationAttempt({
            provider,
            language,
            translationInput,
            direction,
            languageTranslationContext,
            jobId: `preview-${previewId}-${language}`
          });

          if (previewId !== providerStreamingPreviewSequence || result?.stale || sessionStopped) return;

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
      } catch (error) {
        logTranslationEvent("STREAMING_PREVIEW_FAILED", {
          sessionId,
          previewId,
          targetLang: language,
          error: error?.message || String(error)
        }, "warn");
      }
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

  const emitTranslationUpdate = (job, language, translatedText, provider, providerModel = null) => {
    if (!translatedText || job.stale || staleTranslationJobs.has(job.id)) return false;
    const safeTranslatedText = cleanTranscriptText(translatedText);
    const languageState = getOrCreateLanguageState(job, language);
    const actualProviderModel = providerModel || languageState?.providerModel || null;
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
    if (job.languageErrors?.[language]) delete job.languageErrors[language];
    if (languageState) {
      languageState.provider = provider;
      languageState.providerModel = actualProviderModel;
      languageState.lastError = null;
      languageState.status = "translated";
      languageState.httpStatus = 200;
    }
    job.lastProviderUsed = provider;
    setTranslationLanguageStatus(job, language, "translated");
    const translationOutputs = translationOutputsForJob(job);
    translationMetrics.completedCount += 1;

    logTranslationEvent("TRANSLATION_SUCCESS", {
      jobId: job.id,
      provider,
      providerModel: actualProviderModel,
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
      diagnostics: createTranslationDiagnostics({
        language,
        provider,
        providerModel: actualProviderModel,
        reason: "translated",
        retryCount: languageState?.retryCount || job.providerRetryAttempts?.get?.(language) || 0,
        latencyMs: Date.now() - job.startedAt,
        requestId: languageState?.requestId || `${job.id}:${language}`,
        socketId: languageState?.socketId || session?.socketId || "",
        status: "translated",
        fallbackProvider: languageState?.fallbackProvider || (job.providerFallbackLanguages?.has?.(language) ? "provider-fallback" : undefined),
        httpStatus: languageState?.httpStatus || null
      }),
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
      providerModel: actualProviderModel,
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
    lastTranslatedTranscriptAt = Date.now();

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
      if (sessionStopped) return;
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
      if (sessionStopped) return;

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
    }, getRetryDelay({ attempt: attempt + 1, baseMs: PROVIDER_RETRY_DELAY_MS, maxMs: PROVIDER_RETRY_MAX_DELAY_MS }));
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
      if (sessionStopped) return;
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

      if (!sessionStopped && !job.stale && !staleTranslationJobs.has(job.id)) {
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
    const dispatchDelayMs = Number(process.env.TRANSLATION_DISPATCH_DELAY_MS || DEFAULT_TRANSLATION_DISPATCH_DELAY_MS);
    const safeDispatchDelayMs = Math.max(MIN_TRANSLATION_DISPATCH_DELAY_MS, Math.min(MAX_TRANSLATION_DISPATCH_DELAY_MS, Number.isFinite(dispatchDelayMs) ? dispatchDelayMs : DEFAULT_TRANSLATION_DISPATCH_DELAY_MS));

    const processLanguage = async (language, context = {}) => {
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
        jobId: job.id,
        queueLength: context.queueLength || 0,
        activeWorkers: context.activeWorkers || 0,
        requestId: context.requestId || `${job.id}:${language}`
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
            jobId: job.id,
            job,
            queueLength: context.queueLength || 0,
            activeWorkers: context.activeWorkers || 0,
            requestId: context.requestId || `${job.id}:${language}`
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
          emitTranslationUpdate(job, language, translatedText, provider, result?.providerModel || null);
          logTranslationEvent("LANGUAGE_SUCCESS", {
            sessionId,
            sequence: job.sequence,
            language,
            provider,
            providerModel: result?.providerModel || null,
            latency: Date.now() - languageStartedAt,
            jobId: job.id,
            requestId: context.requestId || `${job.id}:${language}`
          });
        } else {
          finishSequentialLanguage(job, language, "failed");
          const providerFailure = result?.error;
          markTranslationLanguageFailed(job, language, {
            message: providerFailure?.reason || providerFailure?.message || "empty_or_invalid_translation",
            provider,
            providerModel: result?.providerModel || providerFailure?.providerModel || providerFailure?.model || null,
            requestId: context.requestId || `${job.id}:${language}`,
            providerResponse: providerFailure?.message || translatedText || "",
            statusCode: getErrorStatusCode(providerFailure),
            latencyMs: Date.now() - languageStartedAt
          }, provider);
          logTranslationEvent("LANGUAGE_FAILED", {
            sessionId,
            sequence: job.sequence,
            language,
            provider,
            providerModel: result?.providerModel || providerFailure?.providerModel || providerFailure?.model || null,
            latency: Date.now() - languageStartedAt,
            jobId: job.id,
            requestId: context.requestId || `${job.id}:${language}`
          });
        }
      } catch (error) {
        if (!job.stale && !staleTranslationJobs.has(job.id)) {
          noteTranslationFailure(language, error);
          finishSequentialLanguage(job, language, "failed");
          markTranslationLanguageFailed(job, language, {
            message: error?.reason || error?.message || "translation_failed",
            provider: "orchestrator",
            providerModel: error?.providerModel || error?.model || null,
            requestId: context.requestId || `${job.id}:${language}`,
            providerResponse: error?.message || String(error),
            statusCode: getErrorStatusCode(error),
            latencyMs: Date.now() - languageStartedAt
          }, "orchestrator");
          logTranslationEvent("LANGUAGE_FAILED", {
            sessionId,
            sequence: job.sequence,
            language,
            provider: "orchestrator",
            latency: Date.now() - languageStartedAt,
            jobId: job.id,
            requestId: context.requestId || `${job.id}:${language}`
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

    const dispatchQueue = createPerLanguageDispatchQueue({
      languages: targetLanguages,
      concurrency: MAX_CONCURRENT_TRANSLATION_LANGUAGES,
      requestDelayMs: safeDispatchDelayMs,
      maxRetries: MAX_PROVIDER_RETRY_ATTEMPTS,
      worker: async (language, context = {}) => processLanguage(language, context),
      onEvent: ({ type, language, requestId, queueLength, activeWorkers, attempt, requestDelayMs }) => {
        logTranslationEvent("TRANSLATION_QUEUE_STATE", {
          sessionId,
          jobId: job.id,
          targetLang: language,
          event: type,
          requestId,
          queueLength,
          activeWorkers,
          attempt,
          requestDelayMs,
          targetLanguages: targetLanguages.join(",")
        });
      }
    });

    await dispatchQueue.run();

    finalizeTranslationJobIfReady(job);
  };

  let activeJobsCount = 0;
  const MAX_CONCURRENT_JOBS = 4;

  const processSessionTranslationQueue = async () => {
    if (sessionStopped) return;
    if (activeJobsCount >= MAX_CONCURRENT_JOBS) return;

    while (!sessionStopped && sessionTranslationQueue.queue.length > 0 && activeJobsCount < MAX_CONCURRENT_JOBS) {
      const job = sessionTranslationQueue.queue.shift();
      if (!job || job.stale || job.completed || staleTranslationJobs.has(job.id)) continue;

      activeJobsCount += 1;
      sessionTranslationQueue.processing = true;
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

      void (async () => {
        try {
          await processSequentialTranslationJob(job);
        } catch (error) {
          for (const language of job.direction.targets.slice(0, MAX_TARGET_LANGUAGES)) {
            if (job.translations?.[language] || job.completedLanguages?.has?.(language)) continue;
            markTranslationLanguageFailed(job, language, error?.message || "translation_orchestrator_failed", "orchestrator");
          }
          finalizeTranslationJobIfReady(job);
        } finally {
          activeJobsCount -= 1;
          if (activeJobsCount === 0) {
            sessionTranslationQueue.processing = false;
          }
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
          void processSessionTranslationQueue();
        }
      })();
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

    if (sessionStopped) {
      logPipelineDecision("skipped because session closed", { source: "emitStableSentence" });
      return;
    }

    const sentence = cleanTranscriptText(currentSentence);
    const normalizedSentence = normalizeTranscript(sentence);
    const baseDirection = { ...currentDirection, targets: [...currentDirection.targets] };
    const detectedLanguage = currentDetectedLanguage;
    currentSentence = "";
    lastInterimTranscript = "";

    const recentTranslatedDuplicate =
      normalizedSentence === lastTranslatedTranscript &&
      Date.now() - lastTranslatedTranscriptAt < TRANSLATED_SENTENCE_DUPLICATE_WINDOW_MS;

    if (!sentence || !hasMeaningfulTranslationText(sentence)) {
      logPipelineDecision("skipped because transcript empty", { source: "emitStableSentence" });
      return;
    }

    if (recentTranslatedDuplicate || hasQueuedTranslationForSentence(normalizedSentence)) {
      logPipelineDecision("skipped because utterance already finalized", {
        source: "emitStableSentence",
        normalizedSentence,
        reason: recentTranslatedDuplicate ? "recent_duplicate" : "queued_translation"
      });
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
    finalizedUtteranceCount += 1;
    console.info("[UTTERANCE_FINALIZED]", { sessionId, utterance: finalizedUtteranceCount, chars: sentence.length, deepgramSessionOpen: !sessionStopped });

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
      languageStates: new Map(),
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
    console.info("[TRANSLATION_STARTED]", { sessionId, jobId, sequence: jobSequence, chars: translationInput.length, targetLanguages: direction.targets });

    logPipelineDecision("translation job created", {
      jobId,
      sequence: jobSequence,
      targetLanguages: direction.targets,
      chars: translationInput.length
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
      if (sessionStopped) return;
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

  let latestSpeechSignal = "";
  let utteranceBoundaryPending = false;
  const session = createDeepgramSession({
    apiKey: env.deepgramApiKey,
    sourceLang,
    mimeType,
    clientFactory: deepgramClientFactory,
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
    onGenerationChange: onAudioStreamReset,
    onSpeechSignal: ({ type }) => {
      latestSpeechSignal = type || "";
      if (type !== "utterance_end" || !currentSentence.trim()) return;
      onResult?.({
        originalText: currentSentence,
        translatedText: "",
        isFinal: false,
        utteranceEnd: true,
        sourceLang: currentDirection.source,
        targetLang: currentDirection.target,
        targetLanguages: currentDirection.targets,
        detectedLanguage: currentDetectedLanguage
      });
      latestSpeechSignal = "";
    },
    onTranscript: async ({ text, isFinal, speechFinal, detectedLanguage }) => {
      const displayText = cleanTranscriptText(text);
      const normalized = normalizeTranscript(displayText);

      if (!normalized) {
        logPipelineDecision("skipped because transcript empty", { source: "onTranscript", isFinal: Boolean(isFinal), speechFinal: Boolean(speechFinal) });
        return;
      }
      if (sessionStopped) {
        logPipelineDecision("skipped because session closed", { source: "onTranscript", isFinal: Boolean(isFinal), speechFinal: Boolean(speechFinal) });
        return;
      }
      logPipelineDecision("entered translation pipeline", {
        source: "onTranscript",
        isFinal: Boolean(isFinal),
        speechFinal: Boolean(speechFinal),
        chars: displayText.length
      });
      if (finalizedUtteranceCount > 0) {
        console.info("[DEEPGRAM_MESSAGE_AFTER_FINAL]", { sessionId, utterance: finalizedUtteranceCount + 1, chars: displayText.length, isFinal: Boolean(isFinal), speechFinal: Boolean(speechFinal) });
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

        const recentFinalDuplicate =
          normalized === lastFinalTranscript &&
          Date.now() - lastFinalTranscriptAt < FINAL_TRANSCRIPT_DUPLICATE_WINDOW_MS;

        if (previewNormalized === lastInterimTranscript || recentFinalDuplicate) {
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
          detectedLanguage: effectiveDetectedLanguage,
          speechStarted: latestSpeechSignal === "speech_started"
        });
        emitStreamingTranslationPreview({
          sentence: previewText,
          direction,
          detectedLanguage: effectiveDetectedLanguage
        });
        return;
      }

      const recentFinalDuplicate =
        normalized === lastFinalTranscript &&
        Date.now() - lastFinalTranscriptAt < FINAL_TRANSCRIPT_DUPLICATE_WINDOW_MS;
      if (recentFinalDuplicate) {
        return;
      }
      lastFinalTranscript = normalized;
      lastFinalTranscriptAt = Date.now();
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
      lastInterimTranscript = normalizeTranscript(currentSentence);
      onResult?.({
        originalText: currentSentence,
        translatedText: "",
        isFinal: false,
        providerFinal: true,
        speechFinal: Boolean(speechFinal),
        utteranceEnd: latestSpeechSignal === "utterance_end",
        sourceLang: direction.source,
        targetLang: direction.target,
        targetLanguages: direction.targets,
        detectedLanguage: effectiveDetectedLanguage
      });
      emitStreamingTranslationPreview({
        sentence: currentSentence,
        direction,
        detectedLanguage: effectiveDetectedLanguage
      });
      if (Boolean(speechFinal) || utteranceBoundaryPending) {
        if (speechFinal) {
          logPipelineDecision("entered translation pipeline", { source: "speechFinal", isFinal: Boolean(isFinal), speechFinal: true, chars: displayText.length });
        }
        utteranceBoundaryPending = false;
        scheduleStableTranslation(0);
      }
      latestSpeechSignal = "";
    }
  });

  const completeDeepgramUtterance = session.completeUtterance;
  session.completeUtterance = () => {
    completeDeepgramUtterance?.();
    if (sessionStopped) return false;
    if (!currentSentence.trim()) {
      utteranceBoundaryPending = true;
      logTranslationEvent("UTTERANCE_BOUNDARY_PENDING", { sessionId });
      return true;
    }
    utteranceBoundaryPending = false;
    scheduleStableTranslation(0);
    return true;
  };

  session.id = sessionId;
  session.sessionId = sessionId;
  session.transcriptHistory = [];
  session.getTranslationHealth = getTranslationHealth;
  rememberSessionHistory(sessionId, session.transcriptHistory);
  const stopDeepgramSession = session.stop;
  session.stop = () => {
    sessionStopped = true;
    utteranceBoundaryPending = false;
    providerStreamingPreviewSequence += 1;
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
    for (const controllers of providerAbortControllersByJob.values()) {
      for (const controller of controllers) controller?.abort?.();
    }
    providerAbortControllersByJob.clear();
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
