// @ts-nocheck
import { GoogleGenAI } from "@google/genai";
import { LANGUAGE_NAMES, TARGET_LANGUAGE_INSTRUCTIONS } from "../data/languageMemory.js";
import { enhanceTranslation } from "../utils/translationEnhancer.js";
import {
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode,
  providerLanguageCode,
  supportedLanguageList
} from "../../shared/languages.mjs";

const GEMINI_TIMEOUT_MS = 25000;
const SUPPORTED_LANGUAGE_LIST = supportedLanguageList();

let client = null;
let activeKey = null;

const normalizeForComparison = (value = "") =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");

const stripWrappedText = (value = "") => value.trim().replace(/^["'`]+|["'`]+$/g, "").trim();

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

const abortError = () => new Error("Gemini translation aborted");

const createAbortPromise = (signal) => {
  if (!signal) return { promise: null, cleanup: () => undefined };
  if (signal.aborted) return { promise: Promise.reject(abortError()), cleanup: () => undefined };

  let handleAbort = () => undefined;
  const promise = new Promise((_, reject) => {
    handleAbort = () => reject(abortError());
    signal.addEventListener?.("abort", handleAbort, { once: true });
  });

  return {
    promise,
    cleanup: () => signal.removeEventListener?.("abort", handleAbort)
  };
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

const translateOnce = async ({ apiKey, text, sourceLang, targetLang, translationContext, timeoutMs = GEMINI_TIMEOUT_MS, signal }) => {
  if (!client || activeKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    activeKey = apiKey;
  }

  const targetLanguage = describeLanguage(targetLang);
  const sourceLanguage = sourceLang ? describeSourceLanguage(sourceLang) : "auto-detected language";

  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Gemini translation timed out for ${targetLanguage}`));
    }, timeoutMs);
    timeout.unref?.();
  });
  const abortPromise = createAbortPromise(signal);
  const pendingPromises = [
    client.models.generateContent({
      model: "gemini-2.5-flash",
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
      config: {
        temperature: 0,
        maxOutputTokens: 512
      }
    }),
    timeoutPromise
  ];

  if (abortPromise.promise) pendingPromises.push(abortPromise.promise);

  let response = null;

  try {
    response = await Promise.race(pendingPromises);
  } finally {
    if (timeout) clearTimeout(timeout);
    abortPromise.cleanup();
  }

  const translatedText = normalizeTranslatedText({ text: extractGeminiText(response), targetLang });
  if (!translatedText) {
    throw new Error(`Gemini returned an empty translation for ${targetLanguage || targetLang}`);
  }

  return translatedText;
};

export const translateWithGemini = async ({ apiKey, text, sourceLang, targetLang, translationContext, signal }) => {
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

  try {
    const translatedText = await translateOnce({ 
      apiKey, 
      text: cleanText, 
      sourceLang, 
      targetLang, 
      translationContext,
      timeoutMs: GEMINI_TIMEOUT_MS,
      signal
    });
    
    if (signal?.aborted) {
      throw new Error("Gemini translation aborted");
    }

    const echoedSource = normalizeForComparison(translatedText) === normalizeForComparison(cleanText);

    if (translatedText && !echoedSource) {
      return translatedText;
    }

    return "";
  } catch (error) {
    if (signal?.aborted || /aborted/i.test(error?.message || "")) {
      throw new Error("Gemini translation aborted");
    }
    throw error;
  }
};
