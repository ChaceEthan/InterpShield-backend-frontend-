export const LANGUAGE_CATALOG = Object.freeze([
  { code: "en", name: "English", region: "Global", providers: ["deepgram", "gemini", "openai"] },
  { code: "es", name: "Spanish", region: "Spain / LATAM", providers: ["deepgram", "gemini", "openai"] },
  { code: "fr", name: "French", region: "France / Global", providers: ["deepgram", "gemini", "openai"] },
  { code: "de", name: "German", region: "Germany", providers: ["deepgram", "gemini", "openai"] },
  { code: "it", name: "Italian", region: "Italy", providers: ["deepgram", "gemini", "openai"] },
  { code: "pt", name: "Portuguese", region: "Brazil / Portugal", providers: ["deepgram", "gemini", "openai"] },
  { code: "nl", name: "Dutch", region: "Netherlands / Belgium", providers: ["deepgram", "gemini", "openai"] },
  { code: "ar", name: "Arabic", region: "MENA", providers: ["deepgram", "gemini", "openai"] },
  { code: "bn", name: "Bengali", region: "Bangladesh / India", providers: ["deepgram", "gemini", "openai"] },
  { code: "bg", name: "Bulgarian", region: "Bulgaria", providers: ["deepgram", "gemini", "openai"] },
  { code: "zh", name: "Chinese", region: "Simplified / Traditional", providers: ["deepgram", "gemini", "openai"] },
  { code: "hr", name: "Croatian", region: "Croatia", providers: ["deepgram", "gemini", "openai"] },
  { code: "cs", name: "Czech", region: "Czechia", providers: ["deepgram", "gemini", "openai"] },
  { code: "da", name: "Danish", region: "Denmark", providers: ["deepgram", "gemini", "openai"] },
  { code: "et", name: "Estonian", region: "Estonia", providers: ["deepgram", "gemini", "openai"] },
  { code: "fi", name: "Finnish", region: "Finland", providers: ["deepgram", "gemini", "openai"] },
  { code: "el", name: "Greek", region: "Greece", providers: ["deepgram", "gemini", "openai"] },
  { code: "he", name: "Hebrew", region: "Israel", providers: ["deepgram", "gemini", "openai"] },
  { code: "hi", name: "Hindi", region: "India", providers: ["deepgram", "gemini", "openai"] },
  { code: "hu", name: "Hungarian", region: "Hungary", providers: ["deepgram", "gemini", "openai"] },
  { code: "id", name: "Indonesian", region: "Indonesia", providers: ["deepgram", "gemini", "openai"] },
  { code: "ja", name: "Japanese", region: "Japan", providers: ["deepgram", "gemini", "openai"] },
  { code: "ko", name: "Korean", region: "Korea", providers: ["deepgram", "gemini", "openai"] },
  { code: "lv", name: "Latvian", region: "Latvia", providers: ["deepgram", "gemini", "openai"] },
  { code: "lt", name: "Lithuanian", region: "Lithuania", providers: ["deepgram", "gemini", "openai"] },
  { code: "no", name: "Norwegian", region: "Norway", providers: ["deepgram", "gemini", "openai"] },
  { code: "pl", name: "Polish", region: "Poland", providers: ["deepgram", "gemini", "openai"] },
  { code: "ro", name: "Romanian", region: "Romania", providers: ["deepgram", "gemini", "openai"] },
  { code: "ru", name: "Russian", region: "Global", providers: ["deepgram", "gemini", "openai"] },
  { code: "sr", name: "Serbian", region: "Serbia", providers: ["deepgram", "gemini", "openai"] },
  { code: "sk", name: "Slovak", region: "Slovakia", providers: ["deepgram", "gemini", "openai"] },
  { code: "sl", name: "Slovenian", region: "Slovenia", providers: ["deepgram", "gemini", "openai"] },
  { code: "sw", name: "Swahili", region: "East Africa", providers: ["gemini", "openai", "local"] },
  { code: "sv", name: "Swedish", region: "Sweden", providers: ["deepgram", "gemini", "openai"] },
  { code: "th", name: "Thai", region: "Thailand", providers: ["deepgram", "gemini", "openai"] },
  { code: "tr", name: "Turkish", region: "Turkiye", providers: ["deepgram", "gemini", "openai"] },
  { code: "uk", name: "Ukrainian", region: "Ukraine", providers: ["deepgram", "gemini", "openai"] },
  { code: "vi", name: "Vietnamese", region: "Vietnam", providers: ["deepgram", "gemini", "openai"] },
  { code: "rw", name: "Kinyarwanda", region: "Rwanda", providers: ["local", "openai"] },
  { code: "rn", name: "Kirundi", region: "Burundi", providers: ["local", "openai"] },
  { code: "lg", name: "Luganda", region: "Uganda", providers: ["local", "openai"] }
]);

export const LANGUAGE_ALIASES = Object.freeze({
  "ar-ae": "ar",
  "ar-sa": "ar",
  "ar-eg": "ar",
  "en-us": "en",
  "en-gb": "en",
  "en-au": "en",
  "en-in": "en",
  "es-419": "es",
  "es-latam": "es",
  "pt-br": "pt",
  "pt-pt": "pt",
  "zh-cn": "zh",
  "zh-tw": "zh",
  "cmn-cn": "zh",
  "cmn-tw": "zh",
  iw: "he",
  "he-il": "he",
  "hi-latn": "hi",
  "lg-ug": "lg",
  lug: "lg",
  luganda: "lg",
  ug: "lg",
  "sw-ke": "sw",
  "sw-tz": "sw"
});

export const SUPPORTED_LANGUAGE_CODES = Object.freeze(new Set(LANGUAGE_CATALOG.map((language) => language.code)));

export const LANGUAGE_NAMES = Object.freeze(
  LANGUAGE_CATALOG.reduce((names, language) => {
    names[language.code] = language.name;
    return names;
  }, {})
);

export const LANGUAGE_FLAGS = Object.freeze({
  en: "US",
  es: "ES",
  fr: "FR",
  de: "DE",
  it: "IT",
  pt: "PT",
  nl: "NL",
  ar: "AR",
  bn: "BN",
  bg: "BG",
  zh: "CN",
  hr: "HR",
  cs: "CZ",
  da: "DK",
  et: "EE",
  fi: "FI",
  el: "GR",
  he: "HE",
  hi: "IN",
  hu: "HU",
  id: "ID",
  ja: "JP",
  ko: "KR",
  lv: "LV",
  lt: "LT",
  no: "NO",
  pl: "PL",
  ro: "RO",
  ru: "RU",
  sr: "RS",
  sk: "SK",
  sl: "SI",
  sw: "SW",
  sv: "SE",
  th: "TH",
  tr: "TR",
  uk: "UA",
  vi: "VI",
  rw: "RW",
  rn: "BI",
  lg: "UG"
});

export const SPEECH_SYNTHESIS_LANGS = Object.freeze({
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-PT",
  nl: "nl-NL",
  ar: "ar-SA",
  bn: "bn-BD",
  bg: "bg-BG",
  zh: "zh-CN",
  hr: "hr-HR",
  cs: "cs-CZ",
  da: "da-DK",
  et: "et-EE",
  fi: "fi-FI",
  el: "el-GR",
  he: "he-IL",
  hi: "hi-IN",
  hu: "hu-HU",
  id: "id-ID",
  ja: "ja-JP",
  ko: "ko-KR",
  lv: "lv-LV",
  lt: "lt-LT",
  no: "nb-NO",
  pl: "pl-PL",
  ro: "ro-RO",
  ru: "ru-RU",
  sr: "sr-RS",
  sk: "sk-SK",
  sl: "sl-SI",
  sw: "sw-KE",
  sv: "sv-SE",
  th: "th-TH",
  tr: "tr-TR",
  uk: "uk-UA",
  vi: "vi-VN",
  rw: "rw-RW",
  rn: "rn-BI",
  lg: "lg-UG"
});

export const normalizeLanguageCode = (language = "") => {
  const normalized = String(language || "").trim().toLowerCase().replace("_", "-");
  if (!normalized) return "";
  if (SUPPORTED_LANGUAGE_CODES.has(normalized)) return normalized;
  if (LANGUAGE_ALIASES[normalized]) return LANGUAGE_ALIASES[normalized];

  const baseCode = normalized.split("-")[0] || normalized;
  return SUPPORTED_LANGUAGE_CODES.has(baseCode) ? baseCode : "";
};

export const providerLanguageCode = (language = "", provider = "") => {
  const code = normalizeLanguageCode(language);
  if (!code) return "";
  if (provider === "gemini" && code === "he") return "iw";
  return code;
};

export const supportedLanguageList = () =>
  LANGUAGE_CATALOG.map((language) => `${language.name} (${language.code})`).join(", ");

