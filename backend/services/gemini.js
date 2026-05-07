// @ts-nocheck
import { GoogleGenAI } from "@google/genai";
import { LANGUAGE_NAMES, TARGET_LANGUAGE_INSTRUCTIONS } from "../data/languageMemory.js";
import { enhanceTranslation } from "../utils/translationEnhancer.js";

let client = null;
let activeKey = null;

const normalizeForComparison = (value = "") =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");

const stripWrappedText = (value = "") => value.trim().replace(/^["'`]+|["'`]+$/g, "").trim();

const describeLanguage = (code = "") => {
  const normalizedCode = String(code || "").trim().toLowerCase();
  const languageName = LANGUAGE_NAMES[normalizedCode];
  return languageName ? `${languageName} (${normalizedCode})` : String(code || "").trim();
};

const normalizedLanguageCode = (code = "") => String(code || "").trim().toLowerCase();

const targetLanguageInstructions = (targetLang = "") => TARGET_LANGUAGE_INSTRUCTIONS[normalizedLanguageCode(targetLang)] || [];

const normalizeTranslatedText = ({ text, targetLang }) => {
  const cleanText = stripWrappedText(text);
  return enhanceTranslation({ text: cleanText, targetLang });
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

const translateOnce = async ({ apiKey, text, sourceLang, targetLang, translationContext }) => {
  if (!client || activeKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    activeKey = apiKey;
  }

  const targetLanguage = describeLanguage(targetLang);
  const sourceLanguage = sourceLang ? describeLanguage(sourceLang) : "auto-detected language";

  const response = await client.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "You are a professional real-time interpreter.",
              `Translate the user's text from ${sourceLanguage} to ${targetLanguage}.`,
              `Translate to ${targetLanguage}.`,
              `The output language must be ${targetLanguage}.`,
              "Speak naturally like a real East African human interpreter, not a literal machine translator.",
              "Preserve slang meaning, emotion, respect level, personality, and conversational flow.",
              "Prefer local vocabulary and natural sentence structure over word-for-word translation.",
              "Avoid robotic, overly formal, or over-English phrasing.",
              "Never return English unless the target language is English (en).",
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
  });

  const translatedText = normalizeTranslatedText({ text: response.text || "", targetLang });
  if (!translatedText) {
    throw new Error(`Gemini returned an empty translation for ${targetLanguage || targetLang}`);
  }

  return translatedText;
};

export const translateWithGemini = async ({ apiKey, text, sourceLang, targetLang, translationContext }) => {
  const cleanText = text?.trim();

  if (!cleanText) {
    return "";
  }

  if (!apiKey) {
    return "";
  }

  const translatedText = await translateOnce({ apiKey, text: cleanText, sourceLang, targetLang, translationContext });
  const echoedSource = normalizeForComparison(translatedText) === normalizeForComparison(cleanText);

  if (translatedText && !echoedSource) {
    return translatedText;
  }

  return "";
};
