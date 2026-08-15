import { env } from "../config/env.js";
import { LANGUAGE_NAMES, TARGET_LANGUAGE_INSTRUCTIONS } from "../data/languageMemory.js";
import { enhanceTranslation } from "../utils/translationEnhancer.js";
import {
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode,
  providerLanguageCode,
  supportedLanguageList
} from "../../shared/languages.mjs";
import {
  delay,
  getErrorStatusCode,
  getRetryAfterMs,
  getRetryDelay,
  mergeAbortSignals,
  normalizeForComparison,
  normalizeProviderText,
  providerErrorMessage
} from "./providerUtils.js";

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";
// Single source of truth for the Gemini HTTP timeout budget: interpreter.js's outer
// per-attempt AbortController/Promise.race timeout imports this instead of hardcoding its own
// matching constant, so the two timeout layers can never silently drift apart.
export const GEMINI_TIMEOUT_MS = 25000;
const GEMINI_MAX_ATTEMPTS = 3;
const GEMINI_RETRY_BASE_MS = 1000;
const GEMINI_RETRY_MAX_MS = 4000;
const SUPPORTED_LANGUAGE_LIST = supportedLanguageList();

export const normalizeGeminiModel = (value = "") => {
  const normalized = String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/^(?:models\/)+/i, "");
  return normalized || DEFAULT_GEMINI_MODEL;
};

export const GEMINI_MODEL = normalizeGeminiModel(
  process.env.GEMINI_MODEL || env.geminiModel || DEFAULT_GEMINI_MODEL
);

export const getGeminiModelOrder = (configuredModel = GEMINI_MODEL, verifiedFallbackModels = []) => {
  const models = [];
  const seen = new Set();

  for (const candidate of [configuredModel, DEFAULT_GEMINI_MODEL, ...verifiedFallbackModels]) {
    const model = normalizeGeminiModel(candidate);
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(model);
  }

  return models;
};

export const buildGeminiGenerateContentUrl = (model = GEMINI_MODEL) =>
  `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(normalizeGeminiModel(model))}:generateContent`;

export const buildGeminiModelsListUrl = () => `${GEMINI_API_BASE_URL}/models?pageSize=1000`;

export const listGeminiGenerateContentModels = async ({ apiKey, request = globalThis.fetch, signal } = {}) => {
  if (!apiKey) return [];

  const response = await request(buildGeminiModelsListUrl(), {
    method: "GET",
    signal,
    headers: { "X-goog-api-key": apiKey }
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const reason = data?.error?.message || data?.message || response.statusText || "Gemini models list failed";
    const error = new Error(reason);
    error.provider = "Gemini";
    error.status = response.status;
    error.statusCode = response.status;
    error.httpStatus = response.status;
    error.reason = reason;
    error.headers = response.headers;
    error.errorStatus = data?.error?.status || null;
    error.errorCode = data?.error?.code || null;
    error.errorDetails = Array.isArray(data?.error?.details) ? data.error.details : [];
    error.retryAfterMs = getRetryAfterMs(error) ?? parseGeminiRetryDelayMs(error);
    error.errorCategory = classifyGeminiError(error);
    throw error;
  }

  return (Array.isArray(data?.models) ? data.models : [])
    .filter((candidate) => Array.isArray(candidate?.supportedGenerationMethods) && candidate.supportedGenerationMethods.includes("generateContent"))
    .map((candidate) => normalizeGeminiModel(candidate.name))
    .filter(Boolean);
};

export const selectVerifiedGeminiFlashFallback = (models = [], excludedModels = []) => {
  const excluded = new Set(excludedModels.map((model) => normalizeGeminiModel(model).toLowerCase()));
  return models
    .map((model) => normalizeGeminiModel(model))
    .filter((model) => /gemini.*flash/i.test(model))
    .filter((model) => !/(?:preview|experimental|exp|image|tts)/i.test(model))
    .filter((model) => !excluded.has(model.toLowerCase()))
    .sort((a, b) => {
      const liteDifference = Number(/flash-lite/i.test(a)) - Number(/flash-lite/i.test(b));
      if (liteDifference !== 0) return liteDifference;
      return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
    })[0] || null;
};

const flattenGeminiErrorDetails = (error = {}) => {
  const details = Array.isArray(error?.errorDetails) ? error.errorDetails : [];
  const quotaViolations = details.flatMap((detail) => detail?.violations || detail?.quotaFailure?.violations || []);
  const raw = [
    error?.errorStatus,
    error?.errorCode,
    error?.reason,
    error?.message,
    JSON.stringify(details),
    ...details.map((detail) => detail?.reason || detail?.message || detail?.quotaMetric || detail?.quotaId),
    ...quotaViolations.flatMap((violation) => [violation?.quotaMetric, violation?.quotaId, violation?.description])
  ].filter(Boolean).join(" ").replace(/[_-]+/g, " ");
  // Google's real quotaId values (e.g. "GenerateRequestsPerMinutePerProjectPerModel") are
  // camelCase with no separators, so "per minute"/"per day" never appear as space-separated
  // words unless camelCase boundaries are split first.
  return raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
};

// Google's structured google.rpc.RetryInfo detail (retryDelay like "24s") is how the Gemini API
// actually communicates "retry shortly" for a rate limit — unlike OpenAI it does not use a
// Retry-After HTTP header for this. Its presence is a reliable signal that a 429 is a transient,
// self-healing rate limit rather than a genuine billing/account block, which never includes one.
const parseGeminiRetryDelayMs = (error = {}) => {
  const details = Array.isArray(error?.errorDetails) ? error.errorDetails : [];
  const retryInfo = details.find(
    (detail) => detail?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo" && detail?.retryDelay
  );
  const match = retryInfo ? /^(\d+(?:\.\d+)?)s$/.exec(String(retryInfo.retryDelay).trim()) : null;
  const seconds = match ? Number(match[1]) : NaN;
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
};

export const classifyGeminiError = (error = {}) => {
  const status = getErrorStatusCode(error);
  const details = flattenGeminiErrorDetails(error);
  if (status === 401 || /\b(?:api key not valid|invalid api key|unauthenticated)\b/i.test(details)) return "authentication_failure";
  if (status === 403 || /\bpermission denied\b/i.test(details)) return "permission_failure";
  if (status === 404 || /\b(?:model not found|unsupported model|model unavailable)\b/i.test(details)) return "model_unavailable";
  // Structured, per-period quota signals are checked BEFORE Google's generic "check your plan
  // and billing details" boilerplate. That boilerplate is included on every 429 Gemini returns —
  // including the free-tier per-minute cap, which self-heals in seconds — so it cannot by itself
  // distinguish a transient rate limit from an actual billing failure. The quotaId/quotaMetric
  // (and, failing that, a present RetryInfo.retryDelay) can.
  if (/\b(?:requests per minute|tokens per minute|rpm|tpm|too many requests)\b/i.test(details)) return "temporary_rate_limit";
  if (/\b(?:requests per day|daily quota|rpd|per day|quota limit reached|limit\s*:?\s*0|quota value["']?\s*:?\s*["']?0)\b/i.test(details)) return "daily_quota_exhausted";
  if (status === 429 && parseGeminiRetryDelayMs(error) !== null) return "temporary_rate_limit";
  if (/\b(?:billing|current quota exceeded|check your plan|credit balance|spend limit|usage limit)\b/i.test(details)) return "billing_quota_exhausted";
  if (status === 429) return "daily_quota_exhausted";
  if (status === 503 || /\b(?:overloaded|service unavailable|resource exhausted temporarily)\b/i.test(details)) return "provider_overloaded";
  if (error?.name === "AbortError" || /\b(?:timed? out|timeout|econnreset|fetch failed|network)\b/i.test(details)) return "network_timeout";
  return "unknown_provider_error";
};

const geminiHealth = {
  status: "idle",
  attempts: 0,
  successes: 0,
  failures: 0,
  retryCount: 0,
  lastSuccessAt: 0,
  lastFailureAt: 0,
  lastLatencyMs: 0,
  lastError: "",
  lastHttpStatus: null,
  lastModel: "",
  attemptedModels: []
};

const stripWrappedText = (value = "") => normalizeProviderText(value);

const noteGeminiSuccess = (latencyMs, model, attemptedModels) => {
  geminiHealth.status = "healthy";
  geminiHealth.successes += 1;
  geminiHealth.lastSuccessAt = Date.now();
  geminiHealth.lastLatencyMs = latencyMs;
  geminiHealth.lastError = "";
  geminiHealth.lastHttpStatus = 200;
  geminiHealth.lastModel = model;
  geminiHealth.attemptedModels = [...attemptedModels];
};

const noteGeminiFailure = (error, model, attemptedModels) => {
  geminiHealth.status = "degraded";
  geminiHealth.failures += 1;
  geminiHealth.lastFailureAt = Date.now();
  geminiHealth.lastLatencyMs = Number(error?.latencyMs) || 0;
  geminiHealth.lastError = error?.reason || providerErrorMessage(error);
  geminiHealth.lastHttpStatus = getErrorStatusCode(error);
  geminiHealth.lastModel = model;
  geminiHealth.attemptedModels = [...attemptedModels];
};

export const getGeminiHealth = () => ({
  ...geminiHealth,
  healthy: geminiHealth.status === "healthy" || (geminiHealth.successes > 0 && geminiHealth.lastFailureAt < geminiHealth.lastSuccessAt)
});

const normalizedLanguageCode = (code = "") => String(code || "").trim().toLowerCase();
const sanitizeTargetLanguageCode = (code = "") => {
  const normalized = normalizeLanguageCode(normalizedLanguageCode(code).replace("_", "-"));
  return normalized && SUPPORTED_LANGUAGE_CODES.has(normalized) ? normalized : "en";
};

const describeLanguage = (code = "") => {
  const normalizedCode = sanitizeTargetLanguageCode(code);
  const languageName = LANGUAGE_NAMES[normalizedCode];
  return languageName ? `${languageName} (${normalizedCode})` : String(code || "").trim();
};

const describeSourceLanguage = (code = "") => {
  const normalizedCode = normalizeLanguageCode(normalizedLanguageCode(code).replace("_", "-"));
  if (!normalizedCode || normalizedCode === "auto") {
    return "auto-detected source language";
  }
  const providerCode = providerLanguageCode(normalizedCode, "gemini") || normalizedCode;
  const languageName = SUPPORTED_LANGUAGE_CODES.has(normalizedCode) ? LANGUAGE_NAMES[normalizedCode] : "";
  return languageName ? `${languageName} (${providerCode})` : "auto-detected source language";
};

const targetLanguageInstructions = (targetLang = "") => TARGET_LANGUAGE_INSTRUCTIONS[sanitizeTargetLanguageCode(targetLang)] || [];

const normalizeTranslatedText = ({ text, targetLang }) => {
  const cleanText = stripWrappedText(text);
  return enhanceTranslation({ text: cleanText, targetLang });
};

const extractGeminiText = (response = {}) => {
  if (typeof response.text === "function") return String(response.text() || "").trim();
  if (typeof response.text === "string") return response.text.trim();

  const textParts = [];
  for (const candidate of response.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === "string") textParts.push(part.text);
    }
  }

  return textParts.join(" ").trim();
};

const contextInstructions = (translationContext = {}) => {
  const instructions = [];
  const accentProfile = translationContext.accentProfile;
  const emotionProfile = translationContext.emotionProfile;
  const styleMemory = translationContext.styleMemory;
  const mixedSpeech = translationContext.mixedSpeech;

  if (accentProfile?.instruction) {
    instructions.push(`Accent/region adaptation: ${accentProfile.instruction}`);
  }

  if (emotionProfile?.instruction) {
    instructions.push(`Tone adaptation: ${emotionProfile.instruction}`);
  }

  if (mixedSpeech?.isMixed && mixedSpeech.replacements?.length > 0) {
    const localNotes = mixedSpeech.replacements
      .slice(0, 6)
      .map(({ localPhrase, meaning }) => `${localPhrase} means ${meaning}`)
      .join("; ");
    instructions.push(`Mixed speech notes: ${localNotes}. Translate the intended meaning, not each word mechanically.`);
  }

  if (styleMemory?.lastTranslation) {
    instructions.push(
      `Speech memory: keep wording consistent with the previous ${styleMemory.region || "regional"} ${styleMemory.tone || "neutral"} style. Previous successful target-language style sample: ${styleMemory.lastTranslation}. Do not reuse this sample unless it has the same meaning as the new text.`
    );
  }

  if (styleMemory?.recentTranslations?.length > 0) {
    instructions.push(`Recent conversation style samples: ${styleMemory.recentTranslations.slice(-3).join(" | ")}.`);
  }

  return instructions;
};

// Production-safe diagnostics only: never logs GEMINI_API_KEY/OPENAI_API_KEY, auth headers, or
// full transcripts. Exists to answer, on the NEXT occurrence, exactly which stage of the HTTP
// round trip a stalled Gemini request is stuck in (connect, headers, or body) instead of guessing.
const logGeminiDiagnostic = (event, payload = {}) => {
  const safePayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    safePayload[key] = value;
  }
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), severity: "INFO", event, ...safePayload }));
};

const translateOnce = async ({ apiKey, model, text, sourceLang, targetLang, translationContext, timeoutMs = GEMINI_TIMEOUT_MS, signal, request = globalThis.fetch, sessionId, jobId, requestId }) => {
  const targetLanguage = describeLanguage(targetLang);
  const sourceLanguage = sourceLang ? describeSourceLanguage(sourceLang) : "auto-detected language";
  const controller = new AbortController();
  const mergedSignal = mergeAbortSignals(signal, controller.signal);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  const promptContextLines = [
    "You are a professional real-time interpreter.",
    `Translate the user's text from ${sourceLanguage} to ${targetLanguage}.`,
    `Supported input and output languages are: ${SUPPORTED_LANGUAGE_LIST}.`,
    `Translate to ${targetLanguage}.`,
    `The output language must be ${targetLanguage}.`,
    "Speak naturally like a real East African human interpreter, not a literal machine translator.",
    "Preserve slang meaning, emotion, respect level, personality, and conversational flow.",
    "Prefer local vocabulary and natural sentence structure over word-for-word translation.",
    "Avoid robotic, overly formal, or over-English phrasing.",
    "Never return English unless the target language is English (en) or the requested target is unsupported.",
    ...targetLanguageInstructions(targetLang),
    ...contextInstructions(translationContext),
    "Do not copy, echo, transliterate, explain, label, or quote the source text.",
    "Preserve tone, intent, names, numbers, and formatting where possible.",
    "Return only the translated text.",
    "",
    "Text:",
    text
  ];
  const promptText = promptContextLines.join("\n");
  const sourceChars = text?.length || 0;
  const contextChars = promptText.length - sourceChars;
  const requestBody = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 512 }
  });

  const requestStartedAt = Date.now();
  logGeminiDiagnostic("GEMINI_REQUEST_START", {
    sessionId,
    jobId,
    requestId,
    targetLanguage: targetLang,
    model,
    sourceChars,
    contextChars,
    estimatedRequestChars: requestBody.length,
    timeoutMs
  });

  let response;
  try {
    response = await request(buildGeminiGenerateContentUrl(model), {
      method: "POST",
      signal: mergedSignal.signal,
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": apiKey
      },
      body: requestBody
    });
    logGeminiDiagnostic("GEMINI_HTTP_RESPONSE", {
      sessionId,
      jobId,
      requestId,
      targetLanguage: targetLang,
      model,
      httpStatus: response.status,
      latencyMs: Date.now() - requestStartedAt
    });
  } catch (error) {
    logGeminiDiagnostic("GEMINI_REQUEST_ERROR", {
      sessionId,
      jobId,
      requestId,
      targetLanguage: targetLang,
      model,
      errorName: error?.name || null,
      errorCategory: timedOut || error?.name === "AbortError" ? "network_timeout" : null,
      httpStatus: null,
      latencyMs: Date.now() - requestStartedAt,
      aborted: Boolean(mergedSignal.signal?.aborted),
      timedOut
    });
    if (signal?.aborted) throw new Error("Gemini translation aborted");
    if (timedOut || error?.name === "AbortError") {
      const timeoutError = new Error(`Gemini translation timed out for ${targetLanguage}`);
      timeoutError.provider = "Gemini";
      timeoutError.providerModel = model;
      timeoutError.errorCategory = "network_timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    mergedSignal.cleanup();
  }

  const data = await response.json().catch(() => ({}));
  logGeminiDiagnostic("GEMINI_RESPONSE_PARSED", {
    sessionId,
    jobId,
    requestId,
    targetLanguage: targetLang,
    model,
    translatedTextLength: extractGeminiText(data).length,
    latencyMs: Date.now() - requestStartedAt
  });
  if (!response.ok) {
    const reason = data?.error?.message || data?.message || response.statusText || "Gemini request failed";
    const error = new Error(reason);
    error.provider = "Gemini";
    error.providerModel = model;
    error.model = model;
    error.status = response.status;
    error.statusCode = response.status;
    error.httpStatus = response.status;
    error.reason = reason;
    error.headers = response.headers;
    error.errorStatus = data?.error?.status || null;
    error.errorCode = data?.error?.code || null;
    error.errorDetails = Array.isArray(data?.error?.details) ? data.error.details : [];
    error.retryAfterMs = getRetryAfterMs(error) ?? parseGeminiRetryDelayMs(error);
    error.errorCategory = classifyGeminiError(error);
    logGeminiDiagnostic("GEMINI_REQUEST_ERROR", {
      sessionId,
      jobId,
      requestId,
      targetLanguage: targetLang,
      model,
      errorName: error.name,
      errorCategory: error.errorCategory,
      httpStatus: error.httpStatus,
      latencyMs: Date.now() - requestStartedAt,
      aborted: false,
      timedOut: false
    });
    throw error;
  }

  const translatedText = normalizeTranslatedText({ text: extractGeminiText(data), targetLang });
  if (!translatedText) {
    const error = new Error(`Gemini returned an empty translation for ${targetLanguage || targetLang}`);
    error.provider = "Gemini";
    error.providerModel = model;
    throw error;
  }

  return { text: translatedText, model };
};

export const translateWithGemini = async ({ apiKey, model = GEMINI_MODEL, text, sourceLang, targetLang, translationContext, signal, includeMetadata = false, request = globalThis.fetch, sleep = delay, sessionId, jobId, requestId, timeoutMs = GEMINI_TIMEOUT_MS }) => {
  const cleanText = text?.trim();

  if (!cleanText) {
    return "";
  }

  if (!apiKey) {
    return "";
  }

  if (signal?.aborted) {
    throw new Error("Gemini translation aborted");
  }

  let lastError = null;
  let retryCount = 0;
  let requestCount = 0;
  const operationStartedAt = Date.now();
  const attemptedModels = [];
  const candidateModels = getGeminiModelOrder(model);
  let modelDiscoveryAttempted = false;

  for (let modelIndex = 0; modelIndex < candidateModels.length; modelIndex += 1) {
    const candidateModel = candidateModels[modelIndex];
    attemptedModels.push(candidateModel);

    for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
      retryCount = requestCount;
      requestCount += 1;
      if (retryCount > 0) geminiHealth.retryCount += 1;
      geminiHealth.status = retryCount === 0 ? "requesting" : "retrying";
      geminiHealth.attempts += 1;

      try {
        const result = await translateOnce({
          apiKey,
          model: candidateModel,
          text: cleanText,
          sourceLang,
          targetLang,
          translationContext,
          timeoutMs,
          signal,
          request,
          sessionId,
          jobId,
          requestId
        });

        if (signal?.aborted) throw new Error("Gemini translation aborted");

        const echoedSource = normalizeForComparison(result.text) === normalizeForComparison(cleanText);
        if (!result.text || echoedSource) {
          const error = new Error(echoedSource ? "Gemini echoed the source text" : "Gemini returned an empty translation");
          error.provider = "Gemini";
          error.providerModel = candidateModel;
          throw error;
        }

        const latencyMs = Date.now() - operationStartedAt;
        noteGeminiSuccess(latencyMs, candidateModel, attemptedModels);
        const metadata = {
          text: result.text,
          provider: "gemini",
          model: candidateModel,
          providerModel: candidateModel,
          httpStatus: 200,
          retryCount,
          latencyMs,
          attemptedModels: [...attemptedModels]
        };
        return includeMetadata ? metadata : result.text;
      } catch (error) {
        if (signal?.aborted || /aborted/i.test(error?.message || "")) {
          throw new Error("Gemini translation aborted");
        }

        const status = getErrorStatusCode(error);
        error.provider = "Gemini";
        error.providerModel = error.providerModel || candidateModel;
        error.model = error.model || candidateModel;
        error.httpStatus = status;
        error.reason = error.reason || providerErrorMessage(error) || "Gemini translation failed";
        error.retryCount = retryCount;
        error.latencyMs = Date.now() - operationStartedAt;
        error.attemptedModels = [...attemptedModels];
        if (error.retryAfterMs === undefined) error.retryAfterMs = getRetryAfterMs(error);
        error.errorCategory = error.errorCategory || classifyGeminiError(error);
        lastError = error;
        noteGeminiFailure(error, candidateModel, attemptedModels);

        if (["authentication_failure", "permission_failure", "daily_quota_exhausted", "billing_quota_exhausted"].includes(error.errorCategory)) {
          error.providerRetryExhausted = true;
          throw error;
        }

        if (error.errorCategory === "model_unavailable") {
          if (!modelDiscoveryAttempted && modelIndex === candidateModels.length - 1) {
            modelDiscoveryAttempted = true;
            try {
              const verifiedModels = await listGeminiGenerateContentModels({ apiKey, request, signal });
              const verifiedFallback = selectVerifiedGeminiFlashFallback(verifiedModels, candidateModels);
              if (verifiedFallback) candidateModels.push(verifiedFallback);
            } catch (modelListError) {
              const listStatus = getErrorStatusCode(modelListError);
              modelListError.provider = "Gemini";
              modelListError.providerModel = candidateModel;
              modelListError.model = candidateModel;
              modelListError.httpStatus = listStatus;
              modelListError.reason = modelListError.reason || providerErrorMessage(modelListError) || "Gemini models list failed";
              modelListError.retryCount = retryCount;
              modelListError.latencyMs = Date.now() - operationStartedAt;
              modelListError.attemptedModels = [...attemptedModels];
              modelListError.providerRetryExhausted = true;
              lastError = modelListError;
              noteGeminiFailure(modelListError, candidateModel, attemptedModels);
              throw modelListError;
            }
          }
          break;
        }

        if (error.errorCategory === "temporary_rate_limit") {
          if (attempt >= GEMINI_MAX_ATTEMPTS) {
            error.providerRetryExhausted = true;
            throw error;
          }
          if (Number(error.retryAfterMs) > GEMINI_RETRY_MAX_MS) {
            error.providerRetryExhausted = true;
            throw error;
          }
          await sleep(getRetryDelay({
            attempt,
            baseMs: GEMINI_RETRY_BASE_MS,
            maxMs: GEMINI_RETRY_MAX_MS,
            error
          }));
          continue;
        }

        // A genuine network_timeout already consumed this attempt's full timeoutMs budget with
        // no response at all — retrying it here would silently multiply worst-case latency by
        // up to GEMINI_MAX_ATTEMPTS (e.g. 3 x 25s) for exactly the failure mode where that cost
        // matters most to a live interpreter. The caller (interpreter.js) already owns its own
        // retry/circuit-breaker decision for this provider via its own outer attempt loop and
        // cooldown tracking, so a hard stall must fail fast here and let that layer decide.
        const retryable = error.errorCategory !== "network_timeout" && (!status || [408, 409, 500, 502, 503, 504].includes(status));
        if (!retryable || attempt >= GEMINI_MAX_ATTEMPTS) {
          error.providerRetryExhausted = true;
          throw error;
        }

        await sleep(getRetryDelay({
          attempt,
          baseMs: GEMINI_RETRY_BASE_MS,
          maxMs: GEMINI_RETRY_MAX_MS,
          error: status === 503 ? null : error
        }));
      }
    }
  }

  if (lastError) {
    lastError.providerRetryExhausted = true;
    lastError.retryCount = retryCount;
    lastError.attemptedModels = [...attemptedModels];
    throw lastError;
  }

  throw new Error("Gemini translation failed");
};
