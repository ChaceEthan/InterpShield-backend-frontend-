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

const normalizeLanguageCode = (languageCode = "") => languageCode.trim().toLowerCase();

const getLanguageName = (languageCode = "") => {
  const normalizedCode = normalizeLanguageCode(languageCode);
  const baseCode = normalizedCode.split("-")[0];
  const languageName = languageNames[normalizedCode] || languageNames[baseCode];

  if (languageName) {
    return `${languageName}${languageCode ? ` (${languageCode})` : ""}`;
  }

  return languageCode || "the selected target language";
};

const normalizeForEchoComparison = (value = "") => {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/^[\s"'`]+|[\s"'`.!?]+$/g, "");
};

const isEchoedTranslation = ({ originalText, translatedText, sourceLang, targetLang }) => {
  if (normalizeLanguageCode(sourceLang) && normalizeLanguageCode(sourceLang) === normalizeLanguageCode(targetLang)) {
    return false;
  }

  return normalizeForEchoComparison(originalText) === normalizeForEchoComparison(translatedText);
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
  const targetLanguageName = getLanguageName(targetLang);
  const sourceLanguageName = sourceLang === "auto" ? "auto-detected source language" : getLanguageName(sourceLang);
  const retryInstructions = strictRetry
    ? [
        "This is a retry because the previous response did not produce a valid translation.",
        `You MUST output a different sentence in ${targetLanguageName}.`,
        "If the source contains names, keep only the names unchanged; translate all translatable words."
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
              `Translate to ${targetLanguageName}.`,
              `Source language: ${sourceLanguageName}.`,
              `Target language: ${targetLanguageName}.`,
              `You MUST translate the input into ${targetLanguageName}.`,
              "Do NOT repeat original text.",
              "Return only translated sentence.",
              "No explanations.",
              "Do not add commentary, labels, markdown, quotes, or pronunciation notes.",
              `The final answer must be written in ${targetLanguageName}, not in the source language.`,
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
      temperature: 0.1,
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
      error.data = data;
      throw error;
    }

    if (isEchoedTranslation({ originalText, translatedText, sourceLang, targetLang })) {
      const error = new Error("Gemini echoed the original text instead of translating");
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
        const requestBody = createGeminiRequest(cleanText, sourceLang, targetLang, { strictRetry: attempt > 1 });
        const translatedText = await fetchGeminiResponse({
          geminiEndpoint,
          apiKey,
          body: requestBody,
          attempt,
          timeoutMs: remainingMs,
          originalText: cleanText,
          sourceLang,
          targetLang
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
