// @ts-nocheck
import { LANGUAGE_NAMES, TARGET_LANGUAGE_INSTRUCTIONS } from "../data/languageMemory.js";
import { enhanceTranslation } from "../utils/translationEnhancer.js";
import {
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode,
  providerLanguageCode,
  supportedLanguageList
} from "../../shared/languages.mjs";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_TRANSLATION_MODEL = "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 22000;
const OPENAI_MAX_ATTEMPTS = 3;
const OPENAI_RETRY_BASE_MS = 650;
const OPENAI_RETRY_MAX_MS = 5000;
const SUPPORTED_LANGUAGE_LIST = supportedLanguageList();

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

const mergeAbortSignals = (...signals) => {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return { signal: undefined, cleanup: () => undefined };
  if (activeSignals.length === 1) return { signal: activeSignals[0], cleanup: () => undefined };

  const controller = new AbortController();
  const abort = () => controller.abort();
  const cleanupCallbacks = [];

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      for (const cleanup of cleanupCallbacks) cleanup();
      return { signal: controller.signal, cleanup: () => undefined };
    }
    signal.addEventListener?.("abort", abort, { once: true });
    cleanupCallbacks.push(() => signal.removeEventListener?.("abort", abort));
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const cleanup of cleanupCallbacks) cleanup();
    }
  };
};

const normalizeForComparison = (value = "") =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");

const stripWrappedText = (value = "") => value.trim().replace(/^["'`]+|["'`]+$/g, "").trim();

const delay = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

const retryDelay = (attempt) => Math.min(OPENAI_RETRY_MAX_MS, OPENAI_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));

const providerErrorMessage = (error = {}) => String(error?.message || error || "");

const isNonRetryableOpenAIError = (error = {}) =>
  /\b(400|401|403|429)\b|rate[_ -]?limit|quota|billing|unauthori[sz]ed|forbidden|invalid api key|permission|insufficient/i.test(
    providerErrorMessage(error)
  );

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

export const translateWithOpenAI = async ({ apiKey, text, sourceLang, targetLang, translationContext, signal }) => {
  const cleanText = text?.trim();

  if (!cleanText || !apiKey) {
    return "";
  }

  if (signal?.aborted) {
    throw new Error("OpenAI translation aborted");
  }

  const targetLanguage = describeLanguage(targetLang);

  const systemPrompt = buildSystemPrompt({ sourceLang, targetLang, translationContext });
  let lastError = null;

  for (let attempt = 1; attempt <= OPENAI_MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    openAIHealth.status = attempt === 1 ? "requesting" : "retrying";
    openAIHealth.attempts += 1;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

      const mergedSignal = mergeAbortSignals(signal, controller.signal);

      const response = await fetch(OPENAI_API_URL, {
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
        const message = errorData?.error?.message || errorData?.error || response.statusText || "OpenAI translation request failed";
        throw new Error(`OpenAI ${response.status}: ${message}`);
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
        throw new Error("OpenAI translation aborted");
      }

      if (echoedSource) {
        throw new Error("OpenAI echoed the source text");
      }

      noteOpenAISuccess(Date.now() - startedAt);
      return translatedText;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw new Error("OpenAI translation aborted");
      }

      lastError = error;
      noteOpenAIFailure(error);

      if (attempt >= OPENAI_MAX_ATTEMPTS || isNonRetryableOpenAIError(error)) {
        break;
      }

      openAIHealth.retryCount += 1;
      await delay(retryDelay(attempt));
    }
  }

  throw lastError || new Error("OpenAI translation failed");
};
