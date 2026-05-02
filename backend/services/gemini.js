// @ts-nocheck

const GEMINI_API_VERSION = "v1";
const DEFAULT_GEMINI_MODEL = "gemini-1.5-flash";
const DEFAULT_GEMINI_TIMEOUT_MS = 900;
const GEMINI_MAX_ATTEMPTS = 2;
const GEMINI_RETRY_DELAY_MS = 150;
const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const languageNames = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ar: "Arabic",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  hi: "Hindi",
  tr: "Turkish",
  pl: "Polish",
  ru: "Russian"
};
const languageCodeAliases = {
  "en-us": "en",
  "en-gb": "en",
  "es-es": "es",
  "es-mx": "es",
  "fr-fr": "fr",
  "de-de": "de",
  "it-it": "it",
  "pt-br": "pt",
  "pt-pt": "pt",
  "nl-nl": "nl",
  "ar-sa": "ar",
  "zh-cn": "zh",
  "zh-hans": "zh",
  "zh-tw": "zh",
  "zh-hant": "zh",
  "ja-jp": "ja",
  "ko-kr": "ko",
  "hi-in": "hi",
  "tr-tr": "tr",
  "pl-pl": "pl",
  "ru-ru": "ru"
};
const targetLanguageValidators = {
  ar: /[\u0600-\u06ff]/u,
  hi: /[\u0900-\u097f]/u,
  ja: /[\u3040-\u30ff\u3400-\u9fff]/u,
  ko: /[\uac00-\ud7af]/u,
  ru: /[\u0400-\u04ff]/u,
  zh: /[\u3400-\u9fff]/u
};

const placeholderApiKeys = new Set([
  "",
  "null",
  "undefined",
  "your_gemini_api_key",
  "demo_gemini_key_replace_me",
  "YOUR_GEMINI_API_KEY_HERE"
]);

const readGeminiKey = (value) => {
  const trimmed = value?.trim() || "";
  const unquoted = trimmed.match(/^(['"])(.*)\1$/)?.[2] || trimmed;
  return placeholderApiKeys.has(unquoted) ? "" : unquoted;
};

const readNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getGeminiTimeoutMs = (timeoutMs) => {
  return readNumber(timeoutMs || process.env.GEMINI_TRANSLATION_TIMEOUT_MS || process.env.TRANSLATION_PROVIDER_TIMEOUT_MS, DEFAULT_GEMINI_TIMEOUT_MS);
};

const normalizeModelName = (model) => model.replace(/^models\//, "");

const getGeminiModels = () => {
  const configuredModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  return [...new Set([configuredModel].map(normalizeModelName).filter(Boolean))];
};

const getGeminiEndpoint = (model) => {
  return `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeLanguageCode = (languageCode = "") => String(languageCode || "").trim().toLowerCase().replace(/_/g, "-");

export const normalizeTranslationLanguageCode = (languageCode = "", { allowAuto = false, fallback = "" } = {}) => {
  const normalizedCode = normalizeLanguageCode(languageCode);

  if (allowAuto && normalizedCode === "auto") {
    return "auto";
  }

  if (languageNames[normalizedCode]) {
    return normalizedCode;
  }

  if (languageCodeAliases[normalizedCode]) {
    return languageCodeAliases[normalizedCode];
  }

  const baseCode = normalizedCode.split("-")[0];
  if (languageNames[baseCode]) {
    return baseCode;
  }

  return fallback;
};

const getLanguageName = (languageCode = "") => {
  const normalizedCode = normalizeTranslationLanguageCode(languageCode);
  const baseCode = normalizedCode.split("-")[0];
  const languageName = languageNames[normalizedCode] || languageNames[baseCode];

  if (languageName) {
    return `${languageName}${normalizedCode ? ` (${normalizedCode})` : ""}`;
  }

  return languageCode || "the selected target language";
};

const normalizeForEchoComparison = (value = "") => {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/^[\s"'`]+|[\s"'`.!?]+$/g, "");
};

const isEchoedTranslation = ({ originalText, translatedText }) => {
  return normalizeForEchoComparison(originalText) === normalizeForEchoComparison(translatedText);
};

const usesRequiredTargetScript = ({ translatedText, targetLang }) => {
  const normalizedTargetLang = normalizeTranslationLanguageCode(targetLang);
  const validator = targetLanguageValidators[normalizedTargetLang];
  return !validator || validator.test(translatedText);
};

const readText = (value) => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(readText).filter(Boolean).join("").trim();
  if (typeof value?.text === "string") return value.text.trim();
  if (typeof value?.content === "string") return value.content.trim();
  if (typeof value?.message?.content === "string") return value.message.content.trim();
  if (Array.isArray(value?.parts)) return readText(value.parts);
  if (Array.isArray(value?.content?.parts)) return readText(value.content.parts);
  return "";
};

const extractGeminiText = (data) => {
  const candidateGroups = [data?.candidates, data?.response?.candidates].filter(Array.isArray);

  for (const candidates of candidateGroups) {
    for (const candidate of candidates) {
      const text = readText(candidate);

      if (text) return text;
    }
  }

  const choiceText = readText(data?.choices?.[0]?.message) || readText(data?.choices?.[0]);
  if (choiceText) return choiceText;

  const predictionText = readText(data?.predictions?.[0]);
  if (predictionText) return predictionText;

  const outputText = readText(data?.outputText) || readText(data?.output_text);
  if (outputText) return outputText;

  const responseText = readText(data?.response);
  if (responseText) return responseText;

  const firstOutputText = data?.output?.[0]?.content?.[0]?.text;
  return readText(firstOutputText) || readText(data);
};

const parseResponseBody = (rawBody) => {
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch (parseError) {
    console.log("Gemini API response:", rawBody);
    throw new Error(`Gemini API returned invalid JSON: ${parseError?.message || parseError}`);
  }
};

const isRetryableError = (error) => {
  if (error?.retryable) return true;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return true;
  return retryableStatuses.has(Number(error?.status));
};

const createGeminiRequest = (cleanText, sourceLang, targetLang, { strictRetry = false } = {}) => {
  const targetLanguageCode = normalizeTranslationLanguageCode(targetLang);
  const sourceLanguageCode = normalizeTranslationLanguageCode(sourceLang, { allowAuto: true, fallback: "auto" });
  const targetLanguageName = getLanguageName(targetLanguageCode);
  const sourceLanguageName = sourceLanguageCode === "auto" ? "auto-detected source language" : getLanguageName(sourceLanguageCode);
  const retryInstructions = strictRetry
    ? [
        "STRICT RETRY: the previous response was invalid because it echoed the source text, was empty, or ignored the target language.",
        `You are forbidden from returning the original ${sourceLanguageName} text.`,
        `Every translatable word must be translated into ${targetLanguageName}.`,
        "Only proper nouns, brand names, numbers, codes, and URLs may remain unchanged."
      ]
    : [];

  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "You are a professional real-time interpreter.",
              `Translate the following text into ${targetLanguageName}.`,
              `Source language code: ${sourceLanguageCode}.`,
              `Source language: ${sourceLanguageName}.`,
              `Target language code: ${targetLanguageCode}.`,
              `Target language: ${targetLanguageName}.`,
              `You MUST translate the input into ${targetLanguageName}.`,
              `The final answer MUST be written in ${targetLanguageName}.`,
              "Do NOT repeat original text.",
              "Do NOT output the original source text.",
              "Do NOT answer in the source language.",
              "Return ONLY translated text.",
              "Do NOT include explanations, labels, metadata, markdown, quotes, pronunciation notes, or extra words.",
              ...retryInstructions,
              "",
              "Original text:",
              cleanText
            ].join("\n")
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      candidateCount: 1,
      maxOutputTokens: 512
    }
  };
};

const fetchGeminiResponse = async ({ geminiEndpoint, apiKey, body, attempt, timeoutMs, originalText, sourceLang, targetLang }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await fetch(geminiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const rawBody = await response.text();
    const data = parseResponseBody(rawBody);
    if (process.env.DEBUG_TRANSLATION === "true") {
      console.log("Gemini API response:", JSON.stringify(data));
    }

    if (!response.ok) {
      const error = new Error(data?.error?.message || `Gemini API request failed with status ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    const translatedText = extractGeminiText(data);

    if (!translatedText) {
      const error = new Error("Gemini API response did not include translated text");
      error.retryable = true;
      error.data = data;
      throw error;
    }

    if (isEchoedTranslation({ originalText, translatedText, sourceLang, targetLang })) {
      const error = new Error("Gemini echoed the original text instead of translating");
      error.retryable = true;
      error.data = data;
      throw error;
    }

    if (!usesRequiredTargetScript({ translatedText, targetLang })) {
      const error = new Error(`Gemini response was not written in target language ${normalizeTranslationLanguageCode(targetLang)}`);
      error.retryable = true;
      error.data = data;
      throw error;
    }

    return translatedText;
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    const message = isTimeout ? `Gemini request timed out after ${Math.max(1, timeoutMs)}ms` : error?.message || error;
    console.error(`Gemini API attempt ${attempt} failed:`, message);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export const hasGeminiKey = () => {
  return Boolean(readGeminiKey(process.env.GEMINI_API_KEY));
};

export const translateWithGemini = async ({ text, sourceLang, targetLang, timeoutMs }) => {
  const cleanText = text?.trim();
  const apiKey = readGeminiKey(process.env.GEMINI_API_KEY);
  const geminiTimeoutMs = getGeminiTimeoutMs(timeoutMs);
  const normalizedSourceLang = normalizeTranslationLanguageCode(sourceLang, { allowAuto: true, fallback: "auto" });
  const normalizedTargetLang = normalizeTranslationLanguageCode(targetLang);

  if (process.env.DEBUG_TRANSLATION === "true") {
    console.log("Gemini API key present:", Boolean(apiKey));
  }

  if (!cleanText) {
    return "";
  }

  if (!apiKey) {
    const error = new Error("Missing Gemini API key");
    console.error("Gemini translation error:", error.message);
    throw error;
  }

  if (!normalizedTargetLang) {
    const error = new Error(`Unsupported target language code: ${targetLang || "missing"}`);
    console.error("Gemini translation error:", error.message);
    throw error;
  }

  try {
    const geminiModels = getGeminiModels();
    const deadline = Date.now() + geminiTimeoutMs;
    let lastError = null;

    for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        break;
      }

      const currentModel = geminiModels[0];
      const geminiEndpoint = getGeminiEndpoint(currentModel);
      if (process.env.DEBUG_TRANSLATION === "true") {
        console.log("Gemini model:", currentModel);
      }

      try {
        const requestBody = createGeminiRequest(cleanText, normalizedSourceLang, normalizedTargetLang, { strictRetry: attempt > 1 });
        const translatedText = await fetchGeminiResponse({
          geminiEndpoint,
          apiKey,
          body: requestBody,
          attempt,
          timeoutMs: remainingMs,
          originalText: cleanText,
          sourceLang: normalizedSourceLang,
          targetLang: normalizedTargetLang
        });
        return translatedText;
      } catch (error) {
        lastError = error;

        if (attempt >= GEMINI_MAX_ATTEMPTS || !isRetryableError(error)) {
          break;
        }

        const retryDelay = GEMINI_RETRY_DELAY_MS * attempt;
        const remainingAfterAttempt = deadline - Date.now();

        if (remainingAfterAttempt <= retryDelay) {
          break;
        }

        console.warn(`Retrying Gemini translation in ${retryDelay}ms`);
        await sleep(retryDelay);
      }
    }

    throw lastError || new Error(`Gemini translation timed out after ${geminiTimeoutMs}ms`);
  } catch (error) {
    console.error("Gemini translation error:", error);
    throw error;
  }
};
