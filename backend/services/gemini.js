// @ts-nocheck
import { GoogleGenAI } from "@google/genai";

let client = null;
let activeKey = null;

const normalizeForComparison = (value = "") =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");

const stripWrappedText = (value = "") => value.trim().replace(/^["'`]+|["'`]+$/g, "").trim();

const LANGUAGE_NAMES = {
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
  ru: "Russian",
  rw: "Kinyarwanda",
  rn: "Kirundi"
};

const describeLanguage = (code = "") => {
  const normalizedCode = String(code || "").trim().toLowerCase();
  const languageName = LANGUAGE_NAMES[normalizedCode];
  return languageName ? `${languageName} (${normalizedCode})` : String(code || "").trim();
};

const translateOnce = async ({ apiKey, text, sourceLang, targetLang }) => {
  if (!client || activeKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    activeKey = apiKey;
  }

  const targetLanguage = describeLanguage(targetLang);

  const response = await client.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "You are a professional real-time interpreter.",
              `Translate the user's text from ${sourceLang || "auto-detected language"} to ${targetLanguage}.`,
              `Translate to ${targetLanguage}.`,
              `The output language must be ${targetLanguage}.`,
              "Never return English unless the target language is English (en).",
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
  });

  const translatedText = stripWrappedText(response.text || "");
  if (!translatedText) {
    throw new Error(`Gemini returned an empty translation for ${targetLanguage || targetLang}`);
  }

  return translatedText;
};

export const translateWithGemini = async ({ apiKey, text, sourceLang, targetLang }) => {
  const cleanText = text?.trim();

  if (!cleanText) {
    return "";
  }

  if (!apiKey) {
    return "";
  }

  const translatedText = await translateOnce({ apiKey, text: cleanText, sourceLang, targetLang });
  const echoedSource = normalizeForComparison(translatedText) === normalizeForComparison(cleanText);

  if (translatedText && !echoedSource) {
    return translatedText;
  }

  return "";
};
