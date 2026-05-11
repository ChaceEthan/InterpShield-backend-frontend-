// @ts-nocheck
import { GoogleGenAI } from "@google/genai";
import { LANGUAGE_NAMES, TARGET_LANGUAGE_INSTRUCTIONS } from "../data/languageMemory.js";
import { enhanceTranslation } from "../utils/translationEnhancer.js";

const GEMINI_TIMEOUT_MS = 25000;
const SUPPORTED_LANGUAGE_CODES = new Set(["en", "fr", "es", "de", "it", "pt", "nl", "ar", "zh", "ja", "ko", "hi", "tr", "pl", "ru", "sw"]);
const FORBIDDEN_LANGUAGE_CODES = new Set(["rw", "rn", "lg", "lug", "luganda", "ug", "lg-ug"]);
const SUPPORTED_LANGUAGE_LIST = "English (en), French (fr), Spanish (es), German (de), Italian (it), Portuguese (pt), Dutch (nl), Arabic (ar), Chinese Simplified (zh), Japanese (ja), Korean (ko), Hindi (hi), Turkish (tr), Polish (pl), Russian (ru), Swahili (sw)";

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
  const normalized = normalizedLanguageCode(code).replace("_", "-");
  if (FORBIDDEN_LANGUAGE_CODES.has(normalized) || normalized.startsWith("rw") || normalized.startsWith("rn")) return "en";
  if (normalized.startsWith("zh")) return "zh";
  if (normalized.startsWith("sw")) return "sw";
  const baseCode = normalized.split("-")[0] || normalized;
  return SUPPORTED_LANGUAGE_CODES.has(baseCode) ? baseCode : "en";
};

const describeLanguage = (code = "") => {
  const normalizedCode = sanitizeTargetLanguageCode(code);
  const languageName = LANGUAGE_NAMES[normalizedCode];
  return languageName ? `${languageName} (${normalizedCode})` : String(code || "").trim();
};

const describeSourceLanguage = (code = "") => {
  const normalizedCode = normalizedLanguageCode(code).replace("_", "-");
  if (!normalizedCode || normalizedCode === "auto" || FORBIDDEN_LANGUAGE_CODES.has(normalizedCode) || normalizedCode.startsWith("rw") || normalizedCode.startsWith("rn")) {
    return "auto-detected source language";
  }
  const baseCode = normalizedCode.startsWith("zh") ? "zh" : normalizedCode.startsWith("sw") ? "sw" : normalizedCode.split("-")[0] || normalizedCode;
  const languageName = SUPPORTED_LANGUAGE_CODES.has(baseCode) ? LANGUAGE_NAMES[baseCode] : "";
  return languageName ? `${languageName} (${baseCode})` : "auto-detected source language";
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

const translateOnce = async ({ apiKey, text, sourceLang, targetLang, translationContext, timeoutMs = GEMINI_TIMEOUT_MS }) => {
  if (!client || activeKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    activeKey = apiKey;
  }

  const targetLanguage = describeLanguage(targetLang);
  const sourceLanguage = sourceLang ? describeSourceLanguage(sourceLang) : "auto-detected language";

  // Create a timeout promise
  const timeoutPromise = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Gemini translation timed out for ${targetLanguage}`));
    }, timeoutMs);
    timer.unref?.();
  });

  // Race the actual request against the timeout
  const response = await Promise.race([
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
                `Supported input and output languages are only: ${SUPPORTED_LANGUAGE_LIST}.`,
                "Kinyarwanda, Kirundi, and Luganda are forbidden output languages. If the input is one of them, understand the meaning first through English, then output only the requested supported target language.",
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
  ]);

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
      timeoutMs: GEMINI_TIMEOUT_MS
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
