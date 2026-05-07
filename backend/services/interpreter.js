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

const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|hmm+|you know|i mean)\b[,\s]*/gi;
const MAX_TRANSCRIPT_HISTORY = 500;
const MAX_STORED_SESSIONS = 100;
const MAX_TARGET_LANGUAGES = 3;
const SENTENCE_DEBOUNCE_MS = 360;
const SHORT_PAUSE_DEBOUNCE_MS = 700;
const SILENCE_DEBOUNCE_MS = 700;
const LOCAL_LANGUAGE_CONFIDENCE_THRESHOLD = 0.7;
const TRANSLATION_LANE_FAST_LOCAL = "fastLocal";
const TRANSLATION_LANE_PROVIDER = "provider";
const FAST_LOCAL_LANGUAGE_CODES = new Set(["rw", "rn", "sw", "luganda"]);
const FAST_LOCAL_MAX_ACTIVE_TRANSLATIONS = 8;
const PROVIDER_MAX_ACTIVE_TRANSLATIONS = 4;
const MAX_TRANSLATION_LANE_QUEUE_SIZE = 10;
const STALE_JOB_TIMEOUT = 5500;
const TRANSLATION_RATE_LIMIT_DELAY_MS = 80;
const CIRCUIT_BREAKER_LATENCY_THRESHOLD_MS = 3000;
const LATENCY_WINDOW_SIZE = 5;
const MAX_CONSECUTIVE_TRANSLATION_FAILURES = 3;

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
const ADMIN_STATS_EMIT_MS = 10000;
const TRANSLATION_ATTEMPT_TIMEOUT_MS = 2500;
const PROVIDER_FALLBACK_STAGGER_MS = 450;
const PROVIDER_FAILURE_THRESHOLD = 3;
const PROVIDER_COOLDOWN_MS = 45000;
const SESSION_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_HEALTH_CHECK_MS = 2500;
const MAX_STALE_TRANSLATION_JOBS = 40;
const MAX_PENDING_SENTENCE_CHARS = 1400;
const sessionHistoryStore = new Map();
const sharedTranslationCache = new Map();

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

const normalizeInterpreterLanguageCode = (language = "") => {
  const normalized = String(language || "").trim().toLowerCase().replace("_", "-");
  if (!normalized) return "";
  if (normalized === "lg" || normalized === "lg-ug" || normalized === "lug" || normalized === "luganda") return "luganda";
  if (normalized.startsWith("rw")) return "rw";
  if (normalized.startsWith("rn")) return "rn";
  if (normalized.startsWith("sw")) return "sw";
  if (normalized.startsWith("en")) return "en";
  return normalized.split("-")[0] || normalized;
};

const isFastLocalLaneLanguage = ({ sourceLang = "", targetLang = "" } = {}) => {
  const source = normalizeInterpreterLanguageCode(sourceLang);
  const target = normalizeInterpreterLanguageCode(targetLang);

  if (FAST_LOCAL_LANGUAGE_CODES.has(target)) return true;
  if (target === "en" && FAST_LOCAL_LANGUAGE_CODES.has(source)) return true;
  return source === "en" && target === "en";
};

const triggerBackgroundRetry = (params) => {
  const { job, language, translateInLane, emitUpdate, retryTimers } = params;
  const jitteredDelay = 1500 + Math.random() * 2000;

  const retryTimer = setTimeout(async () => {
    retryTimers?.delete(retryTimer);
    if (!job || job.stale) return;

    try {
      const result = await translateInLane({
        language,
        translationInput: job.translationInput,
        direction: job.direction,
        translationContext: job.translationContext,
        jobId: job.id
      });

      const translatedText = String(result?.text || result || "").trim();
      if (translatedText && !job.stale) {
        job.translations[language] = translatedText;
        emitUpdate?.(translatedText, result?.provider || "retry");
      }
    } catch (error) {
      void error;
    }
  }, jitteredDelay);
  retryTimer.unref?.();

  retryTimers?.add(retryTimer);
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

const isCacheableTranslation = ({ text = "", sourceText = "", provider = "" } = {}) => {
  const cleanText = cleanTranscriptText(text);
  if (!cleanText || isProviderFailureText(cleanText)) return false;
  if (provider === "failed" || provider === "source") return false;
  if (!hasMeaningfulTranslationText(cleanText)) return false;
  if (sourceText && normalizeTranscript(cleanText) === normalizeTranscript(sourceText) && provider !== "local") return false;
  return true;
};

const pruneTranslationCache = (cache = sharedTranslationCache) => {
  const now = Date.now();

  for (const [key, entry] of cache.entries()) {
    if (!entry?.expiresAt || entry.expiresAt <= now) cache.delete(key);
  }

  while (cache.size > MAX_TRANSLATION_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
};

const readCachedTranslation = (cache, key) => {
  const entry = cache.get(key);
  if (!entry) return "";

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return "";
  }

  cache.delete(key);
  cache.set(key, entry);
  return entry.text;
};

const rememberCachedTranslation = (cache, key, value, metadata = {}) => {
  if (!key || !isCacheableTranslation({ text: value, sourceText: metadata.sourceText, provider: metadata.provider })) return;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, {
    text: cleanTranscriptText(value),
    provider: metadata.provider || "unknown",
    createdAt: Date.now(),
    expiresAt: Date.now() + translationCacheTtlMs({ source: metadata.source, target: metadata.target })
  });

  pruneTranslationCache(cache);
};

const sourceLanguageFallbackText = ({ text = "", sourceLang = "" } = {}) => {
  const cleanText = cleanTranscriptText(text);
  const source = normalizeInterpreterLanguageCode(sourceLang) || String(sourceLang || "source").trim().toLowerCase() || "source";
  return cleanText ? `[${source.toUpperCase()}] ${cleanText}` : "";
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
  const lastSuccessfulTranslations = new Map();
  const styleMemoryByLanguage = new Map();
  const translationCache = sharedTranslationCache;
  const staleTranslationJobs = new Set();
  const translationJobs = new Map();
  const backgroundRetryTimers = new Set();
  const translationLanes = {};
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
    const language = normalizeInterpreterLanguageCode(laneTargetLang) || String(laneTargetLang || "default").trim().toLowerCase() || "default";
    const laneId = `${group}:${language}`;

    if (!translationLanes[laneId]) {
      translationLanes[laneId] = createTranslationLane({ group, language });
    }

    return translationLanes[laneId];
  };
  const localSourceMemory = {
    language: null,
    confidence: 0,
    transcriptHistory: []
  };
  let translationJobSequence = 0;
  let lastStreamingPreviewAt = 0;
  let lastStreamingPreviewSignature = "";
  let lastAdminStatsAt = 0;
  const sessionId = createSessionId();
  const providerHealth = {
    gemini: { failures: 0, cooldownUntil: 0, lastSuccessAt: 0 },
    openai: { failures: 0, cooldownUntil: 0, lastSuccessAt: 0 }
  };

  let lastHealthState = "";

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
      job.pendingLanguages?.clear?.();
      job.runningLanguages?.clear?.();
    }
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
    lane.tripped = lane.latencyHistory.length >= 3 && avg > CIRCUIT_BREAKER_LATENCY_THRESHOLD_MS;

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
    void error;

    health.failures += 1;
    if (health.failures < PROVIDER_FAILURE_THRESHOLD) return;

    health.cooldownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
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
    const providers = Object.entries(providerHealth)
      .filter(([name, health]) => {
        const hasKey = name === "gemini" ? env.geminiApiKey : env.openaiApiKey;
        return hasKey && Date.now() >= health.cooldownUntil;
      });

    return providers.sort((a, b) => {
      if (a[1].failures !== b[1].failures) return a[1].failures - b[1].failures;

      let primaryChoice = userPlan === "pro" ? "openai" : "gemini";
      if (userPlan === "pro" && preferredProvider && preferredProvider !== "auto") {
        primaryChoice = preferredProvider;
      }

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

    if (source && source === target) {
      return enhanceTranslation({ text: cleanTranscriptText(translationInput), targetLang: language });
    }

    if (target === "en" && FAST_LOCAL_LANGUAGE_CODES.has(source)) {
      const mixedSpeech = normalizeMixedSpeech(translationInput);
      if (mixedSpeech.isMixed) return cleanTranscriptText(mixedSpeech.normalizedText);
    }

    return "";
  };

  const translateFastLocalLanguage = async ({ language, translationInput, direction, translationContext }) => {
    const languageTranslationContext = languageTranslationContextFor(language, translationContext);
    const cacheKey = translationCacheKey({ source: direction.source, target: language, text: translationInput });
    const cachedTranslation = readCachedTranslation(translationCache, cacheKey);

    if (cachedTranslation) {
      noteTranslationSuccess(language, cachedTranslation, languageTranslationContext);
      return { text: cachedTranslation, provider: "cache" };
    }

    const localTranslation = String(resolveFastLocalTranslation({ language, translationInput, direction }) || "").trim();
    if (localTranslation) {
      noteTranslationSuccess(language, localTranslation, languageTranslationContext);
      rememberCachedTranslation(translationCache, cacheKey, localTranslation, {
        source: direction.source,
        target: language,
        sourceText: translationInput,
        provider: "local"
      });
      return { text: localTranslation, provider: "local" };
    }

    return { text: sourceLanguageFallbackText({ text: translationInput, sourceLang: direction.source }), provider: "source" };
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

    try {
      const translatedText = await withTimeout(
        providerRunner(provider)({
          apiKey: provider === "gemini" ? env.geminiApiKey : env.openaiApiKey,
          text: translationInput,
          sourceLang: direction.source,
          targetLang: language,
          translationContext: languageTranslationContext
        }),
        TRANSLATION_ATTEMPT_TIMEOUT_MS,
        `${providerName} translation timed out for ${language}`
      );
      const responseTimeMs = Date.now() - attemptStartedAt;
      const safeTranslatedText = String(translatedText || "").trim();

      if (safeTranslatedText) {
        trackUsage(provider, 150);
        return {
          provider,
          translatedText: safeTranslatedText,
          responseTimeMs
        };
      }

      return {
        provider,
        responseTimeMs,
        error: new Error(`Empty ${providerName} translation response`)
      };
    } catch (error) {
      return {
        provider,
        error,
        responseTimeMs: Date.now() - attemptStartedAt
      };
    }
  };

  const waitForNextProviderResult = (pendingAttempts) =>
    Promise.race(pendingAttempts.map((promise, index) => promise.then((result) => ({ result, index }))));

  const translateProviderLanguageWithRecovery = async ({ language, translationInput, direction, translationContext, jobId }) => {
    let lastError = null;
    const languageTranslationContext = languageTranslationContextFor(language, translationContext);
    const cacheKey = translationCacheKey({ source: direction.source, target: language, text: translationInput });
    const cachedTranslation = readCachedTranslation(translationCache, cacheKey);

    if (cachedTranslation) {
      noteTranslationSuccess(language, cachedTranslation, languageTranslationContext);
      return { text: cachedTranslation, provider: "cache" };
    }

    const healthyProviders = getHealthyProviders();

    const pendingAttempts = [];
    const startProvider = (provider) =>
      runProviderTranslationAttempt({
        provider,
        language,
        translationInput,
        direction,
        languageTranslationContext,
        jobId
      });
    const consumeProviderResult = (result) => {
      if (!result) return "";
      if (result.stale) {
        lastError = result.error;
        return "";
      }

      if (result.translatedText) {
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

      lastError = result.error || new Error(`${result.provider || "Provider"} did not return a translation`);
      if (result.provider) noteProviderFailure(result.provider, lastError);
      return { text: "", provider: result.provider };
    };

    for (let i = 0; i < healthyProviders.length; i++) {
      const provider = healthyProviders[i];

      if (i === 0) {
        pendingAttempts.push(startProvider(provider));
        continue;
      }

      if (pendingAttempts.length > 0) {
        const raced = await Promise.race([
          pendingAttempts[0].then((result) => ({ type: "result", result })),
          delay(PROVIDER_FALLBACK_STAGGER_MS).then(() => ({ type: "stagger" }))
        ]);

        if (raced.type === "result") {
          pendingAttempts.shift();
          const translatedText = consumeProviderResult(raced.result);
          if (translatedText?.text) return translatedText;
        }
      }

      if (!staleTranslationJobs.has(jobId)) pendingAttempts.push(startProvider(provider));
    }

    while (pendingAttempts.length > 0 && !staleTranslationJobs.has(jobId)) {
      const { result, index } = await waitForNextProviderResult(pendingAttempts);
      pendingAttempts.splice(index, 1);
      const translatedText = consumeProviderResult(result);
      if (translatedText?.text) return translatedText;
    }

    noteTranslationFailure(language, lastError);

    const failureCachedTranslation = readCachedTranslation(translationCache, cacheKey);
    if (failureCachedTranslation) {
      noteTranslationSuccess(language, failureCachedTranslation, languageTranslationContext);
      return { text: failureCachedTranslation, provider: "cache" };
    }

    const fallbackTranslation = String(lastSuccessfulTranslations.get(language) || "").trim();
    if (fallbackTranslation) {
      return { text: fallbackTranslation, provider: "fallback" };
    }

    return { text: sourceLanguageFallbackText({ text: translationInput, sourceLang: direction.source }), provider: "source" };
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
    staleTranslationJobs.add(job.id);
    job.pendingLanguages.clear();
    job.runningLanguages.clear();
    removeTranslationJob(job.id);

    void reason;
  };

  const discardQueuedTranslationTask = (lane, task, reason) => {
    if (!task || task.stale) return;

    task.stale = true;
    const { job, language } = task;

    if (job && !job.stale && !staleTranslationJobs.has(job.id)) {
      job.pendingLanguages.delete(language);
      job.runningLanguages.delete(language);
      job.completedLanguages.add(language);
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
      const cachedTranslation = readCachedTranslation(translationCache, cacheKey);
      const laneGroup = translationLaneForLanguage({ sourceLang: direction.source, targetLang: language });
      let translatedText = cachedTranslation;

      if (!translatedText && laneGroup === TRANSLATION_LANE_FAST_LOCAL) {
        translatedText = resolveFastLocalTranslation({ language, translationInput, direction });
      }

      if (!translatedText) {
        translatedText = sourceLanguageFallbackText({ text: translationInput, sourceLang: direction.source });
      }

      if (translatedText) translations[language] = translatedText;
    }

    const translatedText = translations[direction.target] || Object.values(translations).find(Boolean) || "";
    if (!translatedText) return;

    const signature = `${normalizeTranscript(cleanSentence)}|${JSON.stringify(translations)}`;
    if (signature === lastStreamingPreviewSignature) return;

    lastStreamingPreviewAt = now;
    lastStreamingPreviewSignature = signature;

    onResult?.({
      original: cleanSentence,
      originalText: cleanSentence,
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
    if (!translatedText || job.stale || staleTranslationJobs.has(job.id)) return;

    job.translations[language] = translatedText;
    const translationOutputs = translationOutputsForJob(job);

    onResult?.({
      original: job.sentence,
      originalText: job.sentence,
      translatedText: job.translations[job.direction.target] || translatedText,
      translations: { ...job.translations },
      translationOutputs,
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
    }

    onResult?.({
      original: job.sentence,
      originalText: job.sentence,
      translatedText,
      translations: { ...job.translations },
      translationOutputs: translationOutputsForJob(job),
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

  const finishTranslationTask = (lane, job, language, taskKey) => {
    const activeTask = lane.activeTasks.get(taskKey);
    if (!activeTask) return false;

    updateLaneLatency(lane, Date.now() - activeTask.startedAt);
    lane.activeTasks.delete(taskKey);
    job.runningLanguages.delete(language);
    job.completedLanguages.add(language);
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
      job.lastProviderUsed = provider;

      if (!finishTranslationTask(lane, job, language, taskKey)) {
        scheduleTranslationDrain(lane.id);
        return;
      }

      if (!job.stale && !staleTranslationJobs.has(job.id)) {
        const safeTranslatedText = String(translatedText || "").trim();

        if (safeTranslatedText) {
          emitTranslationUpdate(job, language, safeTranslatedText, provider);

          const isFallback = provider === "source" ||
                            safeTranslatedText === job.translationInput ||
                            safeTranslatedText === lastSuccessfulTranslations.get(language);

          if (isFallback && lane.group === TRANSLATION_LANE_PROVIDER) {
            triggerBackgroundRetry({
              job,
              language,
              translateInLane,
              retryTimers: backgroundRetryTimers,
              emitUpdate: (retryText, retryProvider) => emitTranslationUpdate(job, language, retryText, retryProvider)
            });
          }
        } else if (lane.group === TRANSLATION_LANE_PROVIDER) {
          triggerBackgroundRetry({
            job,
            language,
            translateInLane,
            retryTimers: backgroundRetryTimers,
            emitUpdate: (retryText, retryProvider) => emitTranslationUpdate(job, language, retryText, retryProvider)
          });
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

    for (const lane of lanes) {
      for (const [taskKey, task] of lane.activeTasks.entries()) {
        if (now - task.startedAt < STALE_JOB_TIMEOUT) continue;

        const job = task.job || translationJobs.get(task.jobId);
        lane.activeTasks.delete(taskKey);
        task.stale = true;

        if (job) {
          job.runningLanguages.delete(task.language);
          job.completedLanguages.add(task.language);
          if (lane.group === TRANSLATION_LANE_PROVIDER) noteTranslationFailure(task.language, new Error("Translation task became stale"));
          finalizeTranslationJobIfReady(job);
        }

      }

      for (let index = lane.queue.length - 1; index >= 0; index -= 1) {
        const task = lane.queue[index];
        if (!task?.createdAt || now - task.createdAt < STALE_JOB_TIMEOUT * 2) continue;

        lane.queue.splice(index, 1);
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

  const enqueueTranslationJob = (job) => {
    translationJobs.set(job.id, job);
    const lanesToDrain = new Set();

    job.direction.targets.slice(0, MAX_TARGET_LANGUAGES).forEach((language) => {
      const instantLocal = resolveLocalTranslation({
        text: job.translationInput,
        sourceLang: job.direction.source,
        targetLang: language
      });

      if (instantLocal) {
        emitTranslationUpdate(job, language, instantLocal, "local");
      }

      const lane = getTranslationLane({ sourceLang: job.direction.source, targetLang: language });

      lane.queue.push({
        id: translationTaskKey(job.id, language),
        jobId: job.id,
        job,
        language,
        laneId: lane.id,
        createdAt: job.createdAt,
        startedAt: 0,
        stale: false
      });
      lanesToDrain.add(lane.id);
    });

    for (const laneId of lanesToDrain) {
      const lane = translationLanes[laneId];
      pruneTranslationLaneQueue(lane);
      scheduleTranslationDrain(lane.id);
    }

    if (lanesToDrain.size === 0) {
      finalizeTranslationJobIfReady(job);
    }
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

    const localDetection = resolveSourceLanguage({ text: sentence, providerDetectedLanguage: detectedLanguage });
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

      const localDetection = resolveSourceLanguage({ text: displayText, providerDetectedLanguage: detectedLanguage });
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
      currentDirection = direction;
      currentDetectedLanguage = effectiveDetectedLanguage;
      rememberLocalSourceLanguage({
        text: displayText,
        language: effectiveDetectedLanguage,
        confidence: localDetection.confidence
      });
      currentSentence = trimTextWindow(appendSentenceChunk(currentSentence, displayText));
      scheduleStableTranslation(0);
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
