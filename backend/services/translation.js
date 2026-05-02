// @ts-nocheck
import { translateWithGemini } from "./gemini.js";
import { translateWithGoogleTranslate } from "./googleTranslate.js";

const readErrorMessage = (error) => error?.message || String(error || "Unknown translation error");

export const translateText = async ({ text, sourceLang, targetLang }) => {
  const cleanText = text?.trim();

  if (!cleanText) {
    return { text: "", provider: "none" };
  }

  const failures = [];

  try {
    const translatedText = (await translateWithGemini({ text: cleanText, sourceLang, targetLang }))?.trim() || "";
    if (translatedText) {
      return { text: translatedText, provider: "gemini" };
    }
    failures.push("Gemini returned an empty translation");
  } catch (error) {
    failures.push(`Gemini: ${readErrorMessage(error)}`);
  }

  try {
    const translatedText = (await translateWithGoogleTranslate({ text: cleanText, sourceLang, targetLang }))?.trim() || "";
    if (translatedText) {
      return { text: translatedText, provider: "google" };
    }
    failures.push("Google Translate returned an empty translation");
  } catch (error) {
    failures.push(`Google Translate: ${readErrorMessage(error)}`);
  }

  throw new Error(`All translation providers failed. ${failures.join(" | ")}`);
};
