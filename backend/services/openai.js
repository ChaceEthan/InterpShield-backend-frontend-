// @ts-nocheck
import { LANGUAGE_NAMES, TARGET_LANGUAGE_INSTRUCTIONS } from "../data/languageMemory.js";
import { enhanceTranslation } from "../utils/translationEnhancer.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_REALTIME_TRANSLATION_MODEL = "gpt-4.1-nano";

const normalizeForComparison = (value = "") =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");

const stripWrappedText = (value = "") => value.trim().replace(/^["'`]+|["'`]+$/g, "").trim();

const normalizedLanguageCode = (code = "") => String(code || "").trim().toLowerCase();

const describeLanguage = (code = "") => {
  const normalizedCode = normalizedLanguageCode(code);
  const languageName = LANGUAGE_NAMES[normalizedCode];
  return languageName ? `${languageName} (${normalizedCode})` : String(code || "").trim();
};

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

const extractOutputText = (data = {}) => {
  if (typeof data.output_text === "string") return data.output_text.trim();

  const textParts = [];
  for (const item of data.output || []) {
    if (!Array.isArray(item?.content)) continue;

    for (const content of item.content) {
      if (typeof content?.text === "string") textParts.push(content.text);
      if (typeof content?.output_text === "string") textParts.push(content.output_text);
      if (typeof content?.content === "string") textParts.push(content.content);
    }
  }

  return textParts.join(" ").trim();
};

const buildSystemPrompt = ({ sourceLang, targetLang, translationContext }) => {
  const targetLanguage = describeLanguage(targetLang);
  const sourceLanguage = sourceLang ? describeLanguage(sourceLang) : "auto-detected language";

  return [
    "You are a professional real-time interpreter.",
    `Translate the user's text from ${sourceLanguage} to ${targetLanguage}.`,
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
    "Return only the translated text."
  ].join("\n");
};

export const translateWithOpenAI = async ({ apiKey, text, sourceLang, targetLang, translationContext }) => {
  const cleanText = text?.trim();

  if (!cleanText || !apiKey) {
    return "";
  }

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_REALTIME_TRANSLATION_MODEL,
      input: [
        {
          role: "system",
          content: buildSystemPrompt({ sourceLang, targetLang, translationContext })
        },
        {
          role: "user",
          content: `Text:\n${cleanText}`
        }
      ],
      temperature: 0,
      max_output_tokens: 512
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || data?.error || response.statusText || "OpenAI translation request failed";
    throw new Error(`OpenAI ${response.status}: ${message}`);
  }

  const translatedText = normalizeTranslatedText({ text: extractOutputText(data), targetLang });
  if (!translatedText) {
    throw new Error(`OpenAI returned an empty translation for ${describeLanguage(targetLang) || targetLang}`);
  }

  const echoedSource = normalizeForComparison(translatedText) === normalizeForComparison(cleanText);
  return translatedText && !echoedSource ? translatedText : "";
};
