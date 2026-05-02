// @ts-nocheck

const GEMINI_API_VERSION = "v1";
const DEFAULT_GEMINI_MODEL = "gemini-1.5-flash";
const GEMINI_MODEL_FALLBACKS = ["gemini-2.0-flash", "gemini-2.5-flash"];
const GEMINI_TIMEOUT_MS = 3000;
const GEMINI_MAX_RETRIES = 2;
const GEMINI_RETRY_DELAY_MS = 150;
const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
let activeGeminiModel = null;

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

const normalizeModelName = (model) => model.replace(/^models\//, "");

const getGeminiModels = () => {
  const configuredModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const preferredModels = [configuredModel, ...GEMINI_MODEL_FALLBACKS].map(normalizeModelName).filter(Boolean);
  const models = [...new Set(preferredModels)];

  if (activeGeminiModel && models.includes(activeGeminiModel)) {
    return [activeGeminiModel, ...models.filter((model) => model !== activeGeminiModel)];
  }

  return models;
};

const getGeminiEndpoint = (model) => {
  return `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readText = (value) => {
  if (typeof value === "string") return value.trim();
  if (typeof value?.text === "string") return value.text.trim();
  return "";
};

const extractGeminiText = (data) => {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];

  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;

    if (Array.isArray(parts)) {
      const text = parts.map(readText).filter(Boolean).join("").trim();
      if (text) return text;
    }

    const directCandidateText = readText(candidate);
    if (directCandidateText) return directCandidateText;

    const contentText = readText(candidate?.content);
    if (contentText) return contentText;
  }

  const sdkResponseText = readText(data);
  if (sdkResponseText) return sdkResponseText;

  const outputText = readText(data?.outputText) || readText(data?.output_text);
  if (outputText) return outputText;

  const responseText = readText(data?.response);
  if (responseText) return responseText;

  const firstOutputText = data?.output?.[0]?.content?.[0]?.text;
  return readText(firstOutputText);
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
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return true;
  return retryableStatuses.has(Number(error?.status));
};

const isUnavailableModelError = (error) => {
  const message = error?.message || "";
  return Number(error?.status) === 404 && /not found|not supported/i.test(message);
};

const createGeminiRequest = (cleanText, sourceLang, targetLang) => ({
  contents: [
    {
      role: "user",
      parts: [
        {
          text: [
            "You are a professional real-time interpreter.",
            `Translate from ${sourceLang || "auto"} to ${targetLang}.`,
            "Preserve tone, intent, names, and numbers.",
            "Return only the translated text. No commentary.",
            "",
            cleanText
          ].join("\n")
        }
      ]
    }
  ],
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 512
  }
});

const fetchGeminiResponse = async ({ geminiEndpoint, apiKey, body, attempt, timeoutMs }) => {
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
    console.log("Gemini API response:", JSON.stringify(data));

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

export const translateWithGemini = async ({ text, sourceLang, targetLang }) => {
  const cleanText = text?.trim();
  const apiKey = readGeminiKey(process.env.GEMINI_API_KEY);

  console.log("Gemini API key present:", Boolean(apiKey));

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
    const requestBody = createGeminiRequest(cleanText, sourceLang, targetLang);
    const deadline = Date.now() + GEMINI_TIMEOUT_MS;
    let lastError = null;
    let modelIndex = 0;

    for (let attempt = 1; attempt <= GEMINI_MAX_RETRIES + 1; attempt += 1) {
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        break;
      }

      const currentModel = geminiModels[modelIndex];
      const geminiEndpoint = getGeminiEndpoint(currentModel);
      console.log("Gemini model:", currentModel);
      console.log("Gemini endpoint:", geminiEndpoint);

      try {
        const translatedText = await fetchGeminiResponse({ geminiEndpoint, apiKey, body: requestBody, attempt, timeoutMs: remainingMs });
        activeGeminiModel = currentModel;
        return translatedText;
      } catch (error) {
        lastError = error;

        if (isUnavailableModelError(error) && modelIndex < geminiModels.length - 1) {
          modelIndex += 1;
          console.warn(`Gemini model unavailable, switching to ${geminiModels[modelIndex]}`);
          continue;
        }

        if (attempt > GEMINI_MAX_RETRIES || !isRetryableError(error)) {
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

    throw lastError || new Error(`Gemini translation timed out after ${GEMINI_TIMEOUT_MS}ms`);
  } catch (error) {
    console.error("Gemini translation error:", error);
    throw error;
  }
};
