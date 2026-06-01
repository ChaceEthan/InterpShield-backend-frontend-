import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  BadgeHelp,
  Check,
  ChevronDown,
  CircleStop,
  Crown,
  Download,
  FileText,
  KeyRound,
  Languages,
  ListChecks,
  Lock,
  LogOut,
  Mic,
  Settings,
  Share2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Timer,
  User,
  Volume2,
  type LucideIcon
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { io, type Socket } from "socket.io-client";
import { HeroSection } from "./components/HeroSection";
import { LanguageSelector } from "./components/LanguageSelector";
import { ModeTabs, type PrivacyMode } from "./components/ModeTabs";
import { Navbar } from "./components/Navbar";
import { ToolTabs } from "./components/ToolTabs";
import { TranslationOptions } from "./components/TranslationOptions";
import { TranslationPanel } from "./components/TranslationPanel";
import type { TranscriptTranslationEntry } from "./components/TranscriptArea";

type View = "landing" | "login" | "signup" | "dashboard" | "pricing" | "history" | "help" | "settings" | "admin";
type Mode = "transcribe" | "translate" | "dubbing";
type SessionStatus = "idle" | "connecting" | "listening" | "stopping" | "error";
type TranslationLifecycleState = "ready" | "queued" | "processing" | "translating" | "retrying" | "translated" | "done" | "failed" | "stale" | "cancelled";
type SocketConnectionState = "ready" | "connecting" | "connected" | "listening" | "translating" | "reconnecting";
type MicrophonePermissionState = "unknown" | "prompt" | "granted" | "denied" | "unsupported";
type Plan = "free" | "pro";
type SummaryLength = "short" | "standard" | "long";
type AuthProvider = "manual" | "google";

interface Language {
  code: string;
  name: string;
  region: string;
}

interface UserSettings {
  privateMode?: boolean;
  shareableMode?: boolean;
  preferredSourceLang?: string;
  preferredTargetLang?: string;
  preferredTargetLanguages?: string[];
  preferredProvider?: string;
  saveTranscript?: boolean;
  saveAudio?: boolean;
  speakerDetection?: boolean;
  autoStopOnSilence?: boolean;
  silenceDuration?: number;
  censorProfanity?: boolean;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  microphoneId?: string;
  summaryLength?: SummaryLength;
  summaryLanguage?: string;
  sceneDetection?: boolean;
  actionItemExtraction?: boolean;
  perSpeakerSummary?: boolean;
  sentimentTracking?: boolean;
  keywordsExtraction?: boolean;
}

interface AppUser {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  picture?: string;
  plan: Plan;
  provider: string;
  role?: "admin" | "user";
  settings?: UserSettings;
}

interface AppConfig {
  status: "ok";
  services: {
    deepgram: boolean;
    gemini: boolean;
    openai?: boolean;
  };
  backend: boolean;
  hasDeepgramKey: boolean;
  hasGeminiKey: boolean;
  hasOpenAIKey?: boolean;
  hasGoogleClientId: boolean;
  mode: "production" | "unavailable";
  maxSessionSeconds: number;
  audioChunkMs: number;
}

interface InterpretationResult {
  originalText: string;
  translatedText: string;
  translations?: Record<string, string>;
  isFinal: boolean;
  sourceLang: string;
  targetLang: string;
  targetLanguages?: string[];
  detectedLanguage?: string;
  latencyMs?: number;
}

interface HistoryItem {
  id: string;
  title: string;
  sourceLang: string;
  targetLang: string;
  targetLanguages?: string[];
  originalText: string;
  translatedText: string;
  translations?: Record<string, string>;
  durationSeconds: number;
  createdAt: string;
}

interface TranscriptHistoryEntry {
  id: string;
  original: string;
  translated: string;
  translations?: Record<string, string>;
  timestamp: string;
  sourceLang: string;
  targetLang: string;
  targetLanguages?: string[];
}

interface DubbingQueueItem {
  translationId: string;
  language: string;
  text: string;
  createdAt: number;
}

interface EnhancedAudioStream {
  stream: MediaStream;
  audioContext: AudioContext | null;
  getAudioLevel: () => number;
}

interface ProviderHealthStatus {
  status: 'healthy' | 'cooldown';
  cooldownUntil: number;
}

interface PartialTranscriptPayload {
  text: string;
  detectedLanguage?: string;
}

interface AudioChunkPayload {
  audio: Blob;
  sequence: number;
  audioLevel: number;
  chunkMs: number;
  capturedAt: number;
  mimeType: string;
}

interface GoogleCredentialResponse {
  credential?: string;
  select_by?: string;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: GoogleCredentialResponse) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, string | boolean | number>) => void;
          prompt: (momentListener?: (notification: {
            isNotDisplayed: () => boolean;
            isSkippedMoment: () => boolean;
            getNotDisplayedReason: () => string;
            getSkippedReason: () => string;
          }) => void) => void;
        };
      };
    };
  }
}

const API = import.meta.env.VITE_API_URL?.replace(/\/$/, "");
const SOCKET_URL = API;
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const TRANSCRIPT_HISTORY_STORAGE_KEY = "interp_history";
const MAX_TRANSCRIPT_HISTORY_ENTRIES = 40;
const MAX_TARGET_LANGUAGES = 3;
const LIVE_TEXT_WINDOW_CHARS = 900;
const LIVE_SEGMENT_WINDOW = 6;
const MAX_LIVE_SEGMENTS = 18;
const VISIBLE_HISTORY_ITEMS = 40;
const PARTIAL_SUBTITLE_THROTTLE_MS = 120;
const HISTORY_PERSIST_DEBOUNCE_MS = 250;
const MAX_DUBBING_QUEUE_ITEMS = 6;
const MAX_SPOKEN_DUBBING_KEYS = 180;
const DUBBING_UTTERANCE_TTL_MS = 45000;
const MIN_MEDIA_CHUNK_BYTES = 96;
const MIN_AUDIO_CHUNK_INTERVAL_MS = 45;
const MAX_QUEUED_AUDIO_CHUNKS = 12;
const CLIENT_HEARTBEAT_MS = 25000;
const DUBBING_QUEUE_SETTLE_MS = 180;
const STALE_TRANSLATION_STATE_MS = 45000;
const DEFAULT_TARGET_LANGUAGES = ["es"];
const SUPPORTED_LANGUAGE_CODES = new Set(["en", "fr", "es", "de", "it", "pt", "nl", "ar", "zh", "ja", "ko", "hi", "tr", "pl", "ru", "sw"]);
const FORBIDDEN_LANGUAGE_CODES = new Set(["rw", "rn", "lg", "lug", "luganda", "ug", "lg-ug"]);
const AUDIO_MIME_TYPES = ["audio/webm", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
const VIEWS: View[] = ["landing", "login", "signup", "dashboard", "pricing", "history", "help", "settings"];
const PROTECTED_VIEWS = new Set<View>(["dashboard", "history", "settings"]);

let googleIdentityScriptPromise: Promise<void> | null = null;
let googleIdentityInitializedClientId = "";
let googleCredentialCallback: ((response: GoogleCredentialResponse) => void) | null = null;

const loadGoogleIdentityScript = () => {
  if (!GOOGLE_CLIENT_ID || window.google?.accounts?.id) return Promise.resolve();
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;

  googleIdentityScriptPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>("script[data-google-identity]");

    const handleLoad = () => resolve();
    const handleError = () => reject(new Error("Unable to load Google Sign-In. Check your network and try again."));

    if (existingScript) {
      existingScript.addEventListener("load", handleLoad, { once: true });
      existingScript.addEventListener("error", handleError, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    document.head.appendChild(script);
  });

  return googleIdentityScriptPromise;
};

const initializeGoogleIdentityOnce = ({
  onCredential,
  onError
}: {
  onCredential: (credential: string) => void;
  onError: (message: string) => void;
}) => {
  if (!GOOGLE_CLIENT_ID || !window.google?.accounts?.id) return;

  googleCredentialCallback = (response) => {
    if (!response.credential) {
      onError("Google did not return a valid credential.");
      return;
    }

    onCredential(response.credential);
  };

  if (googleIdentityInitializedClientId === GOOGLE_CLIENT_ID) return;

  window.google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    auto_select: false,
    cancel_on_tap_outside: true,
    callback: (response) => googleCredentialCallback?.(response)
  });
  googleIdentityInitializedClientId = GOOGLE_CLIENT_ID;
};

const LANGUAGES: Language[] = [
  { code: "en", name: "English", region: "United States" },
  { code: "es", name: "Spanish", region: "Spain / LATAM" },
  { code: "fr", name: "French", region: "France" },
  { code: "de", name: "German", region: "Germany" },
  { code: "it", name: "Italian", region: "Italy" },
  { code: "pt", name: "Portuguese", region: "Brazil / Portugal" },
  { code: "nl", name: "Dutch", region: "Netherlands" },
  { code: "ar", name: "Arabic", region: "MENA" },
  { code: "zh", name: "Chinese", region: "China" },
  { code: "ja", name: "Japanese", region: "Japan" },
  { code: "ko", name: "Korean", region: "Korea" },
  { code: "hi", name: "Hindi", region: "India" },
  { code: "tr", name: "Turkish", region: "Turkiye" },
  { code: "pl", name: "Polish", region: "Poland" },
  { code: "ru", name: "Russian", region: "Global" },
  { code: "sw", name: "Swahili", region: "East Africa" }
];

const TOOL_ITEMS: Array<{ mode: Mode; label: string; icon: LucideIcon }> = [
  { mode: "transcribe", label: "Transcribe", icon: FileText },
  { mode: "translate", label: "Translate", icon: Languages },
  { mode: "dubbing", label: "Dubbing", icon: Volume2 }
];

const LANGUAGE_FLAGS: Record<string, string> = {
  en: "🇺🇸",
  es: "🇪🇸",
  fr: "🇫🇷",
  de: "🇩🇪",
  it: "🇮🇹",
  pt: "🇵🇹",
  nl: "🇳🇱",
  ar: "🇸🇦",
  zh: "🇨🇳",
  ja: "🇯🇵",
  ko: "🇰🇷",
  hi: "🇮🇳",
  tr: "🇹🇷",
  pl: "🇵🇱",
  ru: "🇷🇺",
  sw: "SW",
};

const SPEECH_SYNTHESIS_LANGS: Record<string, string> = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-PT",
  nl: "nl-NL",
  ar: "ar-SA",
  zh: "zh-CN",
  ja: "ja-JP",
  ko: "ko-KR",
  hi: "hi-IN",
  tr: "tr-TR",
  pl: "pl-PL",
  ru: "ru-RU",
  sw: "sw-KE",
};

const PRICING_PLANS = [
  {
    name: "Basic",
    monthly: 49,
    features: ["360 mins captions", "72 mins translation", "AI summary", "Transcript export"]
  },
  {
    name: "Premium",
    monthly: 99,
    highlighted: true,
    features: ["900 mins captions", "180 mins translation", "API access", "Priority support"]
  },
  {
    name: "Business",
    monthly: 199,
    features: ["1800 mins captions", "360 mins translation", "180 mins dubbing", "Session sharing", "Glossary"]
  },
  {
    name: "Business Plus",
    monthly: 449,
    features: ["4500 mins captions", "900 mins translation", "450 mins dubbing"]
  }
];

const normalizeTargetLanguages = (languages?: unknown, fallback = DEFAULT_TARGET_LANGUAGES[0]) => {
  const requestedLanguages = Array.isArray(languages) ? languages : languages ? [languages] : [fallback];
  const normalized: string[] = [];

  for (const language of requestedLanguages) {
    const code = normalizeLanguageCode(String(language || ""));
    if (!code || !SUPPORTED_LANGUAGE_CODES.has(code) || normalized.includes(code)) continue;
    normalized.push(code);
    if (normalized.length === MAX_TARGET_LANGUAGES) break;
  }

  if (normalized.length > 0) return normalized;
  const fallbackCode = normalizeLanguageCode(fallback);
  return fallbackCode && SUPPORTED_LANGUAGE_CODES.has(fallbackCode) ? [fallbackCode] : ["en"];
};

const normalizeLanguageCode = (language = "") => {
  const normalized = String(language || "").trim().toLowerCase().replace("_", "-");
  if (!normalized || normalized === "auto") return normalized;
  if (FORBIDDEN_LANGUAGE_CODES.has(normalized) || normalized.startsWith("rw") || normalized.startsWith("rn")) return "en";
  if (normalized.startsWith("sw")) return "sw";
  if (normalized.startsWith("zh")) return "zh";
  const baseCode = normalized.split("-")[0] || normalized;
  return SUPPORTED_LANGUAGE_CODES.has(baseCode) ? baseCode : "en";
};

const normalizeComparableText = (text = "") =>
  text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");

const normalizeLanguageDetectionText = (text = "") =>
  text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");

const languageTokens = (text = "") => normalizeLanguageDetectionText(text).match(/[\p{L}\p{N}']+/gu) || [];

const countLanguageMarkers = (text = "", markers: { phrases?: string[]; words?: string[] }) => {
  const normalized = normalizeLanguageDetectionText(text);
  const tokens = new Set(languageTokens(text));
  let score = 0;

  for (const phrase of markers.phrases || []) {
    const normalizedPhrase = normalizeLanguageDetectionText(phrase);
    if (normalizedPhrase && normalized.includes(normalizedPhrase)) score += 2;
  }

  for (const word of markers.words || []) {
    const normalizedWord = normalizeLanguageDetectionText(word);
    if (normalizedWord && tokens.has(normalizedWord)) score += 1;
  }

  return score;
};

const ENGLISH_MARKERS = {
  phrases: ["can you", "could you", "please give", "give me", "thank you", "how are you", "good morning", "no problem"],
  words: ["the", "and", "you", "your", "please", "give", "book", "hello", "thanks", "thank", "problem", "question", "answer", "friend", "okay", "need", "want", "have", "this", "that", "what", "when", "where", "why", "how", "can", "could", "would", "should"]
};

const TARGET_LANGUAGE_MARKERS: Record<string, { phrases?: string[]; words?: string[] }> = {
  es: {
    phrases: ["por favor", "muchas gracias", "buenos dias", "buenas tardes", "buenas noches", "me puedes", "puedes darme", "tu libro", "su libro", "de nada", "lo siento", "que tal"],
    words: ["el", "la", "los", "las", "un", "una", "de", "del", "que", "para", "por", "con", "sin", "como", "hola", "gracias", "favor", "vale", "claro", "bueno", "bien", "perdon", "adios", "listo", "puedes", "puede", "puedo", "dame", "darme", "libro", "libros", "necesito", "quiero", "tengo", "tienes", "tiene", "buenos", "buenas", "dias", "noches", "si", "aqui", "ahora", "usted", "tu", "mi", "su", "voy", "hablar", "escuchar", "traducir", "ayuda"]
  },
  sw: {
    phrases: ["asante sana", "unaweza kunipa", "kitabu chako", "habari", "tafadhali"],
    words: ["habari", "asante", "sawa", "rafiki", "tafadhali", "karibu", "jambo", "ndio", "ndiyo", "hapana", "sana", "unaweza", "kunipa", "kitabu", "chako", "nina", "kwa", "mimi", "wewe", "yeye", "sisi", "wao", "ni", "na", "ya", "za", "wa", "watu", "mtu", "leo", "kesho", "sasa", "hapa", "kazi", "fedha", "familia", "afya", "msaada", "wako", "ninahitaji"]
  }
};

const isSourceTaggedFallbackText = (text = "") => /^\[[a-z]{2,12}(?:-[a-z0-9]{2,12})?\]\s+/i.test(text.trim());

const isVisibleTranslationText = (text = "") =>
  Boolean(text.trim()) &&
  !isSourceTaggedFallbackText(text) &&
  !/\b(temporar(?:il)y unavailable|temporar(?:il)y failed|translation unavailable|provider failed|timed out|timeout)\b/i.test(text);

const hasSpanishOrthography = (text = "") => /[\u00e1\u00e9\u00ed\u00f3\u00fa\u00fc\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00dc\u00d1\u00bf\u00a1]/.test(text);
const hasChineseCharacters = (text = "") => /[\u3400-\u9fff\uf900-\ufaff]/.test(text);

const isTargetLanguageText = (text = "", targetLang = "") => {
  const target = normalizeLanguageCode(targetLang);
  if (!target || target === "auto" || target === "en") return true;

  const tokenCount = languageTokens(text).length;
  const englishScore = countLanguageMarkers(text, ENGLISH_MARKERS);

  if (target === "zh") return hasChineseCharacters(text);

  if (target === "es") {
    const spanishScore = countLanguageMarkers(text, TARGET_LANGUAGE_MARKERS.es);
    return hasSpanishOrthography(text) || spanishScore >= 2 || (spanishScore >= 1 && englishScore === 0 && tokenCount <= 3);
  }

  if (target === "sw") {
    const markerScore = countLanguageMarkers(text, TARGET_LANGUAGE_MARKERS[target] || {});
    return markerScore >= 2 || (markerScore >= 1 && englishScore === 0 && tokenCount <= 4);
  }

  if (tokenCount <= 4) return true;
  return englishScore < 6;
};

const isValidTranslationText = ({
  text = "",
  sourceText = "",
  targetLang = ""
}: {
  text?: string;
  sourceText?: string;
  targetLang?: string;
}) => {
  const cleanText = text.trim();
  if (!isVisibleTranslationText(cleanText)) return false;
  if (sourceText && normalizeComparableText(cleanText) === normalizeComparableText(sourceText)) return false;
  void targetLang;
  return true;
};

const normalizeTranslationMap = (
  translations?: unknown,
  fallbackText = "",
  fallbackLang = DEFAULT_TARGET_LANGUAGES[0],
  context: { sourceText?: string; targetLanguages?: string[] } = {}
) => {
  const normalized: Record<string, string> = {};

  if (translations && typeof translations === "object" && !Array.isArray(translations)) {
    for (const [language, translatedText] of Object.entries(translations as Record<string, unknown>)) {
      const text = String(translatedText || "").trim();
      if (language && isValidTranslationText({ text, sourceText: context.sourceText, targetLang: language })) normalized[language] = text;
    }
  }

  const cleanFallbackText = fallbackText.trim();
  if (
    Object.keys(normalized).length === 0 &&
    isValidTranslationText({ text: cleanFallbackText, sourceText: context.sourceText, targetLang: fallbackLang })
  ) {
    normalized[fallbackLang] = cleanFallbackText;
  }

  return normalized;
};

const orderedTranslationEntries = (translations: Record<string, string>, targetLanguages: string[]) => {
  const knownLanguages = normalizeTargetLanguages(targetLanguages);
  const orderedEntries = knownLanguages
    .map((language) => [language, translations[language]?.trim() || ""] as const)
    .filter(([language, translatedText]) => isValidTranslationText({ text: translatedText, targetLang: language }));

  for (const [language, translatedText] of Object.entries(translations)) {
    if (!knownLanguages.includes(language) && isValidTranslationText({ text: translatedText, targetLang: language })) orderedEntries.push([language, translatedText.trim()]);
  }

  return orderedEntries.slice(0, MAX_TARGET_LANGUAGES);
};

const formatTranslationsText = (translations: Record<string, string>, targetLanguages: string[]) =>
  orderedTranslationEntries(translations, targetLanguages)
    .map(([language, translatedText]) => `${language.toUpperCase()}: ${translatedText}`)
    .join("\n");

const translationStateLabel = (state: TranslationLifecycleState) => {
  if (state === "done" || state === "translated") return "done";
  if (state === "failed") return "failed";
  if (state === "stale") return "stale";
  if (state === "cancelled") return "cancelled";
  if (state === "retrying") return "retrying";
  if (state === "translating" || state === "processing") return "processing";
  if (state === "queued") return "queued";
  return "ready";
};

const translationStateClass = (state: TranslationLifecycleState) => {
  if (state === "done" || state === "translated") return "bg-emerald-500/10 text-emerald-300";
  if (state === "failed") return "bg-red-500/10 text-red-200";
  if (state === "stale" || state === "cancelled") return "bg-slate-800/80 text-slate-400";
  if (state === "retrying") return "bg-amber-500/10 text-amber-200";
  if (state === "translating" || state === "processing") return "bg-blue-500/10 text-blue-200";
  return "bg-slate-800/80 text-slate-500";
};

const coerceTranslationState = (value: unknown): TranslationLifecycleState | "" => {
  const state = String(value || "");
  if (state === "done") return "translated";
  if (state === "translating") return "processing";
  return ["ready", "queued", "processing", "retrying", "translated", "failed", "stale", "cancelled"].includes(state)
    ? (state as TranslationLifecycleState)
    : "";
};

const appendTextWindow = (current: string, next: string, maxChars = LIVE_TEXT_WINDOW_CHARS) => {
  const combined = [current, next].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return combined.length <= maxChars ? combined : combined.slice(-maxChars).replace(/^\S+\s*/, "").trim();
};

const languageFlag = (code: string) => LANGUAGE_FLAGS[code] || "🌐";
const compactSetToLimit = (set: Set<string>, maxItems: number) => {
  if (set.size <= maxItems) return set;
  return new Set(Array.from(set).slice(-maxItems));
};

const speechLanguage = (code: string) => SPEECH_SYNTHESIS_LANGS[code] || code;

const safeGetStorageItem = (storage: Storage | undefined, key: string) => {
  try {
    return storage?.getItem(key) || null;
  } catch {
    return null;
  }
};

const readStoredToken = () =>
  safeGetStorageItem(typeof sessionStorage !== "undefined" ? sessionStorage : undefined, "interp_shield_token") ||
  safeGetStorageItem(typeof localStorage !== "undefined" ? localStorage : undefined, "interp_shield_token");

const readStoredUser = () =>
  safeGetStorageItem(typeof sessionStorage !== "undefined" ? sessionStorage : undefined, "interp_shield_user") ||
  safeGetStorageItem(typeof localStorage !== "undefined" ? localStorage : undefined, "interp_shield_user");

const parseStoredUser = () => {
  const stored = readStoredUser();
  if (!stored) return null;

  try {
    return JSON.parse(stored) as AppUser;
  } catch {
    clearSessionStorage();
    return null;
  }
};

const readStoredTranscriptHistory = (): TranscriptHistoryEntry[] => {
  try {
    const stored = localStorage.getItem(TRANSCRIPT_HISTORY_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is TranscriptHistoryEntry => {
        return Boolean(entry && typeof entry === "object" && "original" in entry && "translated" in entry && "timestamp" in entry);
      })
      .map((entry) => {
        const targetLanguages = normalizeTargetLanguages(entry.targetLanguages, String(entry.targetLang || DEFAULT_TARGET_LANGUAGES[0]));
        const original = String(entry.original || "");
        const translations = normalizeTranslationMap(entry.translations, String(entry.translated || ""), targetLanguages[0], { sourceText: original });
        const storedTranslated = String(entry.translated || "");
        const translated = isValidTranslationText({ text: storedTranslated, sourceText: original, targetLang: targetLanguages[0] })
          ? storedTranslated
          : formatTranslationsText(translations, targetLanguages);

        return {
          id: entry.id || `${entry.timestamp}-${entry.original}`,
          original,
          translated,
          translations,
          timestamp: String(entry.timestamp || new Date().toISOString()),
          sourceLang: String(entry.sourceLang || "auto"),
          targetLang: String(entry.targetLang || targetLanguages[0]),
          targetLanguages
        };
      })
      .slice(-MAX_TRANSCRIPT_HISTORY_ENTRIES);
  } catch {
    return [];
  }
};

const getSupportedMimeType = () => {
  if (typeof window === "undefined" || !("MediaRecorder" in window)) return "";
  return AUDIO_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
};

const buildAudioConstraints = ({
  microphoneId,
  echoCancellation,
  noiseSuppression,
  autoGainControl
}: {
  microphoneId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}): MediaTrackConstraints => {
  const supportedConstraints = typeof navigator !== "undefined" && navigator.mediaDevices?.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
  const audio: MediaTrackConstraints = {};

  if (supportedConstraints.echoCancellation) audio.echoCancellation = echoCancellation;
  if (supportedConstraints.noiseSuppression) audio.noiseSuppression = noiseSuppression;
  if (supportedConstraints.autoGainControl) audio.autoGainControl = autoGainControl;
  if (supportedConstraints.sampleRate) audio.sampleRate = { ideal: 48000 };
  if (supportedConstraints.channelCount) audio.channelCount = { ideal: 1 };
  if (supportedConstraints.sampleSize) audio.sampleSize = { ideal: 16 };
  if (microphoneId !== "default") audio.deviceId = { exact: microphoneId };
  return audio;
};

const createAmplifiedAudioStream = (stream: MediaStream): EnhancedAudioStream => {
  const AudioContextCtor = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
  if (!AudioContextCtor) return { stream, audioContext: null, getAudioLevel: () => 0 };

  try {
    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const highPass = audioContext.createBiquadFilter();
    const lowPass = audioContext.createBiquadFilter();
    const gainNode = audioContext.createGain();
    const compressor = audioContext.createDynamicsCompressor();
    const analyser = audioContext.createAnalyser();
    const destination = audioContext.createMediaStreamDestination();
    let smoothedLevel = 0;

    highPass.type = "highpass";
    highPass.frequency.value = 85;
    highPass.Q.value = 0.7;

    lowPass.type = "lowpass";
    lowPass.frequency.value = 7600;
    lowPass.Q.value = 0.8;

    gainNode.gain.value = 1.35;
    compressor.threshold.value = -30;
    compressor.knee.value = 28;
    compressor.ratio.value = 4.5;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.22;
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    const timeDomainData = new Uint8Array(analyser.fftSize);

    source.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(compressor);
    compressor.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(destination);

    const getAudioLevel = () => {
      analyser.getByteTimeDomainData(timeDomainData);
      let sumSquares = 0;

      for (let index = 0; index < timeDomainData.length; index += 1) {
        const centeredSample = (timeDomainData[index] - 128) / 128;
        sumSquares += centeredSample * centeredSample;
      }

      const rms = Math.sqrt(sumSquares / timeDomainData.length);
      smoothedLevel = smoothedLevel * 0.75 + rms * 0.25;
      return smoothedLevel;
    };

    return { stream: destination.stream, audioContext, getAudioLevel };
  } catch {
    return { stream, audioContext: null, getAudioLevel: () => 0 };
  }
};

const formatTime = (seconds: number) => {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

const languageName = (code: string) => LANGUAGES.find((language) => language.code === code)?.name || code;

const formatHistoryTimestamp = (timestamp: string) => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const initialView = (): View => {
  const hashView = window.location.hash.replace("#", "") as View;
  return VIEWS.includes(hashView) ? hashView : "landing";
};

const requestApi = async <T,>(path: string, options: RequestInit = {}, token?: string | null): Promise<T> => {
  if (!API) {
    throw new Error("Backend API URL is missing. Set VITE_API_URL and restart the frontend.");
  }

  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
  } catch {
    throw new Error("Unable to reach InterpShield backend. Make sure it is running and VITE_API_URL is correct.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data as T;
};

const saveSession = (token: string, user: AppUser) => {
  localStorage.setItem("interp_shield_token", token);
  localStorage.setItem("interp_shield_user", JSON.stringify(user));
  sessionStorage.removeItem("interp_shield_token");
  sessionStorage.removeItem("interp_shield_user");
};

const clearSessionStorage = () => {
  try {
    sessionStorage.removeItem("interp_shield_token");
    sessionStorage.removeItem("interp_shield_user");
    localStorage.removeItem("interp_shield_token");
    localStorage.removeItem("interp_shield_user");
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
  }
};

const FlagUs = () => (
  <span className="relative inline-block h-5 w-7 overflow-hidden rounded-sm border border-white/20 bg-[repeating-linear-gradient(to_bottom,#b91c1c_0_2px,#fff_2px_4px)]">
    <span className="absolute left-0 top-0 h-3 w-3.5 bg-blue-800" />
  </span>
);

const GoogleIcon = ({ className = "h-5 w-5" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M21.6 12.23c0-.78-.07-1.53-.2-2.23H12v4.26h5.37a4.59 4.59 0 0 1-1.99 3.01v2.5h3.22c1.88-1.73 3-4.28 3-7.54Z" />
    <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.43l-3.22-2.5c-.9.6-2.04.95-3.39.95-2.6 0-4.8-1.76-5.59-4.12H3.08v2.58A9.99 9.99 0 0 0 12 22Z" />
    <path fill="#FBBC05" d="M6.41 13.9A6.01 6.01 0 0 1 6.1 12c0-.66.11-1.3.31-1.9V7.52H3.08A9.99 9.99 0 0 0 2 12c0 1.61.39 3.14 1.08 4.48l3.33-2.58Z" />
    <path fill="#EA4335" d="M12 5.98c1.47 0 2.78.5 3.82 1.49l2.86-2.86C16.95 3 14.69 2 12 2a9.99 9.99 0 0 0-8.92 5.52l3.33 2.58C7.2 7.74 9.4 5.98 12 5.98Z" />
  </svg>
);

const GlassPanel = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <section className={`rounded-2xl border border-gray-200 bg-white shadow-sm shadow-gray-200/70 backdrop-blur-xl ${className}`}>{children}</section>
);

const ToggleRow = ({
  label,
  description,
  value,
  onChange
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) => (
  <button type="button" onClick={() => onChange(!value)} className="flex w-full items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-left shadow-sm transition hover:bg-gray-50">
    <span>
      <span className="block text-sm font-bold text-gray-950">{label}</span>
      {description && <span className="mt-1 block text-xs leading-5 text-gray-500">{description}</span>}
    </span>
    <span className={`flex h-6 w-11 shrink-0 items-center rounded-full p-1 transition ${value ? "bg-blue-500" : "bg-gray-200"}`}>
      <span className={`h-4 w-4 rounded-full bg-white transition ${value ? "translate-x-5" : "translate-x-0"}`} />
    </span>
  </button>
);

const SelectControl = ({
  label,
  value,
  children,
  onChange
}: {
  label: string;
  value: string;
  children: React.ReactNode;
  onChange: (value: string) => void;
}) => (
  <label className="block">
    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">{label}</span>
    <span className="relative mt-2 block">
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full appearance-none rounded-xl border border-gray-200 bg-white px-3 py-3 pr-9 text-sm font-semibold text-gray-950 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100">
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
    </span>
  </label>
);

const TypingSubtitle = ({ text, muted = false, empty = "Waiting for speech..." }: { text: string; muted?: boolean; empty?: string }) => {
  const [visibleText, setVisibleText] = useState("");
  const visibleTextRef = useRef("");

  useEffect(() => {
    visibleTextRef.current = visibleText;
  }, [visibleText]);

  useEffect(() => {
    const cleanText = text.trim();
    if (!cleanText) {
      setVisibleText("");
      return;
    }

    const initialText = cleanText.startsWith(visibleTextRef.current) ? visibleTextRef.current : "";
    let index = initialText.length;
    const step = Math.max(1, Math.ceil((cleanText.length - initialText.length) / 80));
    setVisibleText(initialText);

    if (initialText === cleanText) return;

    const timer = window.setInterval(() => {
      index += step;
      setVisibleText(cleanText.slice(0, index));
      if (index >= cleanText.length) window.clearInterval(timer);
    }, 14);

    return () => window.clearInterval(timer);
  }, [text]);

  if (!text.trim()) return <span className="text-slate-600">{empty}</span>;

  return (
    <span className={`break-words ${muted ? "text-slate-400" : "text-white"}`}>
      {visibleText}
      {visibleText.length < text.trim().length && <span className="ml-1 inline-block h-5 w-1 animate-pulse rounded-full bg-blue-500 align-middle" />}
    </span>
  );
};

const LanguageSelect = ({
  label,
  value,
  disabled,
  onChange
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) => (
  <label className="flex min-w-0 flex-1 flex-col gap-1.5">
    <span className="text-xs font-bold uppercase tracking-widest text-slate-500">{label}</span>
    <span className="relative">
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full appearance-none rounded-lg border border-white/10 bg-slate-950/75 px-3 py-3 pr-9 text-sm font-semibold text-slate-100 outline-none transition focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/15 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {LANGUAGES.map((language) => (
          <option key={language.code} value={language.code}>
            {language.name} - {language.region}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
    </span>
  </label>
);

const TargetLanguageTriangle = ({
  sourceLang,
  targetLanguages,
  disabled,
  onSourceChange,
  onToggleTarget,
  onSwap
}: {
  sourceLang: string;
  targetLanguages: string[];
  disabled?: boolean;
  onSourceChange: (value: string) => void;
  onToggleTarget: (value: string) => void;
  onSwap: () => void;
}) => (
  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(220px,0.7fr)_1fr] lg:items-center">
    <LanguageSelect label="Speaker Language" value={sourceLang} disabled={disabled} onChange={onSourceChange} />

    <div className="rounded-lg border border-white/10 bg-slate-950/55 p-4">
      <div className="mx-auto max-w-sm">
        <div className="flex justify-center">
          <span className="inline-flex min-h-11 min-w-20 items-center justify-center gap-2 rounded-lg border border-slate-500/25 bg-slate-900 px-4 py-2 text-sm font-black text-white">
            <span aria-hidden="true">{languageFlag(sourceLang)}</span>
            {sourceLang.toUpperCase()}
          </span>
        </div>
        <div className={`mt-3 grid gap-2 ${targetLanguages.length === 1 ? "grid-cols-1 sm:px-16" : targetLanguages.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
          {targetLanguages.map((language) => (
            <button
              key={language}
              type="button"
              disabled={disabled}
              onClick={() => onToggleTarget(language)}
              className="inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg border border-blue-400/30 bg-blue-500/15 px-3 py-2 text-sm font-black text-blue-50 transition hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
              aria-pressed
            >
              <span aria-hidden="true">{languageFlag(language)}</span>
              {language.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
        {LANGUAGES.filter((language) => language.code !== sourceLang).map((language) => {
          const active = targetLanguages.includes(language.code);
          const locked = disabled || (!active && targetLanguages.length >= MAX_TARGET_LANGUAGES);

          return (
            <button
              key={language.code}
              type="button"
              disabled={locked}
              onClick={() => onToggleTarget(language.code)}
              className={`min-h-9 rounded-lg border px-2 py-1.5 text-xs font-black uppercase transition ${
                active
                  ? "border-blue-400/40 bg-blue-500 text-white"
                  : "border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:text-white disabled:opacity-35"
              }`}
              aria-pressed={active}
              title={language.name}
            >
              {language.code}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex justify-center border-t border-white/10 pt-3">
        <button onClick={onSwap} disabled={disabled} className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-slate-950/70 text-slate-400 hover:border-blue-500/40 hover:text-white disabled:opacity-40" aria-label="Swap primary language">
          <ArrowRightLeft className="h-5 w-5" />
        </button>
      </div>
    </div>
  </div>
);

const GoogleSignIn = ({
  disabled = false,
  loading,
  onCredential,
  onError
}: {
  disabled?: boolean;
  loading: boolean;
  onCredential: (credential: string) => void;
  onError: (message: string) => void;
}) => {
  const [loaded, setLoaded] = useState(false);
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const renderedRef = useRef(false);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    let cancelled = false;

    loadGoogleIdentityScript()
      .then(() => {
        if (!cancelled) setLoaded(true);
      })
      .catch((error) => {
        if (!cancelled) onError(error instanceof Error ? error.message : "Unable to load Google Sign-In. Check your network and try again.");
      });

    return () => {
      cancelled = true;
    };
  }, [onError]);

  useEffect(() => {
    if (!loaded || !GOOGLE_CLIENT_ID || !window.google) return;

    initializeGoogleIdentityOnce({ onCredential, onError });

    if (buttonRef.current && !renderedRef.current) {
      renderedRef.current = true;
      const width = Math.max(240, Math.min(360, buttonRef.current.clientWidth || 360));

      window.google.accounts.id.renderButton(buttonRef.current, {
        theme: "outline",
        size: "large",
        text: "continue_with",
        shape: "rectangular",
        logo_alignment: "left",
        width
      });
    }
  }, [loaded, onCredential, onError]);

  if (!GOOGLE_CLIENT_ID) {
    return (
      <button type="button" disabled={disabled || loading} onClick={() => onError("Google Sign-In is not configured for this deployment.")} className="flex w-full items-center justify-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-800 shadow-lg shadow-slate-950/20 transition hover:-translate-y-0.5 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60">
        <GoogleIcon />
        Continue with Google
      </button>
    );
  }

  return (
    <div className={`relative flex min-h-11 w-full items-center justify-center overflow-hidden rounded-lg bg-white shadow-lg shadow-slate-950/20 transition hover:-translate-y-0.5 ${disabled ? "pointer-events-none opacity-60" : ""}`}>
      {(!loaded || loading) && (
        <button type="button" disabled className="flex w-full items-center justify-center gap-3 px-4 py-3 text-sm font-black text-slate-800 disabled:cursor-wait">
          <GoogleIcon />
          {loading ? "Signing in..." : "Loading Google..."}
        </button>
      )}
      <div ref={buttonRef} className={`${loaded && !loading ? "flex" : "hidden"} w-full justify-center`} aria-label="Continue with Google" />
    </div>
  );
};

const AuthPage = ({
  mode,
  authProvider,
  error,
  onSubmit,
  onGoogle,
  onGoogleError,
  onNavigate
}: {
  mode: "login" | "signup";
  authProvider: AuthProvider | null;
  error: string | null;
  onSubmit: (payload: { name?: string; email: string; password: string }) => void;
  onGoogle: (credential: string) => void;
  onGoogleError: (message: string) => void;
  onNavigate: (view: View) => void;
}) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const isSignup = mode === "signup";
  const authBusy = Boolean(authProvider);
  const manualLoading = authProvider === "manual";
  const googleLoading = authProvider === "google";

  return (
    <main className="mx-auto grid min-h-[calc(100vh-76px)] w-full max-w-6xl grid-cols-1 gap-8 px-5 py-10 lg:grid-cols-[1fr_420px] lg:items-center">
      <div className="space-y-6">
        <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-bold uppercase tracking-widest text-blue-700">
          <Shield className="h-3.5 w-3.5" />
          Secure interpreter workspace
        </div>
        <div className="max-w-2xl">
          <h1 className="text-5xl font-black tracking-normal text-gray-950 md:text-7xl">Live Translate</h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-gray-500">Professional live captions, translation, and AI meeting tools in one workspace.</p>
        </div>
      </div>

      <GlassPanel className="p-6">
        <div className="mb-6">
          <p className="text-xl font-black text-gray-950">{isSignup ? "Create account" : "Welcome back"}</p>
          <p className="mt-1 text-sm text-gray-500">{isSignup ? "Start your InterpShield workspace." : "Login to open your dashboard."}</p>
        </div>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (authBusy) return;
            onSubmit({ name, email, password });
          }}
        >
          {isSignup && (
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} disabled={authBusy} className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-950 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100 disabled:cursor-wait disabled:opacity-70" placeholder="Isaac David" />
            </label>
          )}

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Email</span>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={authBusy} className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-950 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100 disabled:cursor-wait disabled:opacity-70" placeholder="you@example.com" required />
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={authBusy} className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-950 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100 disabled:cursor-wait disabled:opacity-70" placeholder="Minimum 6 characters" required />
          </label>

          {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

          <button disabled={authBusy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-black text-white transition hover:bg-blue-700 disabled:cursor-wait disabled:opacity-70">
            <KeyRound className="h-4 w-4" />
            {manualLoading ? "Please wait..." : isSignup ? "Sign up" : "Login"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs font-bold uppercase tracking-widest text-gray-400">
          <span className="h-px flex-1 bg-gray-200" />
          or
          <span className="h-px flex-1 bg-gray-200" />
        </div>

        <GoogleSignIn disabled={authBusy && !googleLoading} loading={googleLoading} onCredential={onGoogle} onError={onGoogleError} />

        <button type="button" disabled={authBusy} onClick={() => onNavigate(isSignup ? "login" : "signup")} className="mt-4 w-full rounded-lg border border-gray-200 px-4 py-3 text-sm font-bold text-gray-700 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60">
          {isSignup ? "Already have an account? Login" : "New here? Create an account"}
        </button>
      </GlassPanel>
    </main>
  );
};

export default function App() {
  const [view, setView] = useState<View>(initialView);
  const [user, setUser] = useState<AppUser | null>(() => parseStoredUser());
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [authProvider, setAuthProvider] = useState<AuthProvider | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminStats, setAdminStats] = useState<any>(null);
  const [providerHealth, setProviderHealth] = useState<Record<string, ProviderHealthStatus>>({
    gemini: { status: 'healthy', cooldownUntil: 0 },
    openai: { status: 'healthy', cooldownUntil: 0 }
  });
  const [latencyHistory, setLatencyHistory] = useState<Array<{provider: string, latency: number, time: number}>>([]);
  const [aiDegraded, setAiDegraded] = useState(false);
  const [savedHistory, setSavedHistory] = useState<HistoryItem[]>([]);
  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">("monthly");
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphonePermission, setMicrophonePermission] = useState<MicrophonePermissionState>("unknown");
  const [microphoneAvailable, setMicrophoneAvailable] = useState<boolean | null>(null);

  const [mode, setMode] = useState<Mode>("translate");
  const [sourceLang, setSourceLang] = useState("en");
  const [preferredProvider, setPreferredProvider] = useState<string>("auto");
  const [targetLanguages, setTargetLanguages] = useState<string[]>(DEFAULT_TARGET_LANGUAGES);
  const [privateMode, setPrivateMode] = useState(true);
  const [shareableMode, setShareableMode] = useState(false);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketReconnecting, setSocketReconnecting] = useState(false);
  const [originalSegments, setOriginalSegments] = useState<string[]>([]);
  const [translatedSegments, setTranslatedSegments] = useState<string[]>([]);
  const [history, setHistory] = useState<TranscriptHistoryEntry[]>(readStoredTranscriptHistory);
  const [liveText, setLiveText] = useState("");
  const [finalText, setFinalText] = useState("");
  const [finalTranslationText, setFinalTranslationText] = useState("");
  const [finalTranslations, setFinalTranslations] = useState<Record<string, string>>({});
  const [translationStatuses, setTranslationStatuses] = useState<Record<string, TranslationLifecycleState>>({});
  const [interimOriginal, setInterimOriginal] = useState("");
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);

  const [saveTranscript, setSaveTranscript] = useState(true);
  const [saveAudio, setSaveAudio] = useState(false);
  const [speakerDetection, setSpeakerDetection] = useState(true);
  const [autoStopOnSilence, setAutoStopOnSilence] = useState(true);
  const [silenceDuration, setSilenceDuration] = useState("30");
  const [censorProfanity, setCensorProfanity] = useState(false);
  const [microphoneId, setMicrophoneId] = useState("default");
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);
  const [summaryLength, setSummaryLength] = useState<SummaryLength>("standard");
  const [summaryLanguage, setSummaryLanguage] = useState("en");
  const [sceneDetection, setSceneDetection] = useState(false);
  const [actionItemExtraction, setActionItemExtraction] = useState(true);
  const [perSpeakerSummary, setPerSpeakerSummary] = useState(false);
  const [sentimentTracking, setSentimentTracking] = useState(false);
  const [keywordsExtraction, setKeywordsExtraction] = useState(true);

  const targetLang = targetLanguages[0] || DEFAULT_TARGET_LANGUAGES[0];

  const socketRef = useRef<Socket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingRef = useRef(false);
  const modeRef = useRef<Mode>("translate");
  const sourceLangRef = useRef(sourceLang);
  const targetLangRef = useRef(targetLang);
  const targetLanguagesRef = useRef(targetLanguages);
  const activeSessionPayloadRef = useRef<{
    sourceLang: string;
    targetLang: string;
    targetLanguages: string[];
    translate: boolean;
    twoWay: boolean;
    mimeType: string;
    roomId?: string;
    participantId?: string;
    audioProfile?: {
      noiseSuppression: boolean;
      echoCancellation: boolean;
      autoGainControl: boolean;
      webAudio: boolean;
    };
    preferredProvider?: string;
    userPlan?: Plan;
  } | null>(null);
  const shouldRestartSessionOnReconnectRef = useRef(false);
  const sequenceRef = useRef(0);
  const lastAudioChunkSentAtRef = useRef(0);
  const queuedAudioChunksRef = useRef<AudioChunkPayload[]>([]);
  const clientHeartbeatTimerRef = useRef<number | null>(null);
  const sessionStartedAtRef = useRef<number | null>(null);
  const lastInterimRef = useRef("");
  const lastFinalOriginalRef = useRef("");
  const lastFinalTranslationRef = useRef("");
  const lastCompletedTranslationRef = useRef("");
  const lastTranslationOriginalRef = useRef("");
  const finalTranslationsRef = useRef<Record<string, string>>({});
  const pendingFinalTranscriptRef = useRef<Pick<TranscriptHistoryEntry, "original" | "timestamp" | "sourceLang" | "targetLang" | "targetLanguages"> | null>(null);
  const activeTranslationIdRef = useRef("");
  const activeBackendSessionIdRef = useRef("");
  const activeBackendTranslationJobIdRef = useRef<string | number>("");
  const latestTranslationSequenceRef = useRef(0);
  const translationStatusUpdatedAtRef = useRef<Record<string, number>>({});
  const audioChunkMsRef = useRef(700);
  const interimTimerRef = useRef<number | null>(null);
  const subtitleThrottleTimerRef = useRef<number | null>(null);
  const lastSubtitleUpdateAtRef = useRef(0);
  const pendingPartialTranscriptRef = useRef<PartialTranscriptPayload | null>(null);
  const historyPersistTimerRef = useRef<number | null>(null);
  const historyEndRef = useRef<HTMLDivElement | null>(null);
  const dubbingQueueRef = useRef<DubbingQueueItem[]>([]);
  const dubbingSpeakingRef = useRef(false);
  const activeDubbingUtteranceIdRef = useRef("");
  const activeDubbingLanguageRef = useRef("");
  const lastDubbingTextRef = useRef("");
  const spokenDubbingKeysRef = useRef<Set<string>>(new Set());
  const historySignatureRef = useRef("");
  const persistedHistorySignaturesRef = useRef<Set<string>>(new Set());
  const tokenRef = useRef(token);
  const saveTranscriptRef = useRef(saveTranscript);
  const sessionSecondsRef = useRef(sessionSeconds);
  const sessionActionInFlightRef = useRef(false);
  const authRequestRef = useRef<AuthProvider | null>(null);

  const isAuthed = Boolean(user && token);
  const isPro = user?.plan === "pro";
  const isRecording = status === "connecting" || status === "listening";
  const latestOriginal = [...originalSegments.slice(-LIVE_SEGMENT_WINDOW), liveText].filter(Boolean).join(" ").trim() || finalText;
  const latestTranslation = formatTranslationsText(finalTranslations, targetLanguages);
  const isTranslationActive = mode !== "transcribe" && Object.values(translationStatuses).some((translationState) =>
    ["queued", "processing", "translating", "retrying"].includes(translationState)
  );
  const connectionState: SocketConnectionState =
    socketReconnecting || (!socketConnected && status === "listening")
      ? "reconnecting"
      : status === "connecting"
        ? "connecting"
        : isTranslationActive
          ? "translating"
          : status === "listening"
            ? "listening"
            : socketConnected
              ? "connected"
              : "ready";
  const displayTranslationEntries = targetLanguages.map((language) => {
    const translatedText = finalTranslations[language]?.trim() || "";
    const state: TranslationLifecycleState = translatedText ? "translated" : translationStatuses[language] || (isRecording && mode !== "transcribe" ? "queued" : "ready");
    return [language, translatedText, state] as const;
  });
  const visibleHistory = useMemo(() => history.slice(-VISIBLE_HISTORY_ITEMS), [history]);
  const maxSessionSeconds = config?.maxSessionSeconds || 3600;
  const statusLabel = status === "stopping"
    ? "Stopping"
    : status === "error"
      ? "Attention"
      : {
          ready: "Ready",
          connecting: "Connecting",
          connected: "Connected",
          listening: "Listening",
          translating: "Translating",
          reconnecting: "Reconnecting..."
        }[connectionState];

  useEffect(() => {
    finalTranslationsRef.current = finalTranslations;
  }, [finalTranslations]);

  const stopDubbingPlayback = useCallback((clearQueue = true) => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (clearQueue) dubbingQueueRef.current = [];
    dubbingSpeakingRef.current = false;
    activeDubbingUtteranceIdRef.current = "";
    activeDubbingLanguageRef.current = "";
  }, []);

  const playNextDubbingUtterance = useCallback(() => {
    if (!("speechSynthesis" in window) || dubbingSpeakingRef.current) return;

    const now = Date.now();
    dubbingQueueRef.current = dubbingQueueRef.current
      .filter((item) => now - item.createdAt <= DUBBING_UTTERANCE_TTL_MS)
      .slice(-MAX_DUBBING_QUEUE_ITEMS);

    if (!dubbingSpeakingRef.current && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
      window.speechSynthesis.cancel();
    }

    const nextUtterance = dubbingQueueRef.current.shift();
    if (!nextUtterance) return;

    const utterance = new SpeechSynthesisUtterance(nextUtterance.text);
    utterance.lang = speechLanguage(nextUtterance.language);
    utterance.rate = nextUtterance.text.length > 140 ? 0.94 : 0.98;
    utterance.pitch = 1;
    utterance.volume = 0.92;
    const utteranceId = `${nextUtterance.translationId}:${nextUtterance.language}:${nextUtterance.createdAt}`;
    activeDubbingUtteranceIdRef.current = utteranceId;
    activeDubbingLanguageRef.current = nextUtterance.language;
    dubbingSpeakingRef.current = true;

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (activeDubbingUtteranceIdRef.current === utteranceId) {
        activeDubbingUtteranceIdRef.current = "";
        activeDubbingLanguageRef.current = "";
      }
      dubbingSpeakingRef.current = false;
      const pauseMs = /[.!?]$/.test(nextUtterance.text.trim()) ? 220 : 360;
      window.setTimeout(() => playNextDubbingUtterance(), pauseMs);
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      finish();
    }
  }, []);

  const navigate = useCallback(
    (nextView: View) => {
      const guarded = PROTECTED_VIEWS.has(nextView);
      const resolvedView = guarded && !isAuthed ? "login" : nextView;
      setView(resolvedView);
      window.history.replaceState(null, "", `#${resolvedView}`);
      setSettingsOpen(false);
    },
    [isAuthed]
  );

  const fetchConfig = useCallback(async () => {
    try {
      const data = await requestApi<AppConfig>("/api/config");
      setConfig(data);
    } catch {
      setAlert("Unable to reach InterpShield. Please try again.");
    }
  }, []);

  const refreshMicrophones = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((device) => device.kind === "audioinput");
      setMicrophones(audioInputs);
      if (audioInputs.length > 0) setMicrophoneAvailable(true);
    } catch {
      setMicrophones([]);
    }
  }, []);

  const refreshMicrophonePermission = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophonePermission("unsupported");
      setMicrophoneAvailable(false);
      return;
    }

    if (!navigator.permissions?.query) {
      setMicrophonePermission("unknown");
      return;
    }

    try {
      const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
      const updatePermission = () => {
        setMicrophonePermission(permission.state === "granted" || permission.state === "denied" || permission.state === "prompt" ? permission.state : "unknown");
      };
      updatePermission();
      permission.onchange = updatePermission;
    } catch {
      setMicrophonePermission("unknown");
    }
  }, []);

  const applyUserSettings = (settings?: UserSettings) => {
    if (!settings) return;

    setSourceLang(normalizeLanguageCode(settings.preferredSourceLang || "en") || "en");
    setTargetLanguages(normalizeTargetLanguages(settings.preferredTargetLanguages, settings.preferredTargetLang || DEFAULT_TARGET_LANGUAGES[0]));
    setPreferredProvider(settings.preferredProvider || "auto");
    setPrivateMode(settings.privateMode ?? true);
    setShareableMode(Boolean(settings.shareableMode));
    setSaveTranscript(settings.saveTranscript ?? true);
    setSaveAudio(Boolean(settings.saveAudio));
    setSpeakerDetection(settings.speakerDetection ?? true);
    setAutoStopOnSilence(settings.autoStopOnSilence ?? true);
    setSilenceDuration(String(settings.silenceDuration || 30));
    setCensorProfanity(Boolean(settings.censorProfanity));
    setMicrophoneId(settings.microphoneId || "default");
    setEchoCancellation(settings.echoCancellation ?? true);
    setNoiseSuppression(settings.noiseSuppression ?? true);
    setAutoGainControl(settings.autoGainControl ?? true);
    setSummaryLength(settings.summaryLength || "standard");
    setSummaryLanguage(settings.summaryLanguage || "en");
    setSceneDetection(Boolean(settings.sceneDetection));
    setActionItemExtraction(settings.actionItemExtraction ?? true);
    setPerSpeakerSummary(Boolean(settings.perSpeakerSummary));
    setSentimentTracking(Boolean(settings.sentimentTracking));
    setKeywordsExtraction(settings.keywordsExtraction ?? true);
  };

  const refreshMe = useCallback(
    async (activeToken = token) => {
      if (!activeToken) return;

      try {
        const data = await requestApi<{ user: AppUser }>("/api/auth/me", {}, activeToken);
        setUser(data.user);
        localStorage.setItem("interp_shield_user", JSON.stringify(data.user));
        applyUserSettings(data.user.settings);
      } catch {
        clearSessionStorage();
        setToken(null);
        setUser(null);
        if (PROTECTED_VIEWS.has(view)) navigate("login");
      }
    },
    [navigate, token, view]
  );

  const updateSettings = async (settings: UserSettings) => {
    if (!token || !user) return;

    try {
      const data = await requestApi<{ user: AppUser }>("/api/user/settings", {
        method: "PATCH",
        body: JSON.stringify(settings)
      }, token);
      setUser(data.user);
      localStorage.setItem("interp_shield_user", JSON.stringify(data.user));
    } catch {
      setAlert("Unable to save settings.");
    }
  };

  useEffect(() => {
    void fetchConfig();
    void refreshMicrophones();
    void refreshMicrophonePermission();
  }, [fetchConfig, refreshMicrophones, refreshMicrophonePermission]);

  useEffect(() => {
    if (token) void refreshMe(token);
  }, []);

  useEffect(() => {
    if (PROTECTED_VIEWS.has(view) && !isAuthed) navigate("login");
  }, [isAuthed, navigate, view]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    saveTranscriptRef.current = saveTranscript;
  }, [saveTranscript]);

  useEffect(() => {
    sessionSecondsRef.current = sessionSeconds;
  }, [sessionSeconds]);

  useEffect(() => {
    sourceLangRef.current = sourceLang;
    targetLangRef.current = targetLang;
    targetLanguagesRef.current = targetLanguages;
  }, [sourceLang, targetLang, targetLanguages]);

  useEffect(() => {
    setTargetLanguages((current) => {
      if (!current.includes(sourceLang)) return current;
      const desiredCount = Math.min(MAX_TARGET_LANGUAGES, Math.max(1, current.length));
      const nextTargets: string[] = [];
      const candidates = [
        ...current.filter((language) => language !== sourceLang),
        ...DEFAULT_TARGET_LANGUAGES,
        ...LANGUAGES.map((language) => language.code)
      ];

      for (const candidate of candidates) {
        const code = normalizeLanguageCode(candidate);
        if (!code || code === "auto" || code === sourceLang || nextTargets.includes(code)) continue;
        nextTargets.push(code);
        if (nextTargets.length === desiredCount) break;
      }

      return nextTargets.length > 0 ? nextTargets : ["es"];
    });
  }, [sourceLang]);

  useEffect(() => {
    recordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    audioChunkMsRef.current = Math.max(500, Math.min(800, config?.audioChunkMs || 700));
  }, [config?.audioChunkMs]);

  useEffect(() => {
    if (historyPersistTimerRef.current) window.clearTimeout(historyPersistTimerRef.current);

    historyPersistTimerRef.current = window.setTimeout(() => {
      try {
        localStorage.setItem(TRANSCRIPT_HISTORY_STORAGE_KEY, JSON.stringify(history.slice(-MAX_TRANSCRIPT_HISTORY_ENTRIES)));
      } catch {
        setAlert("Local transcript storage is full. Export or clear older history soon.");
      } finally {
        historyPersistTimerRef.current = null;
      }
    }, HISTORY_PERSIST_DEBOUNCE_MS);

    return () => {
      if (historyPersistTimerRef.current) {
        window.clearTimeout(historyPersistTimerRef.current);
        historyPersistTimerRef.current = null;
      }
    };
  }, [history]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      historyEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [history.length]);

  const appendTranscriptHistory = useCallback((entry: Omit<TranscriptHistoryEntry, "id">) => {
    const original = entry.original.trim();
    const translated = entry.translated.trim();

    if (!original || !isValidTranslationText({ text: translated, sourceText: original, targetLang: entry.targetLang })) return;

    const persistenceSignature = `${entry.timestamp}|${original}|${translated}`;
    if (saveTranscriptRef.current && tokenRef.current && !persistedHistorySignaturesRef.current.has(persistenceSignature)) {
      persistedHistorySignaturesRef.current.add(persistenceSignature);
      void requestApi<{ item: HistoryItem }>("/api/user/history", {
        method: "POST",
        body: JSON.stringify({
          title: original.slice(0, 80) || "Live interpreter session",
          sourceLang: entry.sourceLang,
          targetLang: entry.targetLang,
          targetLanguages: entry.targetLanguages,
          originalText: original,
          translatedText: translated,
          translations: entry.translations,
          durationSeconds: sessionSecondsRef.current
        })
      }, tokenRef.current).catch(() => {
        persistedHistorySignaturesRef.current.delete(persistenceSignature);
      });
    }

    setHistory((current) => {
      const historySignature = `${entry.timestamp}|${original}|${translated}`;
      if (historySignature === historySignatureRef.current) return current;
      if (current.some((historyEntry) => `${historyEntry.timestamp}|${historyEntry.original}|${historyEntry.translated}` === historySignature)) return current;

      historySignatureRef.current = historySignature;
      const nextEntry: TranscriptHistoryEntry = {
        ...entry,
        id: `${entry.timestamp}-${current.length}-${Math.random().toString(36).slice(2, 8)}`,
        original,
        translated
      };

      return [...current, nextEntry].slice(-MAX_TRANSCRIPT_HISTORY_ENTRIES);
    });
  }, []);

  const updateTranslationStatuses = useCallback((updates: Record<string, TranslationLifecycleState | string>) => {
    const now = Date.now();
    const normalizedUpdates: Record<string, TranslationLifecycleState> = {};

    for (const [language, value] of Object.entries(updates)) {
      const status = coerceTranslationState(value);
      if (!status) continue;
      normalizedUpdates[language] = status;
      translationStatusUpdatedAtRef.current[language] = now;
    }

    if (Object.keys(normalizedUpdates).length === 0) return;
    setTranslationStatuses((current) => ({ ...current, ...normalizedUpdates }));
  }, []);

  const flushPendingPartialTranscript = useCallback(() => {
    const pending = pendingPartialTranscriptRef.current;
    if (!pending) return;

    pendingPartialTranscriptRef.current = null;
    lastSubtitleUpdateAtRef.current = Date.now();
    if (pending.detectedLanguage) setDetectedLanguage(pending.detectedLanguage);
    setLiveText(pending.text);

    if (interimTimerRef.current) window.clearTimeout(interimTimerRef.current);
    interimTimerRef.current = window.setTimeout(() => {
      setInterimOriginal(pending.text);
      interimTimerRef.current = null;
    }, 45);

    setStatus("listening");
  }, []);

  const schedulePartialTranscript = useCallback(
    (payload: PartialTranscriptPayload) => {
      pendingPartialTranscriptRef.current = payload;

      const elapsedMs = Date.now() - lastSubtitleUpdateAtRef.current;
      if (elapsedMs >= PARTIAL_SUBTITLE_THROTTLE_MS) {
        if (subtitleThrottleTimerRef.current) {
          window.clearTimeout(subtitleThrottleTimerRef.current);
          subtitleThrottleTimerRef.current = null;
        }
        flushPendingPartialTranscript();
        return;
      }

      if (subtitleThrottleTimerRef.current) return;
      subtitleThrottleTimerRef.current = window.setTimeout(() => {
        subtitleThrottleTimerRef.current = null;
        flushPendingPartialTranscript();
      }, PARTIAL_SUBTITLE_THROTTLE_MS - elapsedMs);
    },
    [flushPendingPartialTranscript]
  );

  const cleanupMedia = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    mediaRecorderRef.current = null;
    processedStreamRef.current?.getTracks().forEach((track) => track.stop());
    processedStreamRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    recordingRef.current = false;
    activeSessionPayloadRef.current = null;
    shouldRestartSessionOnReconnectRef.current = false;
    sessionStartedAtRef.current = null;
    lastAudioChunkSentAtRef.current = 0;
    stopDubbingPlayback(true);
    activeDubbingUtteranceIdRef.current = "";
    activeDubbingLanguageRef.current = "";
    lastTranslationOriginalRef.current = "";
    activeBackendSessionIdRef.current = "";
    activeBackendTranslationJobIdRef.current = "";
    latestTranslationSequenceRef.current = 0;
    queuedAudioChunksRef.current = [];
    if (subtitleThrottleTimerRef.current) {
      window.clearTimeout(subtitleThrottleTimerRef.current);
      subtitleThrottleTimerRef.current = null;
    }
    if (interimTimerRef.current) {
      window.clearTimeout(interimTimerRef.current);
      interimTimerRef.current = null;
    }
    pendingPartialTranscriptRef.current = null;
  }, [stopDubbingPlayback]);

  const emitAudioChunkPayload = useCallback((payload: AudioChunkPayload) => {
    const activeSocket = socketRef.current;

    if (activeSocket?.connected) {
      activeSocket.emit("audio_chunk", payload);
      return true;
    }

    queuedAudioChunksRef.current = [...queuedAudioChunksRef.current, payload].slice(-MAX_QUEUED_AUDIO_CHUNKS);
    return false;
  }, []);

  const flushQueuedAudioChunks = useCallback(() => {
    const activeSocket = socketRef.current;
    if (!activeSocket?.connected || queuedAudioChunksRef.current.length === 0) return;

    const queuedChunks = queuedAudioChunksRef.current.splice(0, queuedAudioChunksRef.current.length);
    for (const chunk of queuedChunks) {
      activeSocket.emit("audio_chunk", chunk);
    }
  }, []);

  const stopSession = useCallback(() => {
    if (status === "stopping") return;
    sessionActionInFlightRef.current = true;
    setStatus("stopping");
    cleanupMedia();
    socketRef.current?.emit("end_session");
    sessionActionInFlightRef.current = false;
    setStatus("idle");
  }, [cleanupMedia, status]);

  useEffect(() => {
    if (!token || !user) return undefined;

    if (!API) {
      setAlert("Backend API URL is missing. Set VITE_API_URL and restart the frontend.");
      return undefined;
    }

    if (!SOCKET_URL) {
      setAlert("Backend socket URL is missing. Set VITE_API_URL and restart the frontend.");
      return undefined;
    }

    const stopClientHeartbeat = () => {
      if (clientHeartbeatTimerRef.current) {
        window.clearInterval(clientHeartbeatTimerRef.current);
        clientHeartbeatTimerRef.current = null;
      }
    };

    const startClientHeartbeat = () => {
      stopClientHeartbeat();
      clientHeartbeatTimerRef.current = window.setInterval(() => {
        if (socketRef.current?.connected) {
          socketRef.current.emit("ping", { timestamp: Date.now() });
        }
      }, CLIENT_HEARTBEAT_MS);
    };

    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ["websocket", "polling"],
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.35,
      timeout: 20000,
      autoConnect: true
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketConnected(true);
      setSocketReconnecting(false);
      startClientHeartbeat();
      setAlert((current) => (current === "Unable to reach InterpShield. Please try again." ? null : current));
      setTranslationStatuses((current) => {
        const recovered: Record<string, TranslationLifecycleState> = {};
        for (const [language, state] of Object.entries(current)) {
          recovered[language] = state === "failed" || state === "stale" || state === "cancelled" ? "retrying" : state;
          translationStatusUpdatedAtRef.current[language] = Date.now();
        }
        return recovered;
      });

      if (shouldRestartSessionOnReconnectRef.current && activeSessionPayloadRef.current) {
        shouldRestartSessionOnReconnectRef.current = false;
        socket.emit("start_session", activeSessionPayloadRef.current);
      }
    });

    socket.on("disconnect", () => {
      stopClientHeartbeat();
      setSocketConnected(false);
      if (recordingRef.current) {
        setSocketReconnecting(true);
        shouldRestartSessionOnReconnectRef.current = true;
        setStatus("connecting");
        updateTranslationStatuses(
          Object.fromEntries(targetLanguagesRef.current.map((language) => [language, "retrying"]))
        );
      }
    });

    socket.on("connect_error", () => {
      setSocketConnected(false);
      setSocketReconnecting(recordingRef.current);
      if (recordingRef.current) setAlert("Unable to reach the live interpreter.");
    });

    const handleReconnectAttempt = () => {
      if (recordingRef.current) setSocketReconnecting(true);
    };
    const handleReconnect = () => {
      setSocketReconnecting(false);
    };
    const handleReconnectError = () => {
      if (recordingRef.current) setSocketReconnecting(true);
    };
    socket.io.on("reconnect_attempt", handleReconnectAttempt);
    socket.io.on("reconnect", handleReconnect);
    socket.io.on("reconnect_error", handleReconnectError);

    socket.on("server-config", (serverConfig: AppConfig) => setConfig(serverConfig));
    socket.on("session:heartbeat", () => {
      socket.emit("session:pong", { ts: Date.now() });
    });

    const markSessionReady = () => {
      sessionActionInFlightRef.current = false;
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === "inactive") {
        recorder.start(audioChunkMsRef.current);
        sessionStartedAtRef.current = Date.now();
        setSessionSeconds(0);
      }
      flushQueuedAudioChunks();
      setStatus("listening");
    };

    socket.on("session_ready", markSessionReady);
    socket.on("session:ready", markSessionReady);
    socket.on("session:closed", () => {
      sessionActionInFlightRef.current = false;
      setStatus((current) => (current === "stopping" ? "idle" : current));
    });
    socket.on("warning", ({ message }: { message?: string }) => {
      const warning = message || "";

      if (warning === "AI_PROVIDER_DEGRADED") {
        setAiDegraded(true);
        return;
      }

      if (warning.startsWith("PROVIDER_RECOVERED:")) {
        const names = warning.split(":")[1].split(",").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" and ");
        setAlert(`${names} service has recovered. High-quality AI processing restored.`);

        // Clear global degraded status if all are healthy
        setAiDegraded(false);
        return;
      }

      if (warning.includes("session limit") || warning.includes("silence")) setAlert(warning);
    });
    socket.on("provider_health", (health: Record<string, ProviderHealthStatus>) => {
      setProviderHealth(health);
    });
    const handleSessionError = ({ message }: { message?: string }) => {
      sessionActionInFlightRef.current = false;
      setStatus("error");
      setAlert(message || "Real-time processing failed.");
    };

    socket.on("session_error", handleSessionError);
    socket.on("app-error", handleSessionError);

    const trackLatency = (latency?: number, provider?: string) => {
      if (typeof latency === "number" && provider) {
        setLatencyHistory(prev => [...prev, { provider, latency, time: Date.now() }].slice(-100));
      }
    };

    socket.on("transcript_partial", ({ text, detectedLanguage }: { text?: string; detectedLanguage?: string }) => {
      const originalText = text?.trim() || "";
      if (!originalText || originalText === lastInterimRef.current) return;

      lastInterimRef.current = originalText;
      if (modeRef.current === "dubbing" && (window.speechSynthesis?.speaking || window.speechSynthesis?.pending)) {
        stopDubbingPlayback(true);
      }
      schedulePartialTranscript({ text: originalText, detectedLanguage });
    });

    socket.on("transcript_final", ({ text, sessionId, jobId, sequence, detectedLanguage, latencyMs, provider, sourceLang: eventSourceLang, targetLang: eventTargetLang, targetLanguages: eventTargetLanguages }: { text?: string; sessionId?: string; jobId?: string | number; sequence?: number; detectedLanguage?: string; latencyMs?: number; provider?: string; sourceLang?: string; targetLang?: string; targetLanguages?: string[] }) => {
      const originalText = text?.trim() || "";
      if (!originalText || originalText === lastFinalOriginalRef.current) return;
      if (detectedLanguage) setDetectedLanguage(detectedLanguage);
      if (typeof latencyMs === "number") setLastLatency(latencyMs);
      trackLatency(latencyMs, provider);

      lastInterimRef.current = "";
      lastFinalOriginalRef.current = originalText;
      if (modeRef.current === "dubbing") stopDubbingPlayback(true);
      pendingPartialTranscriptRef.current = null;
      if (subtitleThrottleTimerRef.current) {
        window.clearTimeout(subtitleThrottleTimerRef.current);
        subtitleThrottleTimerRef.current = null;
      }
      const pendingTargetLanguages = normalizeTargetLanguages(eventTargetLanguages, eventTargetLang || targetLangRef.current);
      const timestamp = new Date().toISOString();
      const lastTranslationOriginal = lastTranslationOriginalRef.current;
      const normalizedFinalOriginal = originalText.toLowerCase().replace(/\s+/g, " ").trim();
      const normalizedTranslationOriginal = lastTranslationOriginal.toLowerCase().replace(/\s+/g, " ").trim();
      const keepStreamingTranslation =
        normalizedTranslationOriginal &&
        (normalizedFinalOriginal.includes(normalizedTranslationOriginal) || normalizedTranslationOriginal.includes(normalizedFinalOriginal));
      const pendingEntry = {
        original: originalText,
        timestamp,
        sourceLang: detectedLanguage || eventSourceLang || sourceLangRef.current,
        targetLang: eventTargetLang || pendingTargetLanguages[0],
        targetLanguages: pendingTargetLanguages
      };
      pendingFinalTranscriptRef.current = pendingEntry;
      activeTranslationIdRef.current = `${timestamp}-${originalText.slice(0, 48)}`;
      if (sessionId && activeBackendSessionIdRef.current !== sessionId) {
        activeBackendSessionIdRef.current = sessionId;
        latestTranslationSequenceRef.current = 0;
      }
      activeBackendTranslationJobIdRef.current = jobId || "";
      const transcriptSequence = Number(sequence);
      if (Number.isFinite(transcriptSequence)) {
        latestTranslationSequenceRef.current = Math.max(latestTranslationSequenceRef.current, transcriptSequence);
      }
      updateTranslationStatuses(Object.fromEntries(pendingTargetLanguages.map((language) => [language, "queued"])));
      spokenDubbingKeysRef.current = compactSetToLimit(spokenDubbingKeysRef.current, MAX_SPOKEN_DUBBING_KEYS);
      dubbingQueueRef.current = dubbingQueueRef.current.slice(-Math.ceil(MAX_DUBBING_QUEUE_ITEMS / 2));
      setInterimOriginal("");
      setLiveText("");
      setFinalText((current) => appendTextWindow(current, originalText));
      setOriginalSegments((current) => [...current, originalText].slice(-MAX_LIVE_SEGMENTS));
      if (!keepStreamingTranslation) {
        finalTranslationsRef.current = {};
        lastFinalTranslationRef.current = "";
        setFinalTranslations({});
        setTranslationStatuses(Object.fromEntries(pendingTargetLanguages.map((language) => [language, "queued" as TranslationLifecycleState])));
      }
      lastCompletedTranslationRef.current = "";

      if (modeRef.current === "transcribe") {
        pendingFinalTranscriptRef.current = null;
      }

      setStatus("listening");
    });

    socket.on("result", (payload: any) => {
      if (payload.type === "admin_stats") {
        setAdminStats(payload.stats);
      }
    });

    const handleTranslationUpdate = ({ original, text, translations, statusByLanguage, failedLanguages, latencyMs, provider, sessionId, jobId, sequence, sourceLang: eventSourceLang, targetLang: eventTargetLang, targetLanguages: eventTargetLanguages, partial, complete, lang, status }: { original?: string; text?: string; translations?: Record<string, string>; statusByLanguage?: Record<string, string>; failedLanguages?: string[]; latencyMs?: number; provider?: string; sessionId?: string; jobId?: string | number; sequence?: number; sourceLang?: string; targetLang?: string; targetLanguages?: string[]; partial?: boolean; complete?: boolean; lang?: string; status?: string }) => {
      const pendingTranscript = pendingFinalTranscriptRef.current;
      const updateOriginal = original?.trim() || "";

      if (sessionId && activeBackendSessionIdRef.current && sessionId !== activeBackendSessionIdRef.current) {
        return;
      }
      if (sessionId && !activeBackendSessionIdRef.current) {
        activeBackendSessionIdRef.current = sessionId;
      }

      const incomingSequence = Number(sequence);
      if (Number.isFinite(incomingSequence) && incomingSequence < latestTranslationSequenceRef.current) {
        return;
      }

      if (pendingTranscript && updateOriginal && updateOriginal !== pendingTranscript.original) {
        return;
      }
      if (!pendingTranscript && updateOriginal && lastFinalOriginalRef.current && updateOriginal !== lastFinalOriginalRef.current) {
        return;
      }
      if (jobId && activeBackendTranslationJobIdRef.current && String(jobId) !== String(activeBackendTranslationJobIdRef.current)) {
        return;
      }

      const nextTargetLanguages = normalizeTargetLanguages(eventTargetLanguages || pendingTranscript?.targetLanguages || targetLanguagesRef.current, eventTargetLang || pendingTranscript?.targetLang || targetLangRef.current);
      const sourceText = updateOriginal || pendingTranscript?.original || lastFinalOriginalRef.current;
      const singleLanguage = lang || eventTargetLang || nextTargetLanguages[0];
      const nextTranslations = normalizeTranslationMap(translations, text || "", singleLanguage, { sourceText });
      const mergedTranslations: Record<string, string> = { ...finalTranslationsRef.current };

      for (const [language, translatedText] of Object.entries(nextTranslations)) {
        if (isValidTranslationText({ text: translatedText, sourceText, targetLang: language })) {
          mergedTranslations[language] = translatedText;
        }
      }

      const incomingTranslation = formatTranslationsText(nextTranslations, nextTargetLanguages);
      const mergedTranslation = formatTranslationsText(mergedTranslations, nextTargetLanguages);
      const mergedTranslationSignature = JSON.stringify(orderedTranslationEntries(mergedTranslations, nextTargetLanguages));
      const isComplete = complete !== false && !partial;
      const nextStatusUpdates: Record<string, TranslationLifecycleState> = {};
      for (const [language, status] of Object.entries(statusByLanguage || {})) {
        const normalizedStatus = coerceTranslationState(status);
        if (!normalizedStatus) continue;
        if (normalizedStatus === "failed" && (mergedTranslations[language] || nextTranslations[language])) continue;
        nextStatusUpdates[language] = normalizedStatus;
      }
      if (lang && status) {
        const normalizedStatus = coerceTranslationState(status);
        if (normalizedStatus && !(normalizedStatus === "failed" && (mergedTranslations[lang] || nextTranslations[lang]))) {
          nextStatusUpdates[lang] = normalizedStatus;
        }
      }
      for (const language of failedLanguages || []) {
        if (!mergedTranslations[language] && !nextTranslations[language]) {
          nextStatusUpdates[language] = "failed";
        }
      }
      for (const language of Object.keys(nextTranslations)) {
        nextStatusUpdates[language] = "translated";
      }
      const hasStatusUpdate = Object.keys(nextStatusUpdates).length > 0;
      const completedSignature = isComplete
        ? `${activeTranslationIdRef.current || pendingTranscript?.timestamp || "current"}|${mergedTranslationSignature}`
        : "";

      if (!incomingTranslation && !hasStatusUpdate) return;
      if (hasStatusUpdate) {
        updateTranslationStatuses(nextStatusUpdates);
        if (Number.isFinite(incomingSequence)) {
          latestTranslationSequenceRef.current = Math.max(latestTranslationSequenceRef.current, incomingSequence);
        }
        if (jobId) activeBackendTranslationJobIdRef.current = jobId;
      }
      if (!incomingTranslation || !mergedTranslation) return;
      if (!isComplete && mergedTranslationSignature === lastFinalTranslationRef.current && !hasStatusUpdate) return;
      if (isComplete && completedSignature === lastCompletedTranslationRef.current && mergedTranslationSignature === lastFinalTranslationRef.current) return;
      if (import.meta.env.DEV) {
        console.info("[FRONTEND_TRANSLATION_RECEIVED]", {
          provider,
          targetLanguages: nextTargetLanguages,
          partial: Boolean(partial),
          complete: isComplete,
          chars: mergedTranslation.length,
          sequence: Number.isFinite(incomingSequence) ? incomingSequence : undefined
        });
      }
      if (Number.isFinite(incomingSequence)) {
        latestTranslationSequenceRef.current = Math.max(latestTranslationSequenceRef.current, incomingSequence);
      }
      if (jobId) activeBackendTranslationJobIdRef.current = jobId;
      if (typeof latencyMs === "number") setLastLatency(latencyMs);
      trackLatency(latencyMs, provider);

      lastTranslationOriginalRef.current = sourceText;
      lastFinalTranslationRef.current = mergedTranslationSignature;
      finalTranslationsRef.current = mergedTranslations;
      setFinalTranslations(mergedTranslations);

      if (isComplete) {
        if (completedSignature === lastCompletedTranslationRef.current) return;
        lastCompletedTranslationRef.current = completedSignature;

        setFinalTranslationText((current) => [current, mergedTranslation].filter(Boolean).join("\n\n").trim().slice(-3500));
        setTranslatedSegments((current) => [...current, mergedTranslation].slice(-MAX_LIVE_SEGMENTS));
        appendTranscriptHistory({
          original: sourceText,
          translated: mergedTranslation,
          translations: mergedTranslations,
          timestamp: pendingTranscript?.timestamp || new Date().toISOString(),
          sourceLang: eventSourceLang || pendingTranscript?.sourceLang || sourceLangRef.current,
          targetLang: eventTargetLang || pendingTranscript?.targetLang || nextTargetLanguages[0],
          targetLanguages: nextTargetLanguages
        });
        pendingFinalTranscriptRef.current = null;
      }
    };

    socket.on("translation_update", handleTranslationUpdate);
    socket.on("translation_result", handleTranslationUpdate);
    socket.on("translated_text", handleTranslationUpdate);

    return () => {
      if (interimTimerRef.current) {
        window.clearTimeout(interimTimerRef.current);
        interimTimerRef.current = null;
      }
      if (subtitleThrottleTimerRef.current) {
        window.clearTimeout(subtitleThrottleTimerRef.current);
        subtitleThrottleTimerRef.current = null;
      }
      pendingPartialTranscriptRef.current = null;
      socket.disconnect();
      stopClientHeartbeat();
      socket.io.off("reconnect_attempt", handleReconnectAttempt);
      socket.io.off("reconnect", handleReconnect);
      socket.io.off("reconnect_error", handleReconnectError);
      socketRef.current = null;
      setSocketConnected(false);
      setSocketReconnecting(false);
    };
  }, [token, user, stopDubbingPlayback, updateTranslationStatuses, flushQueuedAudioChunks]);

  useEffect(() => {
    const reconnectSocket = () => {
      if (socketRef.current && !socketRef.current.connected) socketRef.current.connect();
    };

    window.addEventListener("online", reconnectSocket);
    return () => window.removeEventListener("online", reconnectSocket);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!recordingRef.current || !sessionStartedAtRef.current) return;

      const elapsed = Math.floor((Date.now() - sessionStartedAtRef.current) / 1000);
      setSessionSeconds(elapsed);

      if (elapsed >= maxSessionSeconds) stopSession();
    }, 500);

    return () => window.clearInterval(timer);
  }, [maxSessionSeconds, stopSession]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const staleUpdates: Record<string, TranslationLifecycleState> = {};

      for (const [language, state] of Object.entries(translationStatuses)) {
        if (!["queued", "translating", "processing", "retrying"].includes(state)) continue;
        const updatedAt = translationStatusUpdatedAtRef.current[language] || 0;
        if (updatedAt && now - updatedAt > STALE_TRANSLATION_STATE_MS) staleUpdates[language] = "retrying";
      }

      if (Object.keys(staleUpdates).length > 0) updateTranslationStatuses(staleUpdates);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [translationStatuses, updateTranslationStatuses]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;

    if (mode !== "dubbing") {
      stopDubbingPlayback(true);
      lastDubbingTextRef.current = "";
      spokenDubbingKeysRef.current.clear();
      return;
    }

    const entries = orderedTranslationEntries(finalTranslations, targetLanguages).filter(([, translatedText]) => isVisibleTranslationText(translatedText));
    if (entries.length === 0) return;

    const translationId = activeTranslationIdRef.current || "current";
    if (!lastCompletedTranslationRef.current.startsWith(`${translationId}|`)) return;
    const now = Date.now();
    dubbingQueueRef.current = dubbingQueueRef.current
      .filter((item) => item.translationId === translationId || now - item.createdAt <= DUBBING_UTTERANCE_TTL_MS)
      .slice(-MAX_DUBBING_QUEUE_ITEMS);

    for (const [language, translatedText] of entries) {
      const dubbingKey = `${translationId}:${language}:${translatedText}`;
      if (spokenDubbingKeysRef.current.has(dubbingKey)) continue;
      if (dubbingQueueRef.current.some((item) => item.language === language && item.text === translatedText)) continue;
      spokenDubbingKeysRef.current.add(dubbingKey);
      dubbingQueueRef.current.push({ translationId, language, text: translatedText, createdAt: now });
    }

    spokenDubbingKeysRef.current = compactSetToLimit(spokenDubbingKeysRef.current, MAX_SPOKEN_DUBBING_KEYS);
    dubbingQueueRef.current = dubbingQueueRef.current.slice(-MAX_DUBBING_QUEUE_ITEMS);
    const nextTextSignature = entries.map(([language, translatedText]) => `${language}:${translatedText}`).join("|");
    if (nextTextSignature === lastDubbingTextRef.current) return;
    lastDubbingTextRef.current = nextTextSignature;
    window.setTimeout(() => playNextDubbingUtterance(), DUBBING_QUEUE_SETTLE_MS);
  }, [mode, finalTranslations, targetLanguages, playNextDubbingUtterance, stopDubbingPlayback]);

  const applyAuthSession = (session: { token: string; user: AppUser }) => {
    setToken(session.token);
    setUser(session.user);
    saveSession(session.token, session.user);
    applyUserSettings(session.user.settings);
    setAuthError(null);
    navigate("dashboard");
  };

  const handleAuthSubmit = async (payload: { name?: string; email: string; password: string }) => {
    if (authRequestRef.current) return;

    authRequestRef.current = "manual";
    setAuthProvider("manual");
    setAuthError(null);

    try {
      const body = {
        name: payload.name?.trim(),
        email: payload.email.trim(),
        password: payload.password
      };
      const path = view === "signup" ? "/api/auth/signup" : "/api/auth/login";
      const session = await requestApi<{ token: string; user: AppUser }>(path, {
        method: "POST",
        body: JSON.stringify(body)
      });
      applyAuthSession(session);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      authRequestRef.current = null;
      setAuthProvider(null);
    }
  };

  const handleGoogleLogin = useCallback(async (credential: string) => {
    if (authRequestRef.current) return;

    authRequestRef.current = "google";
    setAuthProvider("google");
    setAuthError(null);

    try {
      const session = await requestApi<{ token: string; user: AppUser }>("/api/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential })
      });
      applyAuthSession(session);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Google sign-in failed.");
    } finally {
      authRequestRef.current = null;
      setAuthProvider(null);
    }
  }, []);

  const logout = async () => {
    if (token) await requestApi("/api/auth/logout", { method: "POST" }, token).catch(() => undefined);

    clearSessionStorage();
    setToken(null);
    setUser(null);
    setStatus("idle");
    navigate("landing");
  };

  const upgradePlan = async () => {
    if (!token) {
      navigate("login");
      return;
    }

    try {
      const data = await requestApi<{ user: AppUser }>("/api/user/upgrade", { method: "POST" }, token);
      setUser(data.user);
      localStorage.setItem("interp_shield_user", JSON.stringify(data.user));
      setAlert("Plan updated. Pro features are active.");
      navigate("dashboard");
    } catch (error) {
      setAlert(error instanceof Error ? error.message : "Upgrade failed.");
    }
  };

  const fetchHistory = useCallback(async () => {
    if (!token) return;

    try {
      const data = await requestApi<{ history: HistoryItem[] }>("/api/user/history", {}, token);
      setSavedHistory(data.history);
    } catch {
      setAlert("Unable to load history.");
    }
  }, [token]);

  useEffect(() => {
    if (view === "history") void fetchHistory();
  }, [fetchHistory, view]);

  const startSession = useCallback(async () => {
    if (sessionActionInFlightRef.current || recordingRef.current) return;

    if (!isAuthed) {
      navigate("login");
      return;
    }

    sessionActionInFlightRef.current = true;
    setAlert(null);
    setStatus("connecting");
    setDetectedLanguage(null);
    setChunkCount(0);
    setLastLatency(null);
    setTranslationStatuses({});
    translationStatusUpdatedAtRef.current = {};
    sequenceRef.current = 0;
    lastInterimRef.current = "";
    lastFinalOriginalRef.current = "";
    lastFinalTranslationRef.current = "";
    lastCompletedTranslationRef.current = "";
    pendingFinalTranscriptRef.current = null;
    activeTranslationIdRef.current = "";
    activeBackendSessionIdRef.current = "";
    activeBackendTranslationJobIdRef.current = "";
    latestTranslationSequenceRef.current = 0;
    finalTranslationsRef.current = {};
    spokenDubbingKeysRef.current.clear();
    lastDubbingTextRef.current = "";
    stopDubbingPlayback(true);
    pendingPartialTranscriptRef.current = null;
    if (subtitleThrottleTimerRef.current) {
      window.clearTimeout(subtitleThrottleTimerRef.current);
      subtitleThrottleTimerRef.current = null;
    }
    if (interimTimerRef.current) {
      window.clearTimeout(interimTimerRef.current);
      interimTimerRef.current = null;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      sessionActionInFlightRef.current = false;
      setStatus("error");
      setMicrophonePermission("unsupported");
      setMicrophoneAvailable(false);
      setAlert("Microphone access is not supported in this browser.");
      return;
    }

    if (!("MediaRecorder" in window)) {
      sessionActionInFlightRef.current = false;
      setStatus("error");
      setAlert("Microphone recording is not supported in this browser.");
      return;
    }

    try {
      if (!socketRef.current?.connected) {
        socketRef.current?.connect();
        await new Promise<void>((resolve, reject) => {
          const activeSocket = socketRef.current;
          if (!activeSocket) {
            reject(new Error("Live socket is unavailable."));
            return;
          }
          if (activeSocket.connected) {
            resolve();
            return;
          }

          const timer = window.setTimeout(() => {
            activeSocket.off("connect", handleConnect);
            activeSocket.off("connect_error", handleError);
            reject(new Error("Live socket connection timed out."));
          }, 30000);
          const handleConnect = () => {
            window.clearTimeout(timer);
            activeSocket.off("connect_error", handleError);
            resolve();
          };
          const handleError = (error: Error) => {
            window.clearTimeout(timer);
            activeSocket.off("connect", handleConnect);
            reject(error);
          };
          activeSocket.once("connect", handleConnect);
          activeSocket.once("connect_error", handleError);
        });
      }

      const audio = buildAudioConstraints({
        microphoneId,
        echoCancellation,
        noiseSuppression,
        autoGainControl
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      streamRef.current = stream;
      setMicrophonePermission("granted");
      setMicrophoneAvailable(true);
      void refreshMicrophones();

      const enhancedAudio = createAmplifiedAudioStream(stream);
      processedStreamRef.current = enhancedAudio.stream === stream ? null : enhancedAudio.stream;
      audioContextRef.current = enhancedAudio.audioContext;
      if (enhancedAudio.audioContext?.state === "suspended") {
        await enhancedAudio.audioContext.resume().catch(() => undefined);
      }

      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(enhancedAudio.stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 128_000
      });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size < MIN_MEDIA_CHUNK_BYTES) return;

        sequenceRef.current += 1;
        const capturedAt = Date.now();
        const audioLevel = enhancedAudio.getAudioLevel();
        const elapsedSinceLastChunk = capturedAt - lastAudioChunkSentAtRef.current;

        if (elapsedSinceLastChunk < MIN_AUDIO_CHUNK_INTERVAL_MS && audioLevel < 0.002) return;

        lastAudioChunkSentAtRef.current = capturedAt;
        emitAudioChunkPayload({
          audio: event.data,
          sequence: sequenceRef.current,
          audioLevel,
          chunkMs: audioChunkMsRef.current,
          capturedAt,
          mimeType: mimeType || "audio/webm"
        });
        if (sequenceRef.current % 3 === 0) setChunkCount(sequenceRef.current);
      };

      recorder.onerror = () => {
        setStatus("error");
        setAlert("Microphone recording stopped unexpectedly.");
        cleanupMedia();
      };

      const activeSourceLang = normalizeLanguageCode(sourceLang) || "en";
      const activeTargetLanguages = normalizeTargetLanguages(targetLanguages, targetLang);
      const sessionPayload = {
        sourceLang: activeSourceLang,
        targetLang: activeTargetLanguages[0],
        targetLanguages: activeTargetLanguages,
        translate: modeRef.current !== "transcribe",
        twoWay: activeTargetLanguages.length > 1,
        mimeType: mimeType || "audio/webm",
        roomId: shareableMode ? `live:${user?.id || "guest"}` : undefined,
        participantId: user?.id || socketRef.current?.id || "browser",
        audioProfile: {
          noiseSuppression,
          echoCancellation,
          autoGainControl,
          webAudio: Boolean(enhancedAudio.audioContext)
        },
        preferredProvider,
        userPlan: user?.plan || "free"
      };
      activeSessionPayloadRef.current = sessionPayload;
      shouldRestartSessionOnReconnectRef.current = false;

      socketRef.current?.timeout(30000).emit(
        "start_session",
        sessionPayload,
        (timeoutError: Error | null, response?: { ok?: boolean; error?: string }) => {
          if (timeoutError || response?.error) {
            sessionActionInFlightRef.current = false;
            cleanupMedia();
            setStatus("error");
            setAlert(response?.error || "Unable to reach the live interpreter.");
          }
        }
      );
    } catch (error) {
      sessionActionInFlightRef.current = false;
      cleanupMedia();
      setStatus("error");

      if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")) {
        setMicrophoneAvailable(false);
        setAlert("No microphone input was found.");
        return;
      }

      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
        setMicrophonePermission("denied");
        setAlert("Microphone permission denied. Allow microphone access to start live translation.");
        return;
      }

      setAlert("Unable to start microphone. Check browser audio permissions and try again.");
    }
  }, [autoGainControl, cleanupMedia, echoCancellation, emitAudioChunkPayload, isAuthed, microphoneId, navigate, noiseSuppression, preferredProvider, refreshMicrophones, shareableMode, sourceLang, stopDubbingPlayback, targetLang, targetLanguages, user?.id, user?.plan]);

  const selectMode = (nextMode: Mode) => {
    if (isRecording) return;
    setMode(nextMode);
  };

  const toggleTargetLanguage = (language: string) => {
    if (isRecording || language === sourceLang) return;

    setTargetLanguages((current) => {
      if (current.includes(language)) {
        return current.length > 1 ? current.filter((targetLanguage) => targetLanguage !== language) : current;
      }

      if (current.length >= MAX_TARGET_LANGUAGES) return current;
      return normalizeTargetLanguages([...current, language], targetLang);
    });
  };

  const swapLanguages = () => {
    if (isRecording) return;
    setSourceLang(targetLang);
    setTargetLanguages((current) => normalizeTargetLanguages([sourceLang, ...current.filter((language) => language !== targetLang && language !== sourceLang)], sourceLang));
  };

  const clearLiveSession = () => {
    setOriginalSegments([]);
    setTranslatedSegments([]);
    setLiveText("");
    setFinalText("");
    setFinalTranslationText("");
    setFinalTranslations({});
    setTranslationStatuses({});
    translationStatusUpdatedAtRef.current = {};
    setInterimOriginal("");
    setSessionSeconds(0);
    setChunkCount(0);
    setLastLatency(null);
    setDetectedLanguage(null);
    lastInterimRef.current = "";
    lastFinalOriginalRef.current = "";
    lastFinalTranslationRef.current = "";
    lastCompletedTranslationRef.current = "";
    lastTranslationOriginalRef.current = "";
    activeTranslationIdRef.current = "";
    activeBackendSessionIdRef.current = "";
    activeBackendTranslationJobIdRef.current = "";
    latestTranslationSequenceRef.current = 0;
    finalTranslationsRef.current = {};
    pendingFinalTranscriptRef.current = null;
    spokenDubbingKeysRef.current.clear();
    lastDubbingTextRef.current = "";
    stopDubbingPlayback(true);
    pendingPartialTranscriptRef.current = null;
    if (subtitleThrottleTimerRef.current) {
      window.clearTimeout(subtitleThrottleTimerRef.current);
      subtitleThrottleTimerRef.current = null;
    }
    if (interimTimerRef.current) {
      window.clearTimeout(interimTimerRef.current);
      interimTimerRef.current = null;
    }
  };

  const saveHistoryAsPdf = () => {
    const stableHistory = history.filter((entry) => entry.original.trim() && isVisibleTranslationText(entry.translated));

    if (stableHistory.length === 0) {
      setAlert("No transcript history to export.");
      return;
    }

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `interp-history-${timestamp}.pdf`;
      const formattedText = stableHistory
        .map((entry) => {
          const sourceLabel = entry.sourceLang.toUpperCase();
          const translations = normalizeTranslationMap(entry.translations, entry.translated, entry.targetLang, { sourceText: entry.original });
          const translationLines = orderedTranslationEntries(translations, entry.targetLanguages || [entry.targetLang]).map(([language, translatedText]) => `${language.toUpperCase()}: ${translatedText}`);

          return [
            `[${formatHistoryTimestamp(entry.timestamp)}]`,
            `${sourceLabel}: ${entry.original}`,
            ...translationLines
          ].join("\n");
        })
        .join("\n\n");
      const blob = new Blob([formattedText], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch {
      setAlert("Unable to export PDF right now. Your transcript history is still saved.");
    }
  };

  const persistSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    const settings = { [key]: value } as UserSettings;
    void updateSettings(settings);
  };

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const getProviderStatusLabel = (provider: string, baseLabel: string) => {
    const health = providerHealth[provider];
    if (!health || health.status === 'healthy') return `${baseLabel} ready`;

    const remainingSec = Math.ceil((health.cooldownUntil - now) / 1000);
    return remainingSec > 0
      ? `${baseLabel} cooling down (${remainingSec}s)`
      : `${baseLabel} ready`;
  };

  const LatencyGraph = ({ data }: { data: typeof latencyHistory }) => {
    const providers = ["gemini", "openai"];
    return (
      <div className="mt-4 space-y-4">
        {providers.map(p => {
          const pData = data.filter(d => d.provider === p).slice(-24);
          if (pData.length === 0) return null;
          const maxLat = Math.max(...pData.map(d => d.latency), 1200);
          return (
            <div key={p} className="space-y-1.5">
               <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-gray-500">
                 <span className="flex items-center gap-1.5"><div className="h-1.5 w-1.5 rounded-full bg-blue-500" />{p} performance</span>
                 <span className="text-gray-500">{pData[pData.length - 1].latency}ms</span>
               </div>
               <div className="flex h-12 w-full items-end gap-0.5 rounded-lg border border-gray-100 bg-gray-50 p-1">
                  {pData.map((d, i) => (
                    <div key={i} className="flex-1 rounded-t-[1px] bg-blue-500/30 transition-all hover:bg-blue-400"
                         style={{ height: `${Math.max(4, (d.latency / maxLat) * 100)}%` }}
                         title={`${d.latency}ms`} />
                  ))}
               </div>
            </div>
          );
        })}
      </div>
    );
  };

  const handleNavbarNavigate = (target: "dashboard" | "help" | "pricing" | "settings" | "login") => {
    if (target === "dashboard") {
      navigate(isAuthed ? "dashboard" : "landing");
      return;
    }

    if (target === "settings" && !isAuthed) {
      navigate("login");
      return;
    }

    navigate(target);
  };

  const renderTopNav = () => (
    <Navbar user={user} isAuthed={isAuthed} onNavigate={handleNavbarNavigate} onLogout={() => void logout()} />
  );

  const renderLanding = () => (
    <main className="mx-auto w-full max-w-5xl space-y-8 px-4 pb-16 sm:px-6">
      <HeroSection />
      <div className="space-y-6">
        <ModeTabs activeMode="private" onChange={() => undefined} />
        <ToolTabs activeTool="translate" onChange={() => undefined} />
        <LanguageSelector
          languages={LANGUAGES}
          sourceLanguage="auto"
          targetLanguage="es"
          onSourceChange={() => undefined}
          onTargetChange={() => undefined}
          onSwap={() => undefined}
        />
        <TranslationOptions
          twoWayEnabled={false}
          threeWayEnabled={false}
          onTwoWayToggle={() => undefined}
          onThreeWayToggle={() => undefined}
        />
      </div>
      <TranslationPanel
        mode="translate"
        status="idle"
        statusLabel="Ready"
        sourceLabel="Auto Detect"
        targetLabel="Spanish"
        originalText=""
        translations={[{ language: "es", label: "Spanish (ES)", text: "", state: "ready" }]}
        isConnected={false}
        isRecording={false}
        sessionSeconds={0}
        chunkCount={0}
        lastLatency={null}
        historyCount={0}
        onMicClick={() => navigate("signup")}
        onClear={() => undefined}
        onSave={() => undefined}
      />
    </main>
  );

  const renderDashboard = () => {
    const privacyMode: PrivacyMode = shareableMode ? "shareable" : "private";
    const targetCount = Math.min(MAX_TARGET_LANGUAGES, Math.max(1, targetLanguages.length));
    const twoWayEnabled = targetCount === 2;
    const threeWayEnabled = targetCount === 3;
    const sourceLabel = sourceLang === "auto"
      ? detectedLanguage ? languageName(detectedLanguage) : "Auto Detect"
      : languageName(detectedLanguage || sourceLang);
    const targetLabel = targetLanguages.map(languageName).join(", ");
    const microphoneNotice =
      !alert && microphonePermission === "denied"
        ? "Microphone permission denied. Allow microphone access to start live translation."
        : !alert && microphonePermission === "unsupported"
          ? "Microphone access is not supported in this browser."
          : !alert && microphoneAvailable === false
            ? "No microphone input was found."
            : null;
    const translationEntries: TranscriptTranslationEntry[] = displayTranslationEntries.map(([language, translatedText, translationState]) => ({
      language,
      label: `${languageName(language)} (${language.toUpperCase()})`,
      text: translatedText,
      state: translationStateLabel(translationState)
    }));

    const buildTargetList = (primaryLanguage: string, desiredCount = targetCount, sourceLanguage = sourceLang, existingTargets = targetLanguages) => {
      const activeSource = normalizeLanguageCode(sourceLanguage);
      const primary = normalizeLanguageCode(primaryLanguage) || DEFAULT_TARGET_LANGUAGES[0];
      const candidates = [
        primary,
        ...existingTargets,
        ...DEFAULT_TARGET_LANGUAGES,
        "fr",
        "de",
        "pt",
        "it",
        "zh",
        "ja",
        "ko",
        ...LANGUAGES.map((language) => language.code)
      ];
      const nextTargets: string[] = [];
      const exactCount = Math.min(MAX_TARGET_LANGUAGES, Math.max(1, desiredCount));

      for (const candidate of candidates) {
        const code = normalizeLanguageCode(candidate);
        if (!code || code === "auto" || code === activeSource || !SUPPORTED_LANGUAGE_CODES.has(code) || nextTargets.includes(code)) continue;
        nextTargets.push(code);
        if (nextTargets.length === exactCount) break;
      }

      return nextTargets.length > 0 ? nextTargets : ["es"];
    };

    const handlePrivacyModeChange = (nextMode: PrivacyMode) => {
      if (isRecording) return;
      const nextPrivateMode = nextMode === "private";
      const nextShareableMode = nextMode === "shareable";
      setPrivateMode(nextPrivateMode);
      setShareableMode(nextShareableMode);
      persistSetting("privateMode", nextPrivateMode);
      persistSetting("shareableMode", nextShareableMode);
    };

    const handleSourceLanguageChange = (language: string) => {
      if (isRecording) return;
      const nextSource = normalizeLanguageCode(language) || "en";
      setSourceLang(nextSource);
      persistSetting("preferredSourceLang", nextSource);

      if (nextSource !== "auto" && targetLanguages.includes(nextSource)) {
        const nextTargets = buildTargetList(targetLang, targetCount, nextSource);
        setTargetLanguages(nextTargets);
        persistSetting("preferredTargetLanguages", nextTargets);
      }
    };

    const handleTargetLanguageChange = (language: string) => {
      if (isRecording) return;
      const nextTarget = normalizeLanguageCode(language) || DEFAULT_TARGET_LANGUAGES[0];
      const nextTargets = buildTargetList(nextTarget, targetCount);
      setTargetLanguages(nextTargets);
      persistSetting("preferredTargetLang", nextTarget);
      persistSetting("preferredTargetLanguages", nextTargets);
    };

    const handleTargetSlotChange = (index: number, language: string) => {
      if (isRecording) return;
      const nextTarget = normalizeLanguageCode(language) || DEFAULT_TARGET_LANGUAGES[0];
      const nextCandidateTargets = [...targetLanguages];
      nextCandidateTargets[index] = nextTarget;
      const nextTargets = buildTargetList(nextCandidateTargets[0] || nextTarget, targetCount, sourceLang, nextCandidateTargets);
      setTargetLanguages(nextTargets);
      persistSetting("preferredTargetLang", nextTargets[0]);
      persistSetting("preferredTargetLanguages", nextTargets);
    };

    const handleSwapLanguages = () => {
      if (isRecording) return;
      const nextSource = targetLang;
      const nextTarget = sourceLang === "auto" ? "en" : sourceLang;
      const nextTargets = buildTargetList(nextTarget, targetCount, nextSource);
      setSourceLang(nextSource);
      setTargetLanguages(nextTargets);
      persistSetting("preferredSourceLang", nextSource);
      persistSetting("preferredTargetLang", nextTargets[0]);
      persistSetting("preferredTargetLanguages", nextTargets);
    };

    const handleThreeWayToggle = (enabled: boolean) => {
      if (isRecording) return;
      const nextTargets = buildTargetList(targetLang, enabled ? 3 : 1);
      setTargetLanguages(nextTargets);
      persistSetting("preferredTargetLang", nextTargets[0]);
      persistSetting("preferredTargetLanguages", nextTargets);
    };

    const handleTwoWayToggle = (enabled: boolean) => {
      if (isRecording) return;
      const nextTargets = buildTargetList(targetLang, enabled ? 2 : 1);
      setTargetLanguages(nextTargets);
      persistSetting("preferredTargetLang", nextTargets[0]);
      persistSetting("preferredTargetLanguages", nextTargets);
    };

    return (
      <main className="mx-auto w-full max-w-5xl space-y-8 px-4 pb-16 sm:px-6">
        <HeroSection />

        <div className="space-y-6">
          <ModeTabs activeMode={privacyMode} disabled={isRecording} onChange={handlePrivacyModeChange} />
          <ToolTabs activeTool={mode} disabled={isRecording} onChange={selectMode} />
          <LanguageSelector
            languages={LANGUAGES}
            sourceLanguage={sourceLang}
            targetLanguage={targetLang}
            targetLanguages={targetLanguages}
            targetLimit={targetCount}
            disabled={isRecording}
            onSourceChange={handleSourceLanguageChange}
            onTargetChange={handleTargetLanguageChange}
            onTargetSlotChange={handleTargetSlotChange}
            onSwap={handleSwapLanguages}
          />
          <TranslationOptions
            twoWayEnabled={twoWayEnabled}
            threeWayEnabled={threeWayEnabled}
            disabled={isRecording}
            onTwoWayToggle={handleTwoWayToggle}
            onThreeWayToggle={handleThreeWayToggle}
          />
        </div>

        <TranslationPanel
          mode={mode}
          status={status}
          statusLabel={statusLabel}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
          originalText={latestOriginal}
          interimText={interimOriginal}
          translations={translationEntries}
          isConnected={socketConnected}
          connectionState={connectionState}
          isRecording={isRecording}
          sessionSeconds={sessionSeconds}
          chunkCount={chunkCount}
          lastLatency={lastLatency}
          historyCount={history.length}
          alert={alert || microphoneNotice}
          aiDegraded={aiDegraded}
          onMicClick={!isRecording ? () => void startSession() : stopSession}
          onClear={clearLiveSession}
          onSave={saveHistoryAsPdf}
        />

        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-col gap-1 border-b border-gray-100 pb-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Conversation history</p>
              <h2 className="mt-1 text-lg font-semibold text-gray-950">{history.length} saved transcript lines</h2>
            </div>
            <button type="button" onClick={() => navigate("history")} className="w-fit text-sm font-semibold text-blue-600 transition hover:text-blue-700">
              View history
            </button>
          </div>

          <div className="max-h-72 scroll-smooth overflow-y-auto overscroll-contain pt-4 pr-1 [scrollbar-gutter:stable]">
            {history.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">Final transcripts will appear here during the session.</p>
            ) : (
              <div className="space-y-3">
                {visibleHistory.map((entry) => (
                  <article key={entry.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">[{formatHistoryTimestamp(entry.timestamp)}]</p>
                    <p className="text-sm leading-6 text-gray-700"><span className="font-semibold text-gray-950">{entry.sourceLang.toUpperCase()}:</span> {entry.original || "No transcript text"}</p>
                    <div className="mt-2 space-y-1.5">
                      {orderedTranslationEntries(normalizeTranslationMap(entry.translations, entry.translated, entry.targetLang, { sourceText: entry.original }), entry.targetLanguages || [entry.targetLang]).map(([language, translatedText]) => (
                        <p key={language} className="text-sm leading-6 text-blue-900">
                          <span className="font-semibold text-blue-700">{language.toUpperCase()}:</span> {translatedText || "No translation text"}
                        </p>
                      ))}
                    </div>
                  </article>
                ))}
                <div ref={historyEndRef} />
              </div>
            )}
          </div>
        </section>
      </main>
    );
  };

  const renderPricing = () => {
    const yearly = billingCycle === "yearly";
    const priceFor = (monthly: number) => Math.round(monthly * (yearly ? 0.8 : 1));

    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-10">
        <div className="mb-8 flex flex-col gap-4 text-center md:items-center">
          <p className="text-xs font-bold uppercase tracking-widest text-blue-600">Pricing</p>
          <h1 className="text-4xl font-black text-gray-950 md:text-5xl">Plans for every live workflow</h1>
          <div className="inline-flex items-center justify-center gap-2 rounded-full border border-gray-200 bg-white p-1 shadow-sm">
            <button onClick={() => setBillingCycle("monthly")} className={`rounded-full px-4 py-2 text-sm font-bold ${billingCycle === "monthly" ? "bg-gray-950 text-white" : "text-gray-500"}`}>Monthly</button>
            <button onClick={() => setBillingCycle("yearly")} className={`rounded-full px-4 py-2 text-sm font-bold ${billingCycle === "yearly" ? "bg-blue-600 text-white" : "text-gray-500"}`}>Yearly</button>
            <span className="pr-3 text-xs font-bold uppercase tracking-widest text-blue-600">Save 20% yearly</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {PRICING_PLANS.map((plan) => (
            <GlassPanel key={plan.name} className={`p-5 ${plan.highlighted ? "border-blue-500/35" : ""}`}>
              {plan.highlighted && <span className="mb-3 inline-flex rounded-full bg-blue-600 px-3 py-1 text-xs font-black uppercase tracking-wider text-white">Popular</span>}
              <p className="text-xl font-black text-gray-950">{plan.name}</p>
              <p className="mt-4 text-4xl font-black text-gray-950">${priceFor(plan.monthly)}<span className="text-sm text-gray-500">/mo</span></p>
              <ul className="mt-5 space-y-3 text-sm text-gray-600">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                    {feature}
                  </li>
                ))}
              </ul>
              <button onClick={() => void upgradePlan()} className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-black ${plan.highlighted ? "bg-blue-600 text-white hover:bg-blue-700" : "border border-gray-200 bg-white text-gray-800 hover:bg-gray-50"}`}>
                Subscribe
              </button>
            </GlassPanel>
          ))}

          <GlassPanel className="p-5">
            <p className="text-xl font-black text-gray-950">Enterprise</p>
            <p className="mt-4 text-3xl font-black text-gray-950">Custom</p>
            <ul className="mt-5 space-y-3 text-sm text-gray-600">
              {["Custom pricing", "Dedicated onboarding", "Security review", "Contact form"].map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                  {feature}
                </li>
              ))}
            </ul>
            <button onClick={() => setAlert("Enterprise contact form is ready for your sales workflow.")} className="mt-6 w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm font-black text-gray-800 hover:bg-gray-50">
              Contact sales
            </button>
          </GlassPanel>
        </div>
      </main>
    );
  };

  const renderHistory = () => (
    <main className="mx-auto w-full max-w-6xl px-5 py-8">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-gray-500">History</p>
          <h1 className="mt-2 text-4xl font-black text-gray-950">Session history</h1>
        </div>
        <button onClick={() => void fetchHistory()} className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50">Refresh</button>
      </div>
      <div className="space-y-3">
        {savedHistory.length === 0 && <GlassPanel className="p-6 text-sm text-slate-500">No saved sessions yet.</GlassPanel>}
        {savedHistory.map((item) => (
          <GlassPanel key={item.id} className="p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="font-black text-gray-950">{item.title}</p>
                <p className="mt-1 text-xs font-bold uppercase tracking-widest text-gray-500">{languageName(item.sourceLang)} to {languageName(item.targetLang)} - {new Date(item.createdAt).toLocaleString()}</p>
              </div>
              <button onClick={() => (isPro ? setAlert("History export prepared.") : navigate("pricing"))} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50">
                <Download className="h-4 w-4" />
                Export
                {!isPro && <Lock className="h-3.5 w-3.5 text-amber-300" />}
              </button>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">{item.originalText || "No transcript text"}</p>
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
                {orderedTranslationEntries(
                  normalizeTranslationMap(item.translations, item.translatedText, item.targetLang, { sourceText: item.originalText }),
                  item.targetLanguages || [item.targetLang]
                ).map(([language, translatedText]) => (
                  <p key={language}><span className="font-black text-blue-700">{language.toUpperCase()}:</span> {translatedText}</p>
                ))}
              </div>
            </div>
          </GlassPanel>
        ))}
      </div>
    </main>
  );

  const renderHelp = () => (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <h1 className="text-5xl font-black text-gray-950">Help</h1>
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        {[
          ["Microphone", "Allow microphone permission in your browser or Android WebView."],
          ["Live sessions", "Use the mic button to stream short audio chunks for low-latency subtitles."],
          ["Plans", "Upgrade from Pricing to unlock dubbing and exports."]
        ].map(([title, text]) => (
          <GlassPanel key={title} className="p-5">
            <BadgeHelp className="h-5 w-5 text-blue-300" />
            <p className="mt-4 font-black text-gray-950">{title}</p>
            <p className="mt-2 text-sm leading-6 text-gray-500">{text}</p>
          </GlassPanel>
        ))}
      </div>
    </main>
  );

  const renderAdmin = () => {
    const barData = adminStats ? [
      { name: 'Gemini', cost: adminStats.gemini.cost, requests: adminStats.gemini.requests },
      { name: 'OpenAI', cost: adminStats.openai.cost, requests: adminStats.openai.requests }
    ] : [];

    const lineData = adminStats?.history || [];

    const totalCost = adminStats ? adminStats.gemini.cost + adminStats.openai.cost : 0;
    const budgetUsage = adminStats ? (totalCost / adminStats.budget) * 100 : 0;
    const maxBarCost = Math.max(...barData.map((entry) => entry.cost), 0.001);
    const recentLineData = lineData.slice(-24);
    const maxHistoryCost = Math.max(...recentLineData.map((entry: any) => Number(entry.gemini || 0) + Number(entry.openai || 0)), 0.001);

    return (
      <main className="mx-auto w-full max-w-6xl px-5 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-4xl font-black text-white">Admin Dashboard</h1>
          <div className="text-right">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Global Budget</p>
            <p className="text-xl font-black text-white">${totalCost.toFixed(2)} / ${adminStats?.budget?.toFixed(2)}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <GlassPanel className="p-6 md:col-span-2">
            <p className="mb-6 text-sm font-bold uppercase tracking-widest text-slate-500">API Cost Breakdown (USD)</p>
            <div className="grid h-64 grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
              <div className="flex items-end gap-5 rounded-lg border border-white/5 bg-slate-950/50 p-4">
                {barData.map((entry) => (
                  <div key={entry.name} className="flex flex-1 flex-col items-center gap-2">
                    <div className="flex h-40 w-full items-end rounded bg-slate-900">
                      <div
                        className={`w-full rounded-t transition-all duration-500 ${entry.name === "Gemini" ? "bg-blue-500" : "bg-emerald-500"}`}
                        style={{ height: `${Math.max(4, (entry.cost / maxBarCost) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs font-black text-white">{entry.name}</p>
                    <p className="text-[11px] text-slate-500">${entry.cost.toFixed(4)} / {entry.requests} req</p>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-white/5 bg-slate-950/50 p-4">
                <div className="mb-3 flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-slate-500">
                  <span>24H Spend</span>
                  <span>${maxHistoryCost.toFixed(4)} peak</span>
                </div>
                <div className="flex h-44 items-end gap-1">
                  {recentLineData.length > 0 ? (
                    recentLineData.map((entry: any, index: number) => {
                      const total = Number(entry.gemini || 0) + Number(entry.openai || 0);
                      return (
                        <div
                          key={`${entry.timestamp || index}`}
                          className="flex-1 rounded-t bg-blue-400/40 transition-all"
                          style={{ height: `${Math.max(3, (total / maxHistoryCost) * 100)}%` }}
                          title={`${entry.timestamp || ""} $${total.toFixed(4)}`}
                        />
                      );
                    })
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-sm text-slate-600">No usage history yet.</div>
                  )}
                </div>
              </div>
            </div>
          </GlassPanel>

          <GlassPanel className="flex flex-col justify-center p-6">
            <p className="mb-2 text-sm font-bold uppercase tracking-widest text-slate-500">Monthly Budget Usage</p>
            <div className="relative pt-1">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <span className="inline-block rounded-full bg-blue-500/20 px-2 py-1 text-xs font-semibold uppercase text-blue-400">
                    {budgetUsage.toFixed(1)}% consumed
                  </span>
                </div>
              </div>
              <div className="mb-4 flex h-2 overflow-hidden rounded bg-slate-800 text-xs">
                <div style={{ width: `${Math.min(100, budgetUsage)}%` }} className={`shadow-none transition-all duration-500 flex flex-col text-center whitespace-nowrap text-white justify-center ${budgetUsage > 90 ? 'bg-red-500' : budgetUsage > 75 ? 'bg-amber-500' : 'bg-blue-500'}`}></div>
              </div>
            </div>
          </GlassPanel>
        </div>
      </main>
    );
  };

  const renderSettings = () => (
    <main className="mx-auto w-full max-w-6xl px-5 py-8">
      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-widest text-gray-500">Settings</p>
        <h1 className="mt-2 text-4xl font-black text-gray-950">Workspace preferences</h1>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <GlassPanel className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-blue-300" />
            <p className="font-black text-gray-950">General settings</p>
          </div>
          <div className="space-y-3">
            <ToggleRow label="Save transcript" value={saveTranscript} onChange={(value) => { setSaveTranscript(value); persistSetting("saveTranscript", value); }} />
            <ToggleRow label="Save audio" value={saveAudio} onChange={(value) => { setSaveAudio(value); persistSetting("saveAudio", value); }} />
            <ToggleRow label="Speaker detection" value={speakerDetection} onChange={(value) => { setSpeakerDetection(value); persistSetting("speakerDetection", value); }} />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px]">
              <ToggleRow label="Auto-stop on silence" value={autoStopOnSilence} onChange={(value) => { setAutoStopOnSilence(value); persistSetting("autoStopOnSilence", value); }} />
              <SelectControl label="Duration" value={silenceDuration} onChange={(value) => { setSilenceDuration(value); persistSetting("silenceDuration", Number(value)); }}>
                <option value="15">15 seconds</option>
                <option value="30">30 seconds</option>
                <option value="60">60 seconds</option>
                <option value="90">90 seconds</option>
              </SelectControl>
            </div>
            <ToggleRow label="Censor profane language" value={censorProfanity} onChange={(value) => { setCensorProfanity(value); persistSetting("censorProfanity", value); }} />
          </div>
        </GlassPanel>

        <GlassPanel className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <Mic className="h-5 w-5 text-blue-300" />
            <p className="font-black text-gray-950">Audio processing</p>
          </div>
          <div className="space-y-3">
            <SelectControl label="Microphone" value={microphoneId} onChange={(value) => { setMicrophoneId(value); persistSetting("microphoneId", value); }}>
              <option value="default">System default microphone</option>
              {microphones.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
            </SelectControl>
            <ToggleRow label="Echo cancellation" value={echoCancellation} onChange={(value) => { setEchoCancellation(value); persistSetting("echoCancellation", value); }} />
            <ToggleRow label="Noise suppression" value={noiseSuppression} onChange={(value) => { setNoiseSuppression(value); persistSetting("noiseSuppression", value); }} />
            <ToggleRow label="Auto gain control" value={autoGainControl} onChange={(value) => { setAutoGainControl(value); persistSetting("autoGainControl", value); }} />
          </div>
        </GlassPanel>

        <GlassPanel className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-300" />
            <p className="font-black text-gray-950">AI settings</p>
          </div>
          <div className="space-y-3">
            <SelectControl label="Summary length" value={summaryLength} onChange={(value) => { setSummaryLength(value as SummaryLength); persistSetting("summaryLength", value as SummaryLength); }}>
              <option value="short">Short</option>
              <option value="standard">Standard</option>
              <option value="long">Long</option>
            </SelectControl>
            <SelectControl label="Summary language" value={summaryLanguage} onChange={(value) => { setSummaryLanguage(value); persistSetting("summaryLanguage", value); }}>
              {LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.name}</option>)}
            </SelectControl>
            <div className="relative">
              <SelectControl label="AI Provider Preference" value={preferredProvider} onChange={(value) => { if (!isPro && value !== "auto") { setAlert("Manual provider override is a Pro feature."); return; } setPreferredProvider(value); persistSetting("preferredProvider", value); }}>
                <option value="auto">Auto (Plan optimized)</option>
                <option value="gemini" title={providerHealth.gemini.status === 'cooldown' ? `Rate limit active. Cooldown expires at ${new Date(providerHealth.gemini.cooldownUntil).toLocaleTimeString()}` : 'Provider is healthy'}>
                  {getProviderStatusLabel('gemini', 'Gemini')}
                </option>
                <option value="openai" title={providerHealth.openai.status === 'cooldown' ? `Rate limit active. Cooldown expires at ${new Date(providerHealth.openai.cooldownUntil).toLocaleTimeString()}` : 'Provider is healthy'}>
                  {getProviderStatusLabel('openai', 'OpenAI')}
                </option>
              </SelectControl>
              {!isPro && <Lock className="absolute right-9 top-[38px] h-3.5 w-3.5 text-amber-300/40" />}
            </div>
            <ToggleRow label="Scene detection" value={sceneDetection} onChange={(value) => { setSceneDetection(value); persistSetting("sceneDetection", value); }} />
            <ToggleRow label="Action item extraction" value={actionItemExtraction} onChange={(value) => { setActionItemExtraction(value); persistSetting("actionItemExtraction", value); }} />
            <ToggleRow label="Per-speaker summary" value={perSpeakerSummary} onChange={(value) => { setPerSpeakerSummary(value); persistSetting("perSpeakerSummary", value); }} />
            <ToggleRow label="Sentiment tracking" value={sentimentTracking} onChange={(value) => { setSentimentTracking(value); persistSetting("sentimentTracking", value); }} />
            <ToggleRow label="Keywords extraction" value={keywordsExtraction} onChange={(value) => { setKeywordsExtraction(value); persistSetting("keywordsExtraction", value); }} />
            <div className="mt-4 border-t border-gray-100 pt-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Live AI Latency</p>
              <LatencyGraph data={latencyHistory} />
            </div>
          </div>
        </GlassPanel>

        <GlassPanel className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <User className="h-5 w-5 text-blue-300" />
            <p className="font-black text-gray-950">Account</p>
          </div>
          <div className="space-y-3 text-sm text-gray-600">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="font-black text-gray-950">{user?.name}</p>
              <p className="mt-1 text-gray-500">{user?.email}</p>
              <p className="mt-3 w-fit rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-black uppercase tracking-widest text-blue-700">{user?.plan || "free"} plan</p>
            </div>
            <button onClick={() => void logout()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 font-bold text-red-100 hover:bg-red-500/15">
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </GlassPanel>
      </div>
    </main>
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {renderTopNav()}
      {view === "landing" && renderLanding()}
      {view === "login" && <AuthPage mode="login" authProvider={authProvider} error={authError} onSubmit={handleAuthSubmit} onGoogle={handleGoogleLogin} onGoogleError={setAuthError} onNavigate={navigate} />}
      {view === "signup" && <AuthPage mode="signup" authProvider={authProvider} error={authError} onSubmit={handleAuthSubmit} onGoogle={handleGoogleLogin} onGoogleError={setAuthError} onNavigate={navigate} />}
      {view === "dashboard" && isAuthed && renderDashboard()}
      {view === "pricing" && renderPricing()}
      {view === "admin" && user?.role === 'admin' && renderAdmin()}
      {view === "history" && isAuthed && renderHistory()}
      {view === "help" && renderHelp()}
      {view === "settings" && isAuthed && renderSettings()}

      <footer className="border-t border-gray-200 bg-white px-5 py-5">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 text-xs text-gray-500 md:flex-row md:items-center md:justify-between">
          <span>InterpShield - Built by Isaac David</span>
          <span>Live captions, translation, dubbing, summaries, and session history.</span>
        </div>
      </footer>
    </div>
  );
}
