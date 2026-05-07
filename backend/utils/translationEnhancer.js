import {
  CONTEXT_REPLACEMENTS,
  GREETING_INTELLIGENCE,
  LOCAL_LANGUAGE_MARKERS,
  LOCAL_PHRASES,
  LOCAL_TRANSLATIONS,
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

const normalizeLanguageCode = (language = "") => {
  const normalized = String(language || "").trim().toLowerCase().replace("_", "-");
  if (!normalized) return "";
  if (normalized === "lg" || normalized === "lg-ug" || normalized === "lug" || normalized === "luganda") return "luganda";
  if (normalized.startsWith("rw")) return "rw";
  if (normalized.startsWith("rn")) return "rn";
  if (normalized.startsWith("sw")) return "sw";
  if (normalized.startsWith("en")) return "en";
  return normalized.split("-")[0] || normalized;
};

const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const phrasePattern = (phrase = "") => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}(?=$|[^\\p{L}\\p{N}])`, "giu");

const countPhraseMatches = (normalizedText = "", phrase = "") => {
  const matches = normalizedText.match(phrasePattern(normalizeProfileText(phrase)));
  return matches?.length || 0;
};

const scoreLocalLanguageMarkers = (normalizedText = "", markers = {}) => {
  let score = 0;

  for (const phrase of markers.phrases || []) {
    const matches = countPhraseMatches(normalizedText, phrase);
    if (!matches) continue;
    score += matches * (phrase.includes(" ") ? 5 : 3.5);
  }

  for (const word of markers.words || []) {
    const matches = countPhraseMatches(normalizedText, word);
    if (!matches) continue;
    score += matches * 1.5;
  }

  return score;
};

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

const resolveExactLocalTranslation = ({ text = "", sourceLang = "", targetLang = "" } = {}) => {
  const source = normalizeLanguageCode(sourceLang);
  const target = normalizeLanguageCode(targetLang);
  const cleanText = normalizePunctuation(text).replace(/[.!?]+$/g, "").trim();

  if (!source || !target || source === target || !cleanText) return "";

  const directPhrases = LOCAL_TRANSLATIONS[target]?.[source] || {};
  const directTranslation = exactPhraseCorrection(cleanText, directPhrases);
  if (directTranslation) return directTranslation;

  const normalizedText = normalizeProfileText(cleanText);
  const phraseEntries = Object.entries(directPhrases).sort(([left], [right]) => right.length - left.length);

  for (const [phrase, replacement] of phraseEntries) {
    if (!countPhraseMatches(normalizedText, phrase)) continue;
    if (normalizedText === normalizeProfileText(phrase)) return preservePunctuation(replacement, cleanText);
  }

  return "";
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

export const detectLocalSourceLanguage = ({
  text = "",
  transcriptHistory = [],
  previousLanguage = "",
  providerLanguage = "",
  configuredSourceLang = ""
} = {}) => {
  const normalizedText = normalizeProfileText(text);
  const normalizedPrevious = normalizeLanguageCode(previousLanguage);
  const normalizedProvider = normalizeLanguageCode(providerLanguage);
  const normalizedConfigured = normalizeLanguageCode(configuredSourceLang);

  if (!normalizedText) {
    return {
      language: normalizedPrevious || normalizedProvider || normalizedConfigured || "",
      confidence: 0,
      source: "empty",
      scores: {}
    };
  }

  const historyText = normalizeProfileText(
    (Array.isArray(transcriptHistory) ? transcriptHistory : [])
      .slice(-6)
      .map((entry) => (typeof entry === "string" ? entry : entry?.original || entry?.text || ""))
      .filter(Boolean)
      .join(" ")
  );
  const scores = {};

  for (const [language, markers] of Object.entries(LOCAL_LANGUAGE_MARKERS)) {
    scores[language] = scoreLocalLanguageMarkers(normalizedText, markers);

    if (historyText) {
      scores[language] += scoreLocalLanguageMarkers(historyText, markers) * 0.22;
    }
  }

  if (normalizedPrevious && scores[normalizedPrevious] !== undefined) {
    scores[normalizedPrevious] += 1.2;
  }

  if (normalizedProvider && scores[normalizedProvider] !== undefined) {
    scores[normalizedProvider] += normalizedProvider === "en" ? 0.4 : 0.9;
  }

  if (normalizedConfigured && normalizedConfigured !== "auto" && scores[normalizedConfigured] !== undefined) {
    scores[normalizedConfigured] += normalizedConfigured === "en" ? 0.35 : 0.7;
  }

  const localBest = Object.entries(scores)
    .filter(([language]) => language !== "en")
    .sort(([, leftScore], [, rightScore]) => rightScore - leftScore)[0] || ["", 0];
  const englishScore = scores.en || 0;
  const sortedScores = Object.entries(scores).sort(([, leftScore], [, rightScore]) => rightScore - leftScore);
  const [bestLanguage, bestScore = 0] = sortedScores[0] || ["", 0];
  const [, secondScore = 0] = sortedScores[1] || ["", 0];

  let confidence = bestScore > 0 ? bestScore / (bestScore + secondScore + 0.6) : 0;

  if (bestLanguage !== "en" && bestScore >= 3.5) confidence = Math.max(confidence, 0.74);
  if (bestLanguage === "en" && localBest[1] > 0) confidence = Math.min(confidence, 0.68);
  if (bestLanguage === "en" && englishScore < 4) confidence = Math.min(confidence, 0.62);

  return {
    language: bestLanguage || normalizedProvider || normalizedConfigured || "",
    confidence: Number(Math.min(0.98, confidence).toFixed(2)),
    source: "local",
    scores
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

export const resolveLocalTranslation = ({ text = "", sourceLang = "", targetLang = "" } = {}) => {
  const language = normalizeLanguageCode(targetLang);
  const source = normalizeLanguageCode(sourceLang);
  const cleanText = normalizePunctuation(text).replace(/[.!?]+$/g, "").trim();

  if (!cleanText) return "";

  const exactTranslation = resolveExactLocalTranslation({ text: cleanText, sourceLang: source, targetLang: language });
  if (exactTranslation) return exactTranslation;

  if (language === "rw") {
    return exactPhraseCorrection(cleanText, LOCAL_PHRASES.rw) || "";
  }

  if (language === "rn") {
    return exactPhraseCorrection(cleanText, LOCAL_PHRASES.rn) || "";
  }

  if (language === "sw") {
    return exactPhraseCorrection(cleanText, LOCAL_PHRASES.sw) || "";
  }

  if (language === "luganda") {
    return exactPhraseCorrection(cleanText, LOCAL_PHRASES.luganda) || "";
  }

  if (language === "en") {
    if (source === "luganda") return exactPhraseCorrection(cleanText, LOCAL_TRANSLATIONS.en.luganda) || "";
    if (source === "rw") return exactPhraseCorrection(cleanText, LOCAL_TRANSLATIONS.en.rw) || "";
    if (source === "rn") return exactPhraseCorrection(cleanText, LOCAL_TRANSLATIONS.en.rn) || "";
    if (source === "sw") return exactPhraseCorrection(cleanText, LOCAL_TRANSLATIONS.en.sw) || "";
    return exactPhraseCorrection(cleanText, LOCAL_PHRASES.ugandaMix) || "";
  }

  return "";
};

export const enhanceTranslation = ({ text = "", targetLang = "" } = {}) => {
  const language = String(targetLang || "").trim().toLowerCase();

  if (language === "rw") return enhanceKinyarwanda(text);
  if (language === "rn") return enhanceKirundi(text);
  return normalizePunctuation(cleanRepeatedWords(removeRoboticPhrasing(text)));
};
