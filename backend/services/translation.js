// @ts-nocheck
import { hasGeminiKey, translateWithGemini } from "./gemini.js";
import { hasGoogleTranslateKey, translateWithGoogleTranslate } from "./googleTranslate.js";

const readErrorMessage = (error) => error?.message || String(error || "Unknown translation error");
const DEFAULT_TRANSLATION_TOTAL_TIMEOUT_MS = 2500;
const DEFAULT_TRANSLATION_PROVIDER_TIMEOUT_MS = 1000;

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

const getProviderOrder = () => {
  const primary = (process.env.TRANSLATION_PRIMARY || "google").trim().toLowerCase();
  return primary === "gemini" ? ["gemini", "google"] : ["google", "gemini"];
};

const getProvider = (name) => {
  if (name === "google") {
    return {
      name: "google",
      available: hasGoogleTranslateKey(),
      translate: translateWithGoogleTranslate
    };
  }

  return {
    name: "gemini",
    available: hasGeminiKey(),
    translate: translateWithGemini
  };
};

export const translateText = async ({ text, sourceLang, targetLang }) => {
  const cleanText = text?.trim();

  if (!cleanText) {
    return { text: "", provider: "none", stale: true };
  }

  const failures = [];
  const deadline = Date.now() + getTotalTimeoutMs();
  const providers = getProviderOrder().map(getProvider);

  for (const provider of providers) {
    if (!provider.available) {
      failures.push(`${provider.name}: missing API key`);
      continue;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      failures.push(`${provider.name}: total realtime translation budget exceeded`);
      break;
    }

    try {
      const translatedText = (await provider.translate({ text: cleanText, sourceLang, targetLang, timeoutMs: getProviderTimeoutMs(remainingMs) }))?.trim() || "";
      if (translatedText) {
        return { text: translatedText, provider: provider.name, stale: false };
      }
      failures.push(`${provider.name}: empty translation`);
    } catch (error) {
      failures.push(`${provider.name}: ${readErrorMessage(error)}`);
    }
  }

  console.warn(`Translation fallback used. ${failures.join(" | ")}`);
  return { text: cleanText, provider: "source", stale: true };
};
