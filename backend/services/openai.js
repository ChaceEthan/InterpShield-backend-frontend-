// @ts-nocheck
import { LANGUAGE_NAMES, TARGET_LANGUAGE_INSTRUCTIONS } from "../data/languageMemory.js";
import { enhanceTranslation } from "../utils/translationEnhancer.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_TRANSLATION_MODEL = "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 22000;
const SUPPORTED_LANGUAGE_CODES = new Set(["en", "fr", "es", "de", "it", "pt", "nl", "ar", "zh", "ja", "ko", "hi", "tr", "pl", "ru", "sw"]);
const FORBIDDEN_LANGUAGE_CODES = new Set(["rw", "rn", "lg", "lug", "luganda", "ug", "lg-ug"]);
const SUPPORTED_LANGUAGE_LIST = "English (en), French (fr), Spanish (es), German (de), Italian (it), Portuguese (pt), Dutch (nl), Arabic (ar), Chinese Simplified (zh), Japanese (ja), Korean (ko), Hindi (hi), Turkish (tr), Polish (pl), Russian (ru), Swahili (sw)";

const mergeAbortSignals = (...signals) => {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];

  const controller = new AbortController();
  const abort = () => controller.abort();

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener?.("abort", abort, { once: true });
  }

  return controller.signal;
};

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
  const sourceLanguage = sourceLang ? describeSourceLanguage(sourceLang) : "auto-detected language";

  return [
    "You are a professional real-time interpreter.",
    `Translate the user's text from ${sourceLanguage} to ${targetLanguage}.`,
    `Supported input and output languages are only: ${SUPPORTED_LANGUAGE_LIST}.`,
    "Kinyarwanda, Kirundi, and Luganda are forbidden output languages. If the input is one of them, understand the meaning first through English, then output only the requested supported target language.",
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
    "Return only the translated text."
  ].join("\n");
};

export const translateWithOpenAI = async ({ apiKey, text, sourceLang, targetLang, translationContext, signal }) => {
  const cleanText = text?.trim();

  if (!cleanText || !apiKey) {
    return "";
  }

  if (signal?.aborted) {
    throw new Error("OpenAI translation aborted");
  }

  const targetLanguage = describeLanguage(targetLang);

  const systemPrompt = buildSystemPrompt({ sourceLang, targetLang, translationContext });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    
    const mergedSignal = mergeAbortSignals(signal, controller.signal);

    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      signal: mergedSignal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_TRANSLATION_MODEL,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: `Text:\n${cleanText}`
          }
        ],
        temperature: 0,
        max_tokens: 512
      })
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = errorData?.error?.message || errorData?.error || response.statusText || "OpenAI translation request failed";
      throw new Error(`OpenAI ${response.status}: ${message}`);
    }

    const data = await response.json();

    if (!data?.choices?.length) {
      throw new Error(`OpenAI returned no translation choices for ${targetLanguage}`);
    }

    const messageContent = data.choices[0]?.message?.content || "";
    const translatedText = normalizeTranslatedText({ text: messageContent, targetLang });

    if (!translatedText) {
      throw new Error(`OpenAI returned an empty translation for ${targetLanguage}`);
    }

    const echoedSource = normalizeForComparison(translatedText) === normalizeForComparison(cleanText);
    
    if (signal?.aborted) {
      throw new Error("OpenAI translation aborted");
    }

    return translatedText && !echoedSource ? translatedText : "";
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      throw new Error("OpenAI translation aborted");
    }
    throw error;
  }
};
