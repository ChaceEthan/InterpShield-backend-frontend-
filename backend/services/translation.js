// @ts-nocheck
import { hasGeminiKey, normalizeTranslationLanguageCode, translateWithGemini } from "./gemini.js";

const readErrorMessage = (error) => error?.message || String(error || "Unknown translation error");
const DEFAULT_TRANSLATION_TOTAL_TIMEOUT_MS = 1000;
const DEFAULT_TRANSLATION_PROVIDER_TIMEOUT_MS = 700;
const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
const myMemoryLanguageCodes = {
  zh: "zh-CN"
};
export const TRANSLATION_UNAVAILABLE_TEXT = "Translation temporarily unavailable";

const readNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getTotalTimeoutMs = () => {
  return readNumber(process.env.TRANSLATION_TOTAL_TIMEOUT_MS, DEFAULT_TRANSLATION_TOTAL_TIMEOUT_MS);
};

const getProviderTimeoutMs = (remainingMs) => {
  const configuredTimeout = readNumber(process.env.TRANSLATION_PROVIDER_TIMEOUT_MS, DEFAULT_TRANSLATION_PROVIDER_TIMEOUT_MS);
  return Math.max(1, Math.min(remainingMs, configuredTimeout));
};

const unavailableResult = (provider = "gemini") => {
  return { text: TRANSLATION_UNAVAILABLE_TEXT, provider, stale: true };
};

const normalizeForComparison = (value = "") => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^[\s"'`]+|[\s"'`.!?]+$/g, "");
};

const isEchoedText = ({ originalText, translatedText }) => {
  return normalizeForComparison(originalText) === normalizeForComparison(translatedText);
};

const getMyMemoryLanguageCode = (languageCode) => {
  return myMemoryLanguageCodes[languageCode] || languageCode;
};

const fetchMyMemoryTranslation = async ({ text, sourceLang, targetLang, timeoutMs }) => {
  const from = getMyMemoryLanguageCode(sourceLang);
  const to = getMyMemoryLanguageCode(targetLang);
  const langpair = `${from}|${to}`;
  const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.responseDetails || `MyMemory API request failed with status ${response.status}`);
    }

    const translatedText = data?.responseData?.translatedText?.trim() || "";

    if (!translatedText) {
      throw new Error("MyMemory API response did not include translated text");
    }

    if (isEchoedText({ originalText: text, translatedText })) {
      throw new Error("MyMemory echoed the original text instead of translating");
    }

    return translatedText;
  } finally {
    clearTimeout(timeout);
  }
};

export const translateText = async ({ text, sourceLang, targetLang }) => {
  const cleanText = text?.trim();

  if (!cleanText) {
    return { text: "", provider: "none", stale: true };
  }

  const normalizedSourceLang = normalizeTranslationLanguageCode(sourceLang, { allowAuto: true, fallback: "auto" });
  const normalizedTargetLang = normalizeTranslationLanguageCode(targetLang);
  const deadline = Date.now() + getTotalTimeoutMs();

  if (!normalizedTargetLang) {
    console.warn(`Gemini translation unavailable. Unsupported target language code: ${targetLang || "missing"}`);
    return unavailableResult();
  }

  if (hasGeminiKey()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      console.warn("Gemini translation unavailable. gemini: total realtime translation budget exceeded");
    } else {
      try {
        const translatedText = (await translateWithGemini({
          text: cleanText,
          sourceLang: normalizedSourceLang,
          targetLang: normalizedTargetLang,
          timeoutMs: getProviderTimeoutMs(remainingMs)
        }))?.trim() || "";

        if (translatedText) {
          return { text: translatedText, provider: "gemini", stale: false };
        }

        console.warn("Gemini translation unavailable. gemini: empty translation");
      } catch (error) {
        console.warn(`Gemini translation unavailable. gemini: ${readErrorMessage(error)}`);
      }
    }
  } else {
    console.warn("Gemini translation unavailable. gemini: missing API key");
  }

  const fallbackRemainingMs = deadline - Date.now();
  if (fallbackRemainingMs <= 0) {
    console.warn("MyMemory translation unavailable. mymemory: total realtime translation budget exceeded");
    return unavailableResult("mymemory");
  }

  try {
    const translatedText = (await fetchMyMemoryTranslation({
      text: cleanText,
      sourceLang: normalizedSourceLang,
      targetLang: normalizedTargetLang,
      timeoutMs: getProviderTimeoutMs(fallbackRemainingMs)
    }))?.trim() || "";

    if (translatedText) {
      return { text: translatedText, provider: "mymemory", stale: false };
    }

    console.warn("MyMemory translation unavailable. mymemory: empty translation");
  } catch (error) {
    console.warn(`MyMemory translation unavailable. mymemory: ${readErrorMessage(error)}`);
  }

  return unavailableResult("mymemory");
};
