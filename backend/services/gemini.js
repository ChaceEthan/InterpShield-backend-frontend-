// @ts-nocheck
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
const GEMINI_FALLBACK_MODELS = [DEFAULT_GEMINI_MODEL, "gemini-3.1-flash-lite"];
const GEMINI_TIMEOUT_MS = 25000;
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

export const getGeminiModelOrder = (configuredModel = GEMINI_MODEL) => {
  const models = [];
  const seen = new Set();

  for (const candidate of [configuredModel, ...GEMINI_FALLBACK_MODELS]) {
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

const translateOnce = async ({ apiKey, model, text, sourceLang, targetLang, translationContext, timeoutMs = GEMINI_TIMEOUT_MS, signal, request = globalThis.fetch }) => {
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

  let response;
  try {
    response = await request(buildGeminiGenerateContentUrl(model), {
      method: "POST",
      signal: mergedSignal.signal,
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
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
                ].join("\n")
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 512
        }
      })
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Gemini translation aborted");
    if (timedOut || error?.name === "AbortError") {
      const timeoutError = new Error(`Gemini translation timed out for ${targetLanguage}`);
      timeoutError.provider = "Gemini";
      timeoutError.providerModel = model;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    mergedSignal.cleanup();
  }

  const data = await response.json().catch(() => ({}));
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
    error.retryAfterMs = getRetryAfterMs(error);
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

export const translateWithGemini = async ({ apiKey, model = GEMINI_MODEL, text, sourceLang, targetLang, translationContext, signal, includeMetadata = false, request = globalThis.fetch, sleep = delay }) => {
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

  for (const candidateModel of getGeminiModelOrder(model)) {
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
          timeoutMs: GEMINI_TIMEOUT_MS,
          signal,
          request
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
        lastError = error;
        noteGeminiFailure(error, candidateModel, attemptedModels);

        if (status === 401 || status === 403) {
          error.providerRetryExhausted = true;
          throw error;
        }

        if (status === 404) break;

        if (status === 429) {
          error.providerRetryExhausted = true;
          throw error;
        }

        const retryable = !status || [408, 409, 500, 502, 503, 504].includes(status);
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
