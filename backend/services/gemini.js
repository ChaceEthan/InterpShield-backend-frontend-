// @ts-nocheck
import { GoogleGenAI } from "@google/genai";

const TEMPORARILY_UNAVAILABLE = "Translation temporarily unavailable";

let client = null;
let activeKey = null;

const normalizeForComparison = (value = "") =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");

const stripWrappedText = (value = "") => value.trim().replace(/^["'`]+|["'`]+$/g, "").trim();

const translateOnce = async ({ apiKey, text, sourceLang, targetLang }) => {
  if (!client || activeKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    activeKey = apiKey;
  }

  const response = await client.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "You are a professional real-time interpreter.",
              `Translate the user's text from ${sourceLang || "auto-detected language"} to ${targetLang}.`,
              `The output language must be ${targetLang}.`,
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

  return stripWrappedText(response.text || "");
};

export const translateWithGemini = async ({ apiKey, text, sourceLang, targetLang }) => {
  const cleanText = text?.trim();

  if (!cleanText) {
    return "";
  }

  if (!apiKey) {
    return TEMPORARILY_UNAVAILABLE;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const translatedText = await translateOnce({ apiKey, text: cleanText, sourceLang, targetLang });
      const echoedSource = normalizeForComparison(translatedText) === normalizeForComparison(cleanText);

      if (translatedText && !echoedSource) {
        return translatedText;
      }
    } catch (error) {
      if (attempt === 1) {
        console.error("Gemini translation failed:", error?.message || error);
      }
    }
  }

  return TEMPORARILY_UNAVAILABLE;
};
