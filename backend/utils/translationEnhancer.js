import {
  CONTEXT_REPLACEMENTS,
  GREETING_INTELLIGENCE,
  LOCAL_PHRASES,
  MIXED_SPEECH_TERMS,
  REGION_VARIANTS,
  ROBOTIC_PHRASES
} from "../data/languageMemory.js";

const toLanguageList = (languages, fallback = "") => {
  const requested = Array.isArray(languages) ? languages : languages ? [languages] : [fallback];
  return requested.map((language) => String(language || "").trim().toLowerCase()).filter(Boolean);
};

const normalizeProfileText = (text = "") =>
  String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const countMarkerMatches = (normalizedText, markers = []) =>
  markers.reduce((count, marker) => count + (normalizedText.includes(normalizeProfileText(marker)) ? 1 : 0), 0);

const preservePunctuation = (replacement, original = "") => {
  const punctuation = String(original || "").trim().match(/[.!?]$/)?.[0] || "";
  if (!punctuation || /[.!?]$/.test(replacement)) return replacement;
  return `${replacement}${punctuation}`;
};

const exactPhraseCorrection = (text = "", phrases = {}) => {
  const cleanText = String(text || "").trim();
  const exactKey = cleanText.toLowerCase();
  const baseKey = exactKey.replace(/[.!?]+$/g, "").trim();
  const replacement = phrases[exactKey] || phrases[baseKey];
  return replacement ? preservePunctuation(replacement, cleanText) : "";
};

const removeRoboticPhrasing = (text = "") => {
  let cleanText = String(text || "").trim();

  for (const pattern of ROBOTIC_PHRASES) {
    cleanText = cleanText.replace(pattern, "").trim();
  }

  return cleanText;
};

const normalizePunctuation = (text = "") =>
  String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?]){3,}/g, "$1")
    .replace(/([,;:]){2,}/g, "$1")
    .trim();

const cleanRepeatedWords = (text = "") =>
  String(text || "")
    .replace(/\b([\p{L}\p{N}]+)(\s+\1\b){1,}/giu, "$1")
    .replace(/\s+/g, " ")
    .trim();

const applyContextReplacements = (text = "", language = "") => {
  let enhanced = text;
  for (const [pattern, replacement] of CONTEXT_REPLACEMENTS[language] || []) {
    enhanced = enhanced.replace(pattern, replacement);
  }
  return enhanced;
};

const applyGreetingIntelligence = (text = "", language = "") => {
  const cleanText = String(text || "").trim();
  const replacements = GREETING_INTELLIGENCE[language]?.replacements || {};
  return exactPhraseCorrection(cleanText, replacements) || cleanText;
};

const baseEnhance = (text = "", language = "") => {
  const withoutRobot = removeRoboticPhrasing(text);
  const exactCorrection = exactPhraseCorrection(withoutRobot, LOCAL_PHRASES[language] || {});
  const phraseCorrected = exactCorrection || withoutRobot;
  const contextual = applyContextReplacements(phraseCorrected, language);
  const greeted = applyGreetingIntelligence(contextual, language);
  return normalizePunctuation(cleanRepeatedWords(greeted));
};

export const enhanceKinyarwanda = (text = "") => {
  let enhanced = baseEnhance(text, "rw");

  enhanced = enhanced
    .replace(/\bni byiza cyane cyane\b/gi, "ni byiza cyane")
    .replace(/\bmurakoze cyane cyane\b/gi, "murakoze cyane")
    .replace(/\bego ego\b/gi, "ego");

  return normalizePunctuation(enhanced);
};

export const enhanceKirundi = (text = "") => {
  let enhanced = baseEnhance(text, "rn");

  enhanced = enhanced
    .replace(/\bni byiza\b/gi, "ni vyiza")
    .replace(/\bcyane\b/gi, "cane")
    .replace(/\byego\b/gi, "ego")
    .replace(/\bamakuru ki\b/gi, "amakuru meza")
    .replace(/\burakoze cane cane\b/gi, "urakoze cane")
    .replace(/\bmurakoze cane cane\b/gi, "murakoze cane");

  const exactCorrection = exactPhraseCorrection(enhanced, LOCAL_PHRASES.rn);
  return normalizePunctuation(exactCorrection || enhanced);
};

export const normalizeMixedSpeech = (text = "") => {
  let normalizedText = normalizePunctuation(text);
  const replacements = [];

  for (const [localPhrase, meaning] of Object.entries(MIXED_SPEECH_TERMS)) {
    const pattern = new RegExp(`\\b${localPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    if (!pattern.test(normalizedText)) continue;

    replacements.push({ localPhrase, meaning });
    pattern.lastIndex = 0;
    normalizedText = normalizedText.replace(pattern, meaning);
  }

  return {
    normalizedText,
    replacements,
    isMixed: replacements.length > 0
  };
};

export const detectRegionAccent = ({ text = "", sourceLang, targetLang, targetLanguages = [] } = {}) => {
  const normalizedText = normalizeProfileText(text);
  const languages = toLanguageList([sourceLang, targetLang, ...toLanguageList(targetLanguages)]);
  const scores = {};

  for (const [key, variant] of Object.entries(REGION_VARIANTS)) {
    if (key === "neutral") continue;
    scores[key] = countMarkerMatches(normalizedText, variant.markers);
  }

  if (languages.includes("rw")) scores.rwanda = (scores.rwanda || 0) + 3;
  if (languages.includes("rn")) scores.burundi = (scores.burundi || 0) + 3;
  if (languages.includes("sw")) scores.mixed = (scores.mixed || 0) + 2;
  if (languages.includes("fr")) scores.mixed = (scores.mixed || 0) + 1;

  const swahiliFrenchMix =
    countMarkerMatches(normalizedText, ["habari", "asante", "sawa", "tafadhali"]) > 0 &&
    countMarkerMatches(normalizedText, ["bonjour", "merci", "ca va", "salut"]) > 0;

  if (swahiliFrenchMix) scores.mixed = (scores.mixed || 0) + 4;

  const [profileKey, score = 0] = Object.entries(scores).sort(([, leftScore], [, rightScore]) => rightScore - leftScore)[0] || ["neutral", 0];
  const resolvedKey = score > 0 ? profileKey : "neutral";
  const profile = REGION_VARIANTS[resolvedKey] || REGION_VARIANTS.neutral;

  return {
    ...profile,
    confidence: Math.min(1, Number((score / 5).toFixed(2)))
  };
};

export const enhanceTranslation = ({ text = "", targetLang = "" } = {}) => {
  const language = String(targetLang || "").trim().toLowerCase();

  if (language === "rw") return enhanceKinyarwanda(text);
  if (language === "rn") return enhanceKirundi(text);
  return normalizePunctuation(cleanRepeatedWords(removeRoboticPhrasing(text)));
};
