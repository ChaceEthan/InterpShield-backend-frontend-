// @ts-nocheck

const GOOGLE_TRANSLATE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
const GOOGLE_TRANSLATE_TIMEOUT_MS = 2000;
const GOOGLE_TRANSLATE_MAX_ATTEMPTS = 2;
const GOOGLE_TRANSLATE_RETRY_DELAY_MS = 120;
const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const placeholderApiKeys = new Set([
  "",
  "null",
  "undefined",
  "your_google_translate_api_key",
  "demo_google_translate_key_replace_me",
  "YOUR_GOOGLE_TRANSLATE_API_KEY_HERE"
]);

const readGoogleTranslateKey = (value) => {
  const trimmed = value?.trim() || "";
  const unquoted = trimmed.match(/^(['"])(.*)\1$/)?.[2] || trimmed;
  return placeholderApiKeys.has(unquoted) ? "" : unquoted;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeHtmlEntities = (value = "") => {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
};

const parseResponseBody = (rawBody) => {
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch (parseError) {
    throw new Error(`Google Translate returned invalid JSON: ${parseError?.message || parseError}`);
  }
};

const isRetryableError = (error) => {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return true;
  return retryableStatuses.has(Number(error?.status));
};

const extractGoogleTranslation = (data) => {
  const translatedText = data?.data?.translations?.[0]?.translatedText;
  return decodeHtmlEntities(typeof translatedText === "string" ? translatedText.trim() : "");
};

const createGoogleTranslateRequest = (cleanText, sourceLang, targetLang) => {
  const request = {
    q: cleanText,
    target: targetLang,
    format: "text"
  };

  if (sourceLang && sourceLang !== "auto") {
    request.source = sourceLang;
  }

  return request;
};

const fetchGoogleTranslateResponse = async ({ endpoint, body, attempt, timeoutMs }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const rawBody = await response.text();
    const data = parseResponseBody(rawBody);

    if (!response.ok) {
      const error = new Error(data?.error?.message || `Google Translate request failed with status ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    const translatedText = extractGoogleTranslation(data);

    if (!translatedText) {
      const error = new Error("Google Translate response did not include translated text");
      error.data = data;
      throw error;
    }

    return translatedText;
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    const message = isTimeout ? `Google Translate request timed out after ${Math.max(1, timeoutMs)}ms` : error?.message || error;
    console.error(`Google Translate attempt ${attempt} failed:`, message);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export const hasGoogleTranslateKey = () => {
  return Boolean(readGoogleTranslateKey(process.env.GOOGLE_TRANSLATE_API_KEY || process.env.GOOGLE_API_KEY));
};

export const translateWithGoogleTranslate = async ({ text, sourceLang, targetLang }) => {
  const cleanText = text?.trim();
  const apiKey = readGoogleTranslateKey(process.env.GOOGLE_TRANSLATE_API_KEY || process.env.GOOGLE_API_KEY);

  if (!cleanText) {
    return "";
  }

  if (!apiKey) {
    throw new Error("Missing Google Translate API key");
  }

  const endpoint = `${GOOGLE_TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const requestBody = createGoogleTranslateRequest(cleanText, sourceLang, targetLang);
  const deadline = Date.now() + GOOGLE_TRANSLATE_TIMEOUT_MS;
  let lastError = null;

  for (let attempt = 1; attempt <= GOOGLE_TRANSLATE_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      break;
    }

    try {
      return await fetchGoogleTranslateResponse({ endpoint, body: requestBody, attempt, timeoutMs: remainingMs });
    } catch (error) {
      lastError = error;

      if (attempt >= GOOGLE_TRANSLATE_MAX_ATTEMPTS || !isRetryableError(error)) {
        break;
      }

      const retryDelay = GOOGLE_TRANSLATE_RETRY_DELAY_MS * attempt;
      const remainingAfterAttempt = deadline - Date.now();

      if (remainingAfterAttempt <= retryDelay) {
        break;
      }

      await sleep(retryDelay);
    }
  }

  throw lastError || new Error(`Google Translate timed out after ${GOOGLE_TRANSLATE_TIMEOUT_MS}ms`);
};
