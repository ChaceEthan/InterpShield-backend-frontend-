// @ts-nocheck
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
  isNonRetryableProviderError,
  mergeAbortSignals,
  normalizeForComparison,
  normalizeProviderText,
  providerErrorMessage
} from "./providerUtils.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
export const OPENAI_TRANSLATION_MODEL = "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 22000;
const OPENAI_MAX_ATTEMPTS = 3;
const OPENAI_RETRY_BASE_MS = 1000;
const OPENAI_RETRY_MAX_MS = 4000;
const SUPPORTED_LANGUAGE_LIST = supportedLanguageList();

const OPENAI_QUOTA_PATTERN = /\b(?:insufficient quota|quota exceeded|current quota(?: has been)? exceeded|exceeded your current quota|check your plan and billing|billing not active|usage limit(?: has been)? reached|billing(?: hard)? limit(?: has been)? reached|billing|credit balance|spend limit)\b/i;
const OPENAI_RATE_LIMIT_PATTERN = /\b(?:rate limit exceeded|rate limit(?:ed)?|too many requests|requests per minute|tokens per minute|rpm|tpm)\b/i;

export const classifyOpenAIError = (error = {}) => {
  const status = getErrorStatusCode(error);
  const details = [error?.errorCode, error?.errorType, error?.reason, error?.message]
    .filter(Boolean)
    .join(" ")
    .replace(/[_-]+/g, " ");

  if (OPENAI_QUOTA_PATTERN.test(details)) return "billing_quota_exhausted";
  if (status === 401) return "authentication_failure";
  if (status === 403) return "permission_failure";
  if (OPENAI_RATE_LIMIT_PATTERN.test(details) || status === 429) return "temporary_rate_limit";
  if (status === 503) return "provider_overloaded";
  if (error?.name === "AbortError" || /\b(?:timed? out|timeout|econnreset|fetch failed|network)\b/i.test(details)) return "network_timeout";
  if (["billing_quota_exhausted", "temporary_rate_limit", "authentication_failure", "permission_failure", "provider_overloaded", "network_timeout"].includes(error?.errorCategory)) return error.errorCategory;
  return "unknown_provider_error";
};

export const isOpenAIQuotaError = (error = {}) => classifyOpenAIError(error) === "billing_quota_exhausted";
export const isOpenAIRateLimitError = (error = {}) => classifyOpenAIError(error) === "temporary_rate_limit";

const openAIHealth = {
  status: "idle",
  attempts: 0,
  successes: 0,
  failures: 0,
  retryCount: 0,
  lastSuccessAt: 0,
  lastFailureAt: 0,
  lastLatencyMs: 0,
  lastError: ""
};


const stripWrappedText = (value = "") => normalizeProviderText(value);

const noteOpenAISuccess = (latencyMs) => {
  openAIHealth.status = "healthy";
  openAIHealth.successes += 1;
  openAIHealth.lastSuccessAt = Date.now();
  openAIHealth.lastLatencyMs = latencyMs;
  openAIHealth.lastError = "";
};

const noteOpenAIFailure = (error) => {
  openAIHealth.status = "degraded";
  openAIHealth.failures += 1;
  openAIHealth.lastFailureAt = Date.now();
  openAIHealth.lastLatencyMs = Number(error?.latencyMs) || 0;
  openAIHealth.lastError = providerErrorMessage(error);
};

export const getOpenAIHealth = () => ({
  ...openAIHealth,
  healthy: openAIHealth.status === "healthy" || (openAIHealth.successes > 0 && openAIHealth.lastFailureAt < openAIHealth.lastSuccessAt)
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
  const providerCode = providerLanguageCode(normalizedCode, "openai") || normalizedCode;
  const languageName = SUPPORTED_LANGUAGE_CODES.has(normalizedCode) ? LANGUAGE_NAMES[normalizedCode] : "";
  return languageName ? `${languageName} (${providerCode})` : "auto-detected source language";
};

const targetLanguageInstructions = (targetLang = "") => TARGET_LANGUAGE_INSTRUCTIONS[sanitizeTargetLanguageCode(targetLang)] || [];

const normalizeTranslatedText = ({ text, targetLang }) => {
  const cleanText = stripWrappedText(text);
  return enhanceTranslation({ text: cleanText, targetLang });
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

const extractOutputText = (data = {}) => {
  if (typeof data.output_text === "string") return data.output_text.trim();

  const textParts = [];
  for (const item of data.output || []) {
    if (!Array.isArray(item?.content)) continue;

    for (const content of item.content) {
      if (typeof content?.text === "string") textParts.push(content.text);
      if (typeof content?.output_text === "string") textParts.push(content.output_text);
      if (typeof content?.content === "string") textParts.push(content.content);
    }
  }

  return textParts.join(" ").trim();
};

const buildSystemPrompt = ({ sourceLang, targetLang, translationContext }) => {
  const targetLanguage = describeLanguage(targetLang);
  const sourceLanguage = sourceLang ? describeSourceLanguage(sourceLang) : "auto-detected language";

  return [
    "You are a professional real-time interpreter.",
    `Translate the user's text from ${sourceLanguage} to ${targetLanguage}.`,
    `Supported input and output languages are: ${SUPPORTED_LANGUAGE_LIST}.`,
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
    "Return only the translated text."
  ].join("\n");
};

export const translateWithOpenAI = async ({ apiKey, text, sourceLang, targetLang, translationContext, signal, includeMetadata = false, request = globalThis.fetch, sleep = delay }) => {
  const cleanText = text?.trim();

  if (!cleanText || !apiKey) {
    return "";
  }

  if (signal?.aborted) {
    throw Object.assign(new Error("OpenAI translation aborted"), { provider: "openai", errorCategory: "intentional_abort", intentionalAbort: true });
  }

  const targetLanguage = describeLanguage(targetLang);

  const systemPrompt = buildSystemPrompt({ sourceLang, targetLang, translationContext });
  const operationStartedAt = Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= OPENAI_MAX_ATTEMPTS; attempt += 1) {
    let requestTimedOut = false;
    openAIHealth.status = attempt === 1 ? "requesting" : "retrying";
    openAIHealth.attempts += 1;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        requestTimedOut = true;
        controller.abort();
      }, OPENAI_TIMEOUT_MS);

      const mergedSignal = mergeAbortSignals(signal, controller.signal);

      const response = await request(OPENAI_API_URL, {
        method: "POST",
        signal: mergedSignal.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: OPENAI_TRANSLATION_MODEL,
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: `Text:\n${cleanText}`
            }
          ],
          temperature: 0,
          max_tokens: 512
        })
      }).finally(() => {
        clearTimeout(timeout);
        mergedSignal.cleanup();
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const providerError = errorData?.error && typeof errorData.error === "object" ? errorData.error : {};
        const providerMessage = typeof providerError.message === "string" ? providerError.message : "";
        const responseErrorMessage = typeof errorData?.error === "string" ? errorData.error : "";
        const message = providerMessage || responseErrorMessage || response.statusText || "OpenAI translation request failed";
        const error = new Error(`OpenAI ${response.status}: ${message}`);
        error.status = response.status;
        error.httpStatus = response.status;
        error.provider = "openai";
        error.providerModel = OPENAI_TRANSLATION_MODEL;
        error.model = OPENAI_TRANSLATION_MODEL;
        error.headers = response.headers;
        error.reason = String(message);
        error.errorCode = providerError.code ? String(providerError.code) : null;
        error.errorType = providerError.type ? String(providerError.type) : null;
        error.errorCategory = classifyOpenAIError(error);
        error.quotaExhausted = error.errorCategory === "billing_quota_exhausted";
        error.rateLimited = error.errorCategory === "temporary_rate_limit";
        error.retryAfterMs = getRetryAfterMs(error);
        throw error;
      }

      const data = await response.json();

      if (!data?.choices?.length) {
        throw new Error(`OpenAI returned no translation choices for ${targetLanguage}`);
      }

      const messageContent = data.choices[0]?.message?.content || "";
      const translatedText = normalizeTranslatedText({ text: messageContent, targetLang });

      if (!translatedText) {
        throw new Error(`OpenAI returned an empty translation for ${targetLanguage}`);
      }

      const echoedSource = normalizeForComparison(translatedText) === normalizeForComparison(cleanText);

      if (signal?.aborted) {
        throw Object.assign(new Error("OpenAI translation aborted"), { provider: "openai", errorCategory: "intentional_abort", intentionalAbort: true });
      }

      if (echoedSource) {
        throw new Error("OpenAI echoed the source text");
      }

      const latencyMs = Date.now() - operationStartedAt;
      noteOpenAISuccess(latencyMs);
      const metadata = {
        text: translatedText,
        provider: "openai",
        model: OPENAI_TRANSLATION_MODEL,
        providerModel: OPENAI_TRANSLATION_MODEL,
        httpStatus: 200,
        retryCount: attempt - 1,
        latencyMs
      };
      return includeMetadata ? metadata : translatedText;
    } catch (error) {
      // Mirrors gemini.js: a native AbortError fires for our OWN timeout (requestTimedOut) just
      // as much as for the CALLER intentionally cancelling a superseded request — only the
      // former is a genuine timeout/failure signal.
      const intentionalAbort = !requestTimedOut && (Boolean(signal?.aborted) || error?.name === "AbortError");
      if (intentionalAbort) {
        throw Object.assign(new Error("OpenAI translation aborted"), { provider: "openai", errorCategory: "intentional_abort", intentionalAbort: true });
      }

      lastError = error;
      error.provider = error.provider || "openai";
      error.providerModel = error.providerModel || OPENAI_TRANSLATION_MODEL;
      error.model = error.model || OPENAI_TRANSLATION_MODEL;
      error.httpStatus = getErrorStatusCode(error);
      error.reason = error.reason || providerErrorMessage(error) || "OpenAI translation failed";
      error.errorCategory = classifyOpenAIError(error);
      error.quotaExhausted = error.errorCategory === "billing_quota_exhausted";
      error.rateLimited = error.errorCategory === "temporary_rate_limit";
      error.retryCount = attempt - 1;
      error.latencyMs = Date.now() - operationStartedAt;
      noteOpenAIFailure(error);

      const terminalFailure = error.quotaExhausted || isNonRetryableProviderError(error, [400, 401, 403, 404], ["unauthori[sz]ed", "forbidden", "invalid api key", "permission"]);
      if (terminalFailure || attempt >= OPENAI_MAX_ATTEMPTS) {
        error.providerRetryExhausted = true;
        break;
      }

      if (error.rateLimited && Number(error.retryAfterMs) > OPENAI_RETRY_MAX_MS) {
        error.providerRetryExhausted = true;
        break;
      }

      openAIHealth.retryCount += 1;
      await sleep(getRetryDelay({ attempt, baseMs: OPENAI_RETRY_BASE_MS, maxMs: OPENAI_RETRY_MAX_MS, error }));
    }
  }

  throw lastError || new Error("OpenAI translation failed");
};
