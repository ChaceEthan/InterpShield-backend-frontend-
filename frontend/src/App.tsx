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
import { API, CLIENT_URL, FRONTEND_CONFIG_DIAGNOSTICS, GOOGLE_CLIENT_ID, SOCKET_TRANSPORTS, SOCKET_URL, WS_URL } from "./config/socket";
import { AudioSourceTabs } from "./components/AudioSourceTabs";
import { HeroSection } from "./components/HeroSection";
import { LanguageSelector } from "./components/LanguageSelector";
import { ModeTabs, type PrivacyMode } from "./components/ModeTabs";
import { Navbar } from "./components/Navbar";
import { ToolTabs } from "./components/ToolTabs";
import { TranslationOptions } from "./components/TranslationOptions";
import { TranslationPanel } from "./components/TranslationPanel";
import { AdminDashboard, AdminLogin } from "./components/AdminDashboard";
import type { TranscriptTranslationEntry } from "./components/TranscriptArea";
import { buildProductionAudioConstraints, createVadController, DEFAULT_VAD_CONFIG } from "./audio/vadController.mjs";
import { createUtteranceBoundaryController, stableSessionStartTime } from "./audio/recorderLifecycle.mjs";
import { createDubbingLifecycle } from "./audio/dubbingLifecycle.mjs";
import { containerSignature, selectDeepgramMediaRecorderMimeType } from "./audio/mediaRecorderFormat.mjs";
import { createMeaningfulSpeechGate } from "./audio/meaningfulSpeechGate.mjs";
import { isTabAudioCaptureSupported, requestTabAudioStream } from "./audio/tabAudioSource.mjs";
import { classifyRecorderStop, isTrackEndExpected, shouldRecoverFromRecorderStop } from "./audio/trackEndPolicy.mjs";
import { isAdminRole, normalizeAuthUser } from "./auth/roles.mjs";
import { PLAN_CATALOG, PRICING_PLAN_IDS, yearlyMonthlyPrice } from "../../shared/plans.mjs";
import {
  LANGUAGE_CATALOG,
  LANGUAGE_FLAGS,
  SPEECH_SYNTHESIS_LANGS,
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode as normalizeSharedLanguageCode
} from "../../shared/languages.mjs";

type View = "landing" | "login" | "signup" | "dashboard" | "pricing" | "subscription" | "history" | "help" | "settings" | "admin-login" | "admin";
type Mode = "transcribe" | "translate" | "dubbing";
type AudioSourceMode = "microphone" | "tab";
type SessionStatus = "idle" | "connecting" | "calibrating" | "listening" | "speaking" | "soft-pause" | "finalizing" | "draining" | "translating" | "paused" | "stopping" | "error";
type TranslationLifecycleState = "ready" | "queued" | "processing" | "translating" | "retrying" | "translated" | "done" | "failed" | "stale" | "cancelled";
type TranslationProviderDiagnostic = {
  language?: string;
  provider?: string;
  providerModel?: string | null;
  retryCount?: number | null;
  latencyMs?: number | null;
  requestId?: string | null;
  status?: string;
  reason?: string;
  errorCode?: string | null;
  errorCategory?: string | null;
  fallbackProvider?: string | null;
  httpStatus?: number | string | null;
  providerResponse?: string | null;
  queueLength?: number | null;
  activeWorkers?: number | null;
  message?: string;
};
type SocketConnectionState = "ready" | "connecting" | "connected" | "listening" | "translating" | "reconnecting";
type MicrophonePermissionState = "unknown" | "prompt" | "granted" | "denied" | "unsupported";
type MicrophoneRuntimeState = "idle" | "checking" | "requesting" | "ready" | "recording" | "recovering" | "blocked" | "failed";
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
  role?: "super_admin" | "admin" | "user";
  status?: "active" | "expired" | "suspended" | "deactivated";
  subscription?: { planLabel: string; subscriptionStatus: string; subscriptionType: string; trialSecondsRemaining?: number | null; trialSecondsUsed?: number | null; trialSecondsTotal?: number; subscriptionEndsAt?: string | null; daysRemaining?: number | null; isTrial: boolean; isUnlimited: boolean; canUseInterpreter: boolean; nextRenewalAt?: string | null };
  planOverride?: "free" | "starter" | "pro" | "unlimited";
  mustChangePassword?: boolean;
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

type PendingTranscriptEntry = Pick<TranscriptHistoryEntry, "original" | "timestamp" | "sourceLang" | "targetLang" | "targetLanguages"> & {
  jobId?: string | number;
  sequence?: number;
  sessionId?: string;
  translationId: string;
};

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

interface AudioDiagnosticState {
  state: MicrophoneRuntimeState;
  message: string;
  deviceLabel?: string;
  mimeType?: string;
  webAudio?: boolean;
  lastError?: string;
  lastRestartReason?: string;
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
  streamGeneration: number;
  containerHeader: boolean;
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

const TRANSCRIPT_HISTORY_STORAGE_KEY = "interp_history";
const MAX_TRANSCRIPT_HISTORY_ENTRIES = 40;
const MAX_TARGET_LANGUAGES = 3;
const LIVE_TEXT_WINDOW_CHARS = 900;
const LIVE_SEGMENT_WINDOW = 6;
const MAX_LIVE_SEGMENTS = 18;
const VISIBLE_HISTORY_ITEMS = 40;
const PARTIAL_SUBTITLE_THROTTLE_MS = 60;
const HISTORY_PERSIST_DEBOUNCE_MS = 250;
const DUBBING_UTTERANCE_TTL_MS = 15000;
const MIN_MEDIA_CHUNK_BYTES = 96;
const MIN_AUDIO_CHUNK_INTERVAL_MS = 45;
const MAX_CONTAINER_HEADER_RETRIES = 3;
const VAD_POLL_INTERVAL_MS = 30;
const FINAL_CHUNK_ACK_TIMEOUT_MS = 2500;
const RECORDING_DRAIN_TIMEOUT_MS = 8000;
// Once the final transcript has actually arrived, the only remaining work is translation — a
// separate, network/provider-bound step whose latency has nothing to do with how long STT took.
// This bound (and per-language allowance) governs that second, translation-only wait, so 2-3
// target languages under normal provider latency are not killed by the same clock meant to
// catch a genuinely missing STT final.
const TRANSLATION_DRAIN_TIMEOUT_MS = 12000;
const TRANSLATION_DRAIN_PER_LANGUAGE_MS = 4000;
const MAX_SOCKET_RECONNECT_ATTEMPTS = 8;
const CAPTION_WATCHDOG_MS = 12000;
const isDesktopChrome = () => typeof navigator !== "undefined" && /Chrome\//i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
const MAX_QUEUED_AUDIO_CHUNKS = 240;
const MAX_PENDING_FINAL_TRANSCRIPTS = 16;
const CLIENT_HEARTBEAT_MS = 25000;
const AUTH_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
// A translation card stuck in queued/processing/retrying is a live-interpreter UX failure, not
// a background task — 45s let a language sit on "Translating..."/"Retrying" for nearly a minute
// while the speaker kept talking, which is what "stuck retrying forever" looked like to a real
// user even though it did technically resolve eventually. 18s is still generous enough for a
// genuine Gemini-then-OpenAI fallback with the backend's own bounded per-provider retries, but
// far closer to what a live captioning experience actually requires.
const STALE_TRANSLATION_STATE_MS = 18000;
const SOCKET_HEARTBEAT_STALE_MS = 75000;
const DEFAULT_TARGET_LANGUAGES = ["es"];
const VIEWS: View[] = ["landing", "login", "signup", "dashboard", "pricing", "subscription", "history", "help", "settings", "admin-login", "admin"];
const PROTECTED_VIEWS = new Set<View>(["dashboard", "subscription", "history", "settings", "admin"]);

const readViteBoolean = (value?: string) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
const CLIENT_SESSION_STORAGE_KEY = "interp_shield_client_session_id";

const createClientSessionId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const readOrCreateClientSessionId = () => {
  try {
    const existing = localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (existing) return existing;
    const next = createClientSessionId();
    localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return createClientSessionId();
  }
};

const frontendDebugEnabled = (flag: "audio" | "socket" | "translation" | "env") => {
  const flags = {
    audio: import.meta.env.VITE_AUDIO_DEBUG,
    socket: import.meta.env.VITE_SOCKET_DEBUG,
    translation: import.meta.env.VITE_TRANSLATION_DEBUG,
    env: import.meta.env.VITE_ENV_DEBUG
  };
  return readViteBoolean(flags[flag]);
};

const logFrontendDebug = (flag: "audio" | "socket" | "translation" | "env", event: string, payload: Record<string, unknown> = {}) => {
  if (!frontendDebugEnabled(flag)) return;
  console.info(`[${event}]`, payload);
};

logFrontendDebug("env", "FRONTEND_ENV_DIAGNOSTICS", FRONTEND_CONFIG_DIAGNOSTICS);

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

const LANGUAGES: Language[] = LANGUAGE_CATALOG.map(({ code, name, region }) => ({ code, name, region }));

const TOOL_ITEMS: Array<{ mode: Mode; label: string; icon: LucideIcon }> = [
  { mode: "transcribe", label: "Transcribe", icon: FileText },
  { mode: "translate", label: "Translate", icon: Languages },
  { mode: "dubbing", label: "Dubbing", icon: Volume2 }
];

const PRICING_PLANS = PRICING_PLAN_IDS.map((planId) => ({
  ...PLAN_CATALOG[planId],
  highlighted: planId === "creator"
}));

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
  return normalizeSharedLanguageCode(normalized) || "en";
};

const normalizeComparableText = (text = "") =>
  text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");

const pendingTranscriptKey = ({
  sessionId,
  jobId,
  sequence,
  original
}: {
  sessionId?: string;
  jobId?: string | number;
  sequence?: number;
  original?: string;
}) => {
  const sessionPart = sessionId || "session";
  const jobPart = String(jobId ?? "").trim();
  if (jobPart) return `job:${sessionPart}:${jobPart}`;
  if (Number.isFinite(sequence)) return `seq:${sessionPart}:${sequence}`;

  const normalizedOriginal = normalizeComparableText(original || "");
  return normalizedOriginal ? `text:${sessionPart}:${normalizedOriginal}` : "";
};

const pendingTranscriptKeys = (entry: Partial<PendingTranscriptEntry>) =>
  [
    pendingTranscriptKey({ sessionId: entry.sessionId, jobId: entry.jobId }),
    pendingTranscriptKey({ sessionId: entry.sessionId, sequence: entry.sequence }),
    pendingTranscriptKey({ sessionId: entry.sessionId, original: entry.original }),
    pendingTranscriptKey({ jobId: entry.jobId }),
    pendingTranscriptKey({ sequence: entry.sequence }),
    pendingTranscriptKey({ original: entry.original })
  ].filter(Boolean);

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
  const state = String(value || "").trim().toLowerCase();
  if (state === "done") return "translated";
  if (state === "translating") return "processing";
  return ["ready", "queued", "processing", "retrying", "translated", "failed", "stale", "cancelled"].includes(state)
    ? (state as TranslationLifecycleState)
    : "";
};

const formatProviderDiagnostic = (diagnostic: TranslationProviderDiagnostic) => {
  const reason = diagnostic.reason || diagnostic.message || "Translation failed";
  const quotaEvidence = [
    diagnostic.errorCode,
    diagnostic.errorCategory,
    diagnostic.reason,
    diagnostic.providerResponse
  ].filter(Boolean).join(" ").toLowerCase();
  const isOpenAiQuota = String(diagnostic.provider || "").toLowerCase() === "openai" &&
    /(insufficient[_ ]quota|current quota(?: has been)? exceeded|exceeded your current quota|check your plan and billing|usage limit(?: has been)? reached|billing|credit balance)/i.test(quotaEvidence);
  if (isOpenAiQuota) {
    return String(diagnostic.status || "").toLowerCase() === "retrying"
      ? "OpenAI quota is currently unavailable.\nTrying the alternative translation provider."
      : "OpenAI quota is currently unavailable.";
  }
  const lines = [
    "FAILED",
    `Provider: ${diagnostic.provider || "unknown"}`,
    `HTTP Status: ${diagnostic.httpStatus ?? "unknown"}`,
    `Failure Reason: ${reason}`,
    `Latency: ${typeof diagnostic.latencyMs === "number" ? `${diagnostic.latencyMs} ms` : "unknown"}`,
    `Retry Count: ${typeof diagnostic.retryCount === "number" ? diagnostic.retryCount : 0}`,
    `Queue Length: ${typeof diagnostic.queueLength === "number" ? diagnostic.queueLength : "unknown"}`,
    `Active Workers: ${typeof diagnostic.activeWorkers === "number" ? diagnostic.activeWorkers : "unknown"}`,
    `Request ID: ${diagnostic.requestId || "unknown"}`
  ];
  if (diagnostic.providerModel) lines.splice(2, 0, `Provider Model: ${diagnostic.providerModel}`);
  return lines.join("\n");
};

const appendTextWindow = (current: string, next: string, maxChars = LIVE_TEXT_WINDOW_CHARS) => {
  const combined = [current, next].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return combined.length <= maxChars ? combined : combined.slice(-maxChars).replace(/^\S+\s*/, "").trim();
};

const languageFlag = (code: string) => LANGUAGE_FLAGS[code] || "🌐";
const speechLanguage = (code: string) => SPEECH_SYNTHESIS_LANGS[code] || code;

let speechVoicesReadyPromise: Promise<SpeechSynthesisVoice[]> | null = null;
const loadSpeechVoices = () => {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const loaded = synth.getVoices();
  if (loaded.length > 0) return Promise.resolve(loaded);
  if (speechVoicesReadyPromise) return speechVoicesReadyPromise;

  speechVoicesReadyPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      synth.removeEventListener("voiceschanged", finish);
      resolve(synth.getVoices());
    };
    synth.addEventListener("voiceschanged", finish, { once: true });
    window.setTimeout(finish, 1200);
  });
  return speechVoicesReadyPromise;
};

const primeSpeechSynthesis = () => {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.getVoices();
  if (window.speechSynthesis.paused) window.speechSynthesis.resume();
  void loadSpeechVoices();
};

const selectSpeechVoice = (language: string) => {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return undefined;
  const requested = speechLanguage(language).toLowerCase();
  const base = requested.split("-")[0];
  const voices = window.speechSynthesis.getVoices();
  return voices.find((voice) => voice.lang.toLowerCase() === requested)
    || voices.find((voice) => voice.lang.toLowerCase().split("-")[0] === base);
};

const speechSynthesisUnavailableReason = () => {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return "this browser does not support speech synthesis";
  if (!("SpeechSynthesisUtterance" in window)) return "this browser does not provide speech utterances";
  return "";
};

const EXPECTED_SPEECH_CANCELLATIONS = new Set(["interrupted", "canceled", "cancelled"]);
const isExpectedSpeechCancellation = (reason: string) => EXPECTED_SPEECH_CANCELLATIONS.has(reason.trim().toLowerCase());

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
    return normalizeAuthUser(JSON.parse(stored)) as AppUser;
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
  if (typeof window === "undefined" || !("MediaRecorder" in window)) throw new Error("MediaRecorder is unavailable.");
  const selection = selectDeepgramMediaRecorderMimeType((mimeType) => MediaRecorder.isTypeSupported(mimeType));
  if (import.meta.env.DEV) console.info("[AUDIO_MIME_SUPPORT]", selection.support);
  return selection.mimeType;
};

const isDeviceConstraintError = (error: unknown) =>
  error instanceof DOMException &&
  ["OverconstrainedError", "ConstraintNotSatisfiedError", "NotFoundError", "DevicesNotFoundError"].includes(error.name);

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
  // Production capture always enables native browser processing. The legacy
  // arguments remain in the signature so stored settings stay compatible.
  void echoCancellation;
  void noiseSuppression;
  void autoGainControl;
  return buildProductionAudioConstraints(supportedConstraints, microphoneId);
};

const requestMicrophoneStream = async (audio: MediaTrackConstraints, fallbackAudio: MediaTrackConstraints) => {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch (error) {
    if (!("deviceId" in audio) || !isDeviceConstraintError(error)) throw error;

    logFrontendDebug("audio", "AUDIO_DEVICE_FALLBACK", {
      reason: error instanceof Error ? error.name : "unknown",
      requestedDeviceId: audio.deviceId
    });
    return navigator.mediaDevices.getUserMedia({ audio: fallbackAudio });
  }
};

const createMediaRecorderWithFallback = (preferredStream: MediaStream, fallbackStream: MediaStream, preferredMimeType: string) => {
  const streams = preferredStream === fallbackStream
    ? [{ stream: preferredStream, label: "microphone" }]
    : [
        { stream: preferredStream, label: "enhanced" },
        { stream: fallbackStream, label: "microphone" }
      ];
  const mimeTypes = [preferredMimeType];
  const errors: string[] = [];

  for (const { stream, label } of streams) {
    for (const mimeType of mimeTypes) {
      try {
        const options: MediaRecorderOptions = {
          ...(mimeType ? { mimeType } : {}),
          audioBitsPerSecond: 128_000
        };
        const recorder = new MediaRecorder(stream, options);
        if (!recorder.mimeType) throw new Error("MediaRecorder returned an empty MIME type.");
        return { recorder, stream, mimeType: recorder.mimeType, source: label };
      } catch (error) {
        errors.push(`${label}:${mimeType || "default"}:${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const recorder = new MediaRecorder(stream, { mimeType });
        if (!recorder.mimeType) throw new Error("MediaRecorder returned an empty MIME type.");
        return { recorder, stream, mimeType: recorder.mimeType, source: label };
      } catch (error) {
        errors.push(`${label}:${mimeType || "default"}:basic:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  throw new Error(`MediaRecorder could not start with available audio streams. ${errors.slice(-3).join(" | ")}`);
};

const mediaErrorMessage = (error: unknown, source: AudioSourceMode = "microphone") => {
  if (source === "tab") {
    if (error instanceof Error && (error.name === "TabAudioUnsupportedError" || error.name === "TabAudioNoTrackError")) {
      return error.message;
    }
    if (error instanceof DOMException && ["NotAllowedError", "PermissionDeniedError", "AbortError"].includes(error.name)) {
      return "Tab/system audio sharing was cancelled. Select a tab and enable \"Share tab audio\" to continue.";
    }
    if (error instanceof DOMException && error.name === "NotReadableError") {
      return "The shared tab or screen audio could not be captured. Try sharing again.";
    }
    return "Unable to capture tab/system audio. Check browser support and try again.";
  }

  if (error instanceof DOMException) {
    if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error.name)) {
      return "Microphone permission denied. Allow microphone access to start live translation.";
    }
    if (["NotFoundError", "DevicesNotFoundError"].includes(error.name)) {
      return "No microphone input was found.";
    }
    if (["NotReadableError", "TrackStartError"].includes(error.name)) {
      return "Microphone is busy in another app or browser tab.";
    }
    if (["OverconstrainedError", "ConstraintNotSatisfiedError"].includes(error.name)) {
      return "Selected microphone is unavailable. Retrying with the system default microphone.";
    }
  }

  return "Unable to start microphone. Check browser audio permissions and try again.";
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

const languageName = (code: string) => {
  const normalized = normalizeLanguageCode(code);
  return LANGUAGES.find((language) => language.code === normalized)?.name || code;
};

const formatHistoryTimestamp = (timestamp: string) => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const initialView = (): View => {
  if (window.location.pathname === "/admin/login") return "admin-login";
  if (window.location.pathname === "/admin") return "admin";
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

const GlassPanel = ({ children, className = "", ...props }: { children: React.ReactNode; className?: string; [key: string]: any }) => (
  <section {...props} className={`rounded-2xl border border-gray-200 bg-white shadow-sm shadow-gray-200/70 backdrop-blur-xl ${className}`}>{children}</section>
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

const SubscriptionPage = ({ user }: { user: AppUser | null }) => {
  const subscription = user?.subscription; const plans = ["Free Trial", "Monthly", "Quarterly", "Yearly", "Enterprise"];
  const onTrial = Boolean(subscription?.isTrial) && subscription?.trialSecondsRemaining != null;
  return <main className="mx-auto min-h-[70vh] w-full max-w-5xl px-5 py-10"><h1 className="text-3xl font-black">Subscription</h1><p className="mt-2 text-gray-600">Payment processing is not enabled yet. Your account is ready for a future provider.</p>{subscription && <section className="mt-6 grid gap-3 rounded-2xl border bg-white p-5 sm:grid-cols-2 lg:grid-cols-4"><div><b>Current plan</b><p>{subscription.planLabel}</p></div><div><b>{onTrial ? "Trial remaining" : "Remaining days"}</b><p>{onTrial ? `${formatTime(Math.max(0, subscription.trialSecondsRemaining || 0))} of 5:00` : subscription.daysRemaining == null ? "Never" : subscription.daysRemaining}</p></div><div><b>Expiration date</b><p>{subscription.isUnlimited ? "Never expires" : onTrial ? "Ends when your 5 minutes of usage are used" : subscription.subscriptionEndsAt ? new Date(subscription.subscriptionEndsAt).toLocaleDateString() : "Never expires"}</p></div><div><b>Renewal date</b><p>{subscription.nextRenewalAt ? new Date(subscription.nextRenewalAt).toLocaleDateString() : "Not scheduled"}</p></div></section>}<section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{plans.map((plan) => <article key={plan} className="rounded-xl border bg-white p-4"><h2 className="font-black">{plan}</h2><p className="mt-2 text-sm text-gray-500">Provider-ready plan</p></article>)}</section><section className="mt-6 rounded-xl border bg-white p-5"><h2 className="font-black">Payment history</h2><p className="mt-2 text-sm text-gray-500">No payment history yet.</p></section></main>;
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
    <main className="mx-auto grid min-h-[calc(100dvh-76px)] w-full max-w-6xl grid-cols-1 gap-8 px-5 py-10 lg:grid-cols-[1fr_420px] lg:items-center">
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
  const [audioDiagnostic, setAudioDiagnostic] = useState<AudioDiagnosticState>({
    state: "idle",
    message: "Microphone ready"
  });

  const [mode, setMode] = useState<Mode>("translate");
  const [audioSource, setAudioSource] = useState<AudioSourceMode>("microphone");
  const audioSourceRef = useRef<AudioSourceMode>("microphone");
  const [sourceLang, setSourceLang] = useState("en");
  const [preferredProvider, setPreferredProvider] = useState<string>("auto");
  const [targetLanguages, setTargetLanguages] = useState<string[]>(DEFAULT_TARGET_LANGUAGES);
  const [privateMode, setPrivateMode] = useState(true);
  const [shareableMode, setShareableMode] = useState(false);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [mediaRecorderActive, setMediaRecorderActive] = useState(false);
  const [awaitingFinalTranscript, setAwaitingFinalTranscript] = useState(false);
  const [translationsPending, setTranslationsPending] = useState<string[]>([]);
  const [dubbingPlaying, setDubbingPlaying] = useState(false);
  const [dubbingQueued, setDubbingQueued] = useState(0);
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketReconnecting, setSocketReconnecting] = useState(false);
  const [originalSegments, setOriginalSegments] = useState<string[]>([]);
  const [translatedSegments, setTranslatedSegments] = useState<string[]>([]);
  const [history, setHistory] = useState<TranscriptHistoryEntry[]>(readStoredTranscriptHistory);
  const [liveText, setLiveText] = useState("");
  const [finalText, setFinalText] = useState("");
  const [finalTranslationText, setFinalTranslationText] = useState("");
  const [finalTranslations, setFinalTranslations] = useState<Record<string, string>>({});
  // A rolling, per-language history of every completed utterance's translation, mirroring how
  // finalText/originalSegments already accumulate source speech instead of replacing it. Once a
  // new utterance begins, finalTranslations resets to accumulate that utterance's own text (see
  // the transcript_final handler), but whatever was already shown for the previous utterance is
  // folded in here first — so the live display only ever grows, never blanks mid-conversation.
  const [translatedTextWindow, setTranslatedTextWindow] = useState<Record<string, string>>({});
  const [translationStatuses, setTranslationStatuses] = useState<Record<string, TranslationLifecycleState>>({});
  const [translationDiagnostics, setTranslationDiagnostics] = useState<Record<string, string>>({});
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
  const clientSessionIdRef = useRef(readOrCreateClientSessionId());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const getAudioLevelRef = useRef<() => number>(() => 0);
  const vadControllerRef = useRef(createVadController());
  const vadPollTimerRef = useRef<number | null>(null);
  const utteranceBoundaryRef = useRef<ReturnType<typeof createUtteranceBoundaryController> | null>(null);
  const captionWatchdogTimerRef = useRef<number | null>(null);
  const pendingSpeechChunksRef = useRef<AudioChunkPayload[]>([]);
  const recordingRef = useRef(false);
  const sessionReadyRef = useRef(false);
  const modeRef = useRef<Mode>("translate");
  const sourceLangRef = useRef(sourceLang);
  const targetLangRef = useRef(targetLang);
  const targetLanguagesRef = useRef(targetLanguages);
  const activeSessionPayloadRef = useRef<{
    clientSessionId?: string;
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
    recordingGeneration: number;
  } | null>(null);
  const shouldRestartSessionOnReconnectRef = useRef(false);
  const sequenceRef = useRef(0);
  const audioStreamGenerationRef = useRef(1);
  const pendingAudioStreamGenerationRef = useRef(1);
  const awaitingContainerHeaderRef = useRef(true);
  const containerHeaderRetryCountRef = useRef(0);
  // A single failed header probe is never, by itself, proof the container is genuinely corrupt
  // (see the awaitingContainerHeaderRef exemptions above) — it just skips that one chunk and
  // waits for the next. Only a SECOND consecutive failure for the same generation escalates to
  // the existing stop/restart recovery path below.
  const containerHeaderProbeFailuresRef = useRef(0);
  const recorderGenerationRestartRef = useRef(false);
  const lastAudioChunkSentAtRef = useRef(0);
  const queuedAudioChunksRef = useRef<AudioChunkPayload[]>([]);
  const queuedAudioDroppedRef = useRef(0);
  const clientHeartbeatTimerRef = useRef<number | null>(null);
  const audioRecoveryTimerRef = useRef<number | null>(null);
  const audioRestartAttemptsRef = useRef(0);
  const silenceTimerRef = useRef<number | null>(null);
  const drainTimeoutRef = useRef<number | null>(null);
  const awaitingFinalTranscriptRef = useRef(false);
  const drainPendingLanguagesRef = useRef<Set<string>>(new Set());
  const finishDrainRef = useRef<(reason: "processed" | "timeout") => void>(() => undefined);
  const explicitStopRequestedRef = useRef(false);
  const lastServerHeartbeatAtRef = useRef(0);
  const sessionStartedAtRef = useRef<number | null>(null);
  const lastInterimRef = useRef("");
  const lastFinalOriginalRef = useRef("");
  const lastFinalTranscriptEventKeyRef = useRef("");
  const lastFinalTranslationRef = useRef("");
  const lastCompletedTranslationRef = useRef("");
  const completedTranslationSignaturesRef = useRef<Set<string>>(new Set());
  const lastTranslationOriginalRef = useRef("");
  const finalTranslationsRef = useRef<Record<string, string>>({});
  const pendingFinalTranscriptRef = useRef<PendingTranscriptEntry | null>(null);
  const pendingFinalTranscriptsRef = useRef<Map<string, PendingTranscriptEntry>>(new Map());
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
  const conversationHistoryRef = useRef<HTMLDivElement | null>(null);
  const historyEndRef = useRef<HTMLDivElement | null>(null);
  const dubbingTransmissionGatedRef = useRef(false);
  const dubbingRequestGenerationRef = useRef(0);
  const dubbingLifecycleRef = useRef<ReturnType<typeof createDubbingLifecycle> | null>(null);
  const historySignatureRef = useRef("");
  const persistedHistorySignaturesRef = useRef<Set<string>>(new Set());
  const tokenRef = useRef(token);
  const saveTranscriptRef = useRef(saveTranscript);
  const sessionSecondsRef = useRef(sessionSeconds);
  const sessionActionInFlightRef = useRef(false);
  const startInFlightRef = useRef(false);
  const stopInFlightRef = useRef(false);
  const activeRecordingGenerationRef = useRef(0);
  const activeSessionIdRef = useRef("");
  const recorderStartedForGenerationRef = useRef<number | null>(null);
  const recorderStoppedForGenerationRef = useRef<number | null>(null);
  const recorderStopReasonRef = useRef("unexpected_stop");
  const lastHandledDeepgramGenerationRef = useRef(1);
  const finalizationEmittedForGenerationRef = useRef<number | null>(null);
  const lastVadSilenceDurationRef = useRef(0);
  const utteranceLifecycleRef = useRef(createMeaningfulSpeechGate());
  const authRequestRef = useRef<AuthProvider | null>(null);
  const socketAuthRefreshInFlightRef = useRef(false);

  const isAuthed = Boolean(user && token);
  const isPro = user?.plan === "pro" || isAdminRole(user?.role);
  const isRecording = microphoneActive || mediaRecorderActive || ["connecting", "calibrating", "draining", "translating"].includes(status);
  const latestOriginal = [...originalSegments.slice(-LIVE_SEGMENT_WINDOW), liveText].filter(Boolean).join(" ").trim() || finalText;
  const latestTranslation = formatTranslationsText(finalTranslations, targetLanguages);
  const isTranslationActive = translationsPending.length > 0 || (mode !== "transcribe" && Object.values(translationStatuses).some((translationState) =>
    ["queued", "processing", "translating", "retrying"].includes(translationState as string)
  ));
  const connectionState: SocketConnectionState =
    socketReconnecting || (!socketConnected && isRecording)
      ? "reconnecting"
      : status === "connecting"
        ? "connecting"
        : isTranslationActive
          ? "translating"
          : ["calibrating", "listening", "speaking", "soft-pause", "finalizing", "dubbing", "listening-after-dubbing", "paused"].includes(status)
            ? "listening"
            : socketConnected
              ? "connected"
              : "ready";
  const displayTranslationEntries = targetLanguages.map((language) => {
    // Rendered text is the rolling window (every completed prior utterance's translation for
    // this language) plus whatever the current utterance has accumulated so far — never a bare
    // replace, so a still-pending current utterance can never blank out a translation the user
    // already saw.
    const translatedText = appendTextWindow(translatedTextWindow[language] || "", finalTranslations[language]?.trim() || "");
    const state: TranslationLifecycleState = translatedText ? "translated" : translationStatuses[language] || "ready";
    return [language, translatedText, state, translationDiagnostics[language] || ""] as const;
  });
  const microphoneStatusLabel = audioDiagnostic.state === "recording" && audioDiagnostic.mimeType
    ? `${audioDiagnostic.message} (${audioDiagnostic.mimeType.replace(/^audio\//, "")})`
    : audioDiagnostic.message;
  const visibleHistory = useMemo(() => history.slice(-VISIBLE_HISTORY_ITEMS), [history]);
  const visibleHistoryScrollSignature = useMemo(
    () => visibleHistory.map((entry) => `${entry.id}:${entry.original}:${entry.translated}`).join("|"),
    [visibleHistory]
  );
  const maxSessionSeconds = config?.maxSessionSeconds || 3600;
  const statusLabel = status === "idle" && (dubbingPlaying || dubbingQueued > 0)
    ? "Dubbing…"
    : status === "stopping"
    ? "Stopping"
    : status === "error"
      ? "Attention"
      : status === "speaking"
        ? "Speaking…"
        : status === "soft-pause"
          ? "Waiting for more speech…"
      : status === "finalizing"
          ? "Finishing caption…"
        : status === "draining"
          ? "Finishing recording…"
        : status === "translating"
          ? "Finishing translations…"
          : status === "paused"
            ? "Paused — start speaking"
            : status === "idle"
              ? (audioDiagnostic.state === "failed"
                  ? audioDiagnostic.message
                  : (audioSource === "tab" ? "Ready to share tab audio" : "Ready"))
      : {
          ready: "Ready",
          connecting: "Connecting",
          connected: "Connected",
          listening: "Listening…",
          translating: "Translating",
          reconnecting: "Reconnecting..."
        }[connectionState];

  useEffect(() => {
    finalTranslationsRef.current = finalTranslations;
  }, [finalTranslations]);

  useEffect(() => {
    if (FRONTEND_CONFIG_DIAGNOSTICS.ok) return;
    setAlert(FRONTEND_CONFIG_DIAGNOSTICS.errors[0] || "Frontend environment configuration is invalid.");
  }, []);

  const updateSocketAuth = useCallback((nextToken = tokenRef.current) => {
    const activeSocket = socketRef.current;
    if (!activeSocket || !nextToken) return;

    const existingAuth = typeof activeSocket.auth === "object" && activeSocket.auth !== null ? activeSocket.auth : {};
    activeSocket.auth = {
      ...existingAuth,
      token: nextToken,
      clientSessionId: clientSessionIdRef.current
    };
  }, []);

  const stopDubbingPlayback = useCallback((clearQueue = true) => {
    dubbingRequestGenerationRef.current += 1;
    dubbingLifecycleRef.current?.stop({ clearQueue });
  }, []);

  if (!dubbingLifecycleRef.current && typeof window !== "undefined" && !speechSynthesisUnavailableReason()) {
    dubbingLifecycleRef.current = createDubbingLifecycle({
      prepare: (job: DubbingQueueItem) => {
        const utterance = new SpeechSynthesisUtterance(job.text);
        utterance.lang = speechLanguage(job.language);
        utterance.rate = job.text.length > 140 ? 0.94 : 0.98;
        utterance.pitch = 1;
        utterance.volume = 0.92;
        const voice = selectSpeechVoice(job.language);
        if (voice) utterance.voice = voice;
        return utterance;
      },
      play: (utterance: SpeechSynthesisUtterance, _job: DubbingQueueItem, onStart: () => void, onEnd: () => void, onError: () => void) => {
        utterance.onstart = onStart;
        utterance.onend = onEnd;
        utterance.onerror = (event) => {
          const reason = event.error || "unknown browser speech error";
          if (isExpectedSpeechCancellation(reason)) {
            setAlert((current) => current && /^Dubbing audio failed: (?:interrupted|cancell?ed)\.?$/i.test(current) ? null : current);
          } else {
            setAlert(`Dubbing audio failed: ${reason}.`);
          }
          onError();
        };
        try {
          if (window.speechSynthesis.paused) window.speechSynthesis.resume();
          window.speechSynthesis.speak(utterance);
        } catch (error) {
          setAlert(`Dubbing audio failed: ${error instanceof Error ? error.message : "speech synthesis could not start"}.`);
          throw error;
        }
      },
      cancel: () => window.speechSynthesis.cancel(),
      onGateChange: (gated: boolean) => {
        dubbingTransmissionGatedRef.current = gated;
        setDubbingPlaying(gated);
        setDubbingQueued(dubbingLifecycleRef.current?.snapshot().queued || 0);
      },
      onIdle: () => {
        setDubbingPlaying(false);
        setDubbingQueued(0);
      },
      maxAgeMs: DUBBING_UTTERANCE_TTL_MS
    });
  }

  const queueDubbingTranslations = useCallback((translationId: string, translations: Record<string, string>) => {
    if (modeRef.current !== "dubbing") return;
    const unavailableReason = speechSynthesisUnavailableReason();
    if (unavailableReason) {
      setAlert(`Dubbing is unavailable: ${unavailableReason}.`);
      return;
    }
    const requestGeneration = dubbingRequestGenerationRef.current;
    void loadSpeechVoices().then(() => {
      if (requestGeneration !== dubbingRequestGenerationRef.current || modeRef.current !== "dubbing") return;
      const createdAt = Date.now();
      const orderedLanguages = [...targetLanguagesRef.current, ...Object.keys(translations).filter((language) => !targetLanguagesRef.current.includes(language))];
      for (const language of orderedLanguages) {
        const text = translations[language];
        if (!isVisibleTranslationText(text)) continue;
        if (dubbingLifecycleRef.current?.enqueue({ translationId, language, text, createdAt })) {
          drainPendingLanguagesRef.current.delete(language);
          setTranslationsPending([...drainPendingLanguagesRef.current]);
          setDubbingQueued(dubbingLifecycleRef.current.snapshot().queued);
          if (!awaitingFinalTranscriptRef.current && drainPendingLanguagesRef.current.size === 0) finishDrainRef.current("processed");
        }
      }
    });
  }, []);

  const speakTranslatedCaption = useCallback((language: string, text: string) => {
    const spokenText = text.trim();
    if (!spokenText) return;
    stopDubbingPlayback(false);
    const unavailableReason = speechSynthesisUnavailableReason();
    if (unavailableReason) {
      setAlert(`Speech playback is unavailable: ${unavailableReason}.`);
      return;
    }
    const requestGeneration = dubbingRequestGenerationRef.current;
    void loadSpeechVoices().then(() => {
      if (requestGeneration !== dubbingRequestGenerationRef.current) return;
      const createdAt = Date.now();
      dubbingLifecycleRef.current?.enqueue({
        translationId: `manual-${createdAt}-${language}`,
        language,
        text: spokenText,
        createdAt
      });
    });
  }, [stopDubbingPlayback]);

  const navigate = useCallback(
    (nextView: View) => {
      const guarded = PROTECTED_VIEWS.has(nextView);
      const isAdmin = isAdminRole(user?.role);
      const resolvedView = nextView === "admin" && !isAdmin ? (isAuthed ? "dashboard" : "admin-login") : guarded && !isAuthed ? "login" : nextView;
      setView(resolvedView);
      window.history.replaceState(null, "", `#${resolvedView}`);
      setSettingsOpen(false);
    },
    [isAuthed, user?.role]
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
        const data = await requestApi<{ user: AppUser; token?: string }>("/api/auth/me", {}, activeToken);
        if (data.token) {
          tokenRef.current = data.token;
          setToken(data.token);
          localStorage.setItem("interp_shield_token", data.token);
          sessionStorage.removeItem("interp_shield_token");
          updateSocketAuth(data.token);
        }
        const normalizedUser = normalizeAuthUser(data.user) as AppUser;
        setUser(normalizedUser);
        localStorage.setItem("interp_shield_user", JSON.stringify(normalizedUser));
        sessionStorage.removeItem("interp_shield_user");
        applyUserSettings(normalizedUser.settings);
      } catch {
        clearSessionStorage();
        setToken(null);
        setUser(null);
        if (PROTECTED_VIEWS.has(view)) navigate("login");
      }
    },
    [navigate, token, updateSocketAuth, view]
  );

  useEffect(() => {
    if (!isRecording || user?.role !== "user" || !user.subscription || user.subscription.isUnlimited || user.subscription.trialSecondsRemaining == null) return undefined;
    // The 5-minute trial is server-authoritative and metered in the backend while the live
    // session is open; this just periodically re-reads that value so the countdown shown
    // here (and the block-on-zero check in startSession) never drifts far from the DB.
    const timer = window.setInterval(() => { void refreshMe(); }, 15000);
    return () => window.clearInterval(timer);
  }, [isRecording, refreshMe, user?.role, user?.subscription]);

  const updateSettings = async (settings: UserSettings) => {
    if (!token || !user) return;

    try {
      const data = await requestApi<{ user: AppUser }>("/api/user/settings", {
        method: "PATCH",
        body: JSON.stringify(settings)
      }, token);
      const normalizedUser = normalizeAuthUser(data.user) as AppUser;
      setUser(normalizedUser);
      localStorage.setItem("interp_shield_user", JSON.stringify(normalizedUser));
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
    if (!isAuthed) return undefined;

    const refreshAuthToken = async () => {
      const activeToken = tokenRef.current;
      if (!activeToken) return;

      try {
        const data = await requestApi<{ token: string; user: AppUser }>("/api/auth/refresh", { method: "POST" }, activeToken);
        tokenRef.current = data.token;
        setToken(data.token);
        const normalizedUser = normalizeAuthUser(data.user) as AppUser;
        setUser(normalizedUser);
        localStorage.setItem("interp_shield_token", data.token);
        localStorage.setItem("interp_shield_user", JSON.stringify(normalizedUser));
        sessionStorage.removeItem("interp_shield_token");
        sessionStorage.removeItem("interp_shield_user");
        updateSocketAuth(data.token);
      } catch {
        if (recordingRef.current) {
          setAlert("Your login session needs attention, but the live interpreter is still running.");
          return;
        }

        clearSessionStorage();
        setToken(null);
        setUser(null);
        if (PROTECTED_VIEWS.has(view)) navigate("login");
      }
    };

    const timer = window.setInterval(() => {
      void refreshAuthToken();
    }, AUTH_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshAuthToken);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshAuthToken);
    };
  }, [isAuthed, navigate, updateSocketAuth, view]);

  useEffect(() => {
    if (PROTECTED_VIEWS.has(view) && !isAuthed) navigate("login");
    if (view === "admin" && !isAdminRole(user?.role)) navigate(isAuthed ? "dashboard" : "admin-login");
  }, [isAuthed, navigate, user?.role, view]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    audioSourceRef.current = audioSource;
  }, [audioSource]);

  useEffect(() => {
    const tabSupported = isDesktopChrome() && isTabAudioCaptureSupported(typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);
    if (audioSource === "tab" && !tabSupported) setAudioSource("microphone");
  }, [audioSource]);

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
      const container = conversationHistoryRef.current;
      if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        return;
      }
      historyEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [visibleHistoryScrollSignature]);

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

  const rememberPendingFinalTranscript = useCallback((entry: PendingTranscriptEntry) => {
    for (const key of pendingTranscriptKeys(entry)) {
      pendingFinalTranscriptsRef.current.set(key, entry);
    }

    while (pendingFinalTranscriptsRef.current.size > MAX_PENDING_FINAL_TRANSCRIPTS) {
      const oldestKey = pendingFinalTranscriptsRef.current.keys().next().value;
      if (!oldestKey) break;
      pendingFinalTranscriptsRef.current.delete(oldestKey);
    }
  }, []);

  const forgetPendingFinalTranscript = useCallback((entry: Partial<PendingTranscriptEntry> | null) => {
    if (!entry) return;
    for (const key of pendingTranscriptKeys(entry)) {
      pendingFinalTranscriptsRef.current.delete(key);
    }
  }, []);

  const findPendingFinalTranscript = useCallback((entry: Partial<PendingTranscriptEntry>) => {
    for (const key of pendingTranscriptKeys(entry)) {
      const pending = pendingFinalTranscriptsRef.current.get(key);
      if (pending) return pending;
    }

    return null;
  }, []);

  const flushPendingPartialTranscript = useCallback(() => {
    const pending = pendingPartialTranscriptRef.current;
    if (!pending) return;

    pendingPartialTranscriptRef.current = null;
    lastSubtitleUpdateAtRef.current = Date.now();
    if (pending.detectedLanguage) setDetectedLanguage(pending.detectedLanguage);
    setLiveText(pending.text);
    setInterimOriginal(pending.text);

    setStatus((current) => current === "soft-pause" ? current : "speaking");
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

  const stopSilenceMonitor = useCallback(() => {
    if (silenceTimerRef.current) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const cleanupMedia = useCallback((options: { preserveRecoveryTimer?: boolean; preserveRestartAttempts?: boolean; preserveTranslationPipeline?: boolean; stopReason?: string; caller?: string } = {}) => {
    const speechSnapshot = utteranceLifecycleRef.current.snapshot();
    console.info("[SESSION_STOP_REASON]", { reason: options.stopReason || "session_cleanup", caller: options.caller || "cleanupMedia", recordingGeneration: speechSnapshot.recordingGeneration, elapsedSinceStartMs: speechSnapshot.elapsedSinceStartMs, speechStarted: speechSnapshot.speechStarted, meaningfulSpeechDetected: speechSnapshot.meaningfulSpeechDetected, lastMeaningfulSpeechAt: speechSnapshot.lastMeaningfulSpeechAt, silenceStartedAt: speechSnapshot.silenceStartedAt, silenceDurationMs: speechSnapshot.silenceDurationMs, finalizationRequested: speechSnapshot.finalizationRequested, chunksCaptured: speechSnapshot.chunksCaptured, chunksEmitted: speechSnapshot.chunksEmitted, lastAudioLevel: speechSnapshot.lastAudioLevel, threshold: speechSnapshot.threshold });
    if (vadPollTimerRef.current) {
      window.clearInterval(vadPollTimerRef.current);
      vadPollTimerRef.current = null;
    }
    utteranceBoundaryRef.current?.stop();
    utteranceBoundaryRef.current = null;
    if (captionWatchdogTimerRef.current) window.clearTimeout(captionWatchdogTimerRef.current);
    captionWatchdogTimerRef.current = null;
    vadControllerRef.current.stop();
    pendingSpeechChunksRef.current = [];
    getAudioLevelRef.current = () => 0;
    if (!options.preserveRecoveryTimer && audioRecoveryTimerRef.current) {
      window.clearTimeout(audioRecoveryTimerRef.current);
      audioRecoveryTimerRef.current = null;
    }
    if (!options.preserveRestartAttempts) {
      audioRestartAttemptsRef.current = 0;
    }
    recordingRef.current = false;
    utteranceLifecycleRef.current.stop();
    sessionReadyRef.current = false;
    setMicrophoneActive(false);
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive" && recorderStoppedForGenerationRef.current !== activeRecordingGenerationRef.current) {
      recorderStoppedForGenerationRef.current = activeRecordingGenerationRef.current;
      stopInFlightRef.current = true;
      recorderStopReasonRef.current = options.stopReason || "session_cleanup";
      recorder.stop();
    }
    setMediaRecorderActive(false);
    mediaRecorderRef.current = null;
    processedStreamRef.current?.getTracks().forEach((track) => track.stop());
    processedStreamRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    if (!options.preserveTranslationPipeline) {
      activeSessionPayloadRef.current = null;
      shouldRestartSessionOnReconnectRef.current = false;
    }
    sessionStartedAtRef.current = null;
    lastAudioChunkSentAtRef.current = 0;
    if (!options.preserveTranslationPipeline) {
      stopDubbingPlayback(true);
      lastTranslationOriginalRef.current = "";
      activeBackendSessionIdRef.current = "";
      activeBackendTranslationJobIdRef.current = "";
      latestTranslationSequenceRef.current = 0;
      completedTranslationSignaturesRef.current.clear();
      pendingFinalTranscriptRef.current = null;
      pendingFinalTranscriptsRef.current.clear();
    }
    queuedAudioChunksRef.current = [];
    queuedAudioDroppedRef.current = 0;
    stopSilenceMonitor();
    if (subtitleThrottleTimerRef.current) {
      window.clearTimeout(subtitleThrottleTimerRef.current);
      subtitleThrottleTimerRef.current = null;
    }
    if (interimTimerRef.current) {
      window.clearTimeout(interimTimerRef.current);
      interimTimerRef.current = null;
    }
    pendingPartialTranscriptRef.current = null;
    startInFlightRef.current = false;
  }, [stopDubbingPlayback, stopSilenceMonitor]);

  const finishDrain = useCallback((reason: "processed" | "timeout") => {
    const phase = utteranceLifecycleRef.current.snapshot().phase;
    if (!["draining", "finalizing"].includes(phase)) return;
    if (drainTimeoutRef.current) window.clearTimeout(drainTimeoutRef.current);
    drainTimeoutRef.current = null;
    awaitingFinalTranscriptRef.current = false;
    setAwaitingFinalTranscript(false);
    const stillPendingLanguages = [...drainPendingLanguagesRef.current];
    drainPendingLanguagesRef.current.clear();
    setTranslationsPending([]);
    const timeoutWithoutFinalOriginal = reason === "timeout" && !lastFinalOriginalRef.current;
    if (reason === "timeout") {
      // Section 6/7: a language that already completed must not be reverted just because a
      // DIFFERENT, slower target timed out — only the languages still actually pending revert to
      // "ready". "Translation did not finish" is reserved for a genuine total failure (zero
      // languages ever completed); if at least one did, that's shown instead, not blanked.
      const hasAnyCompletedTranslation = Object.keys(finalTranslationsRef.current).length > 0;
      const readyStatuses = Object.fromEntries(stillPendingLanguages.map((language) => [language, "ready" as TranslationLifecycleState]));
      setTranslationStatuses((current) => ({ ...current, ...readyStatuses }));
      setTranslationDiagnostics((current) => {
        if (stillPendingLanguages.length === 0) return current;
        const next = { ...current };
        for (const language of stillPendingLanguages) delete next[language];
        return next;
      });
      if (timeoutWithoutFinalOriginal) {
        setAlert("No final caption was received. Please try again.");
      } else if (!hasAnyCompletedTranslation) {
        setAlert("Translation did not finish. Please try again.");
      }
      // pendingFinalTranscriptRef/pendingFinalTranscriptsRef are intentionally left intact here
      // (not cleared): if the backend had already computed a result before end_session below
      // reaches it, that result can still arrive moments later — handleTranslationUpdate's
      // explicit pending-transcript match (independent of the "current" pointer) can still
      // recognize and commit it instead of it being silently unroutable. They still get
      // naturally replaced by the next utterance's own pendingEntry, or evicted by the
      // MAX_PENDING_FINAL_TRANSCRIPTS cap, so nothing accumulates unbounded.
    }
    utteranceLifecycleRef.current.setPhase("finalizing");
    try {
      cleanupMedia({ preserveTranslationPipeline: true, stopReason: `drain_${reason}`, caller: "finishDrain" });
      socketRef.current?.emit("end_session", { reason });
      activeSessionPayloadRef.current = null;
      activeBackendSessionIdRef.current = "";
      activeBackendTranslationJobIdRef.current = "";
    } finally {
      // A completed mobile utterance must always land back at a pressable idle state, even if
      // cleanup above threw — otherwise the mic button silently stops responding to the next
      // press with no visible error, exactly the "poisoned next start" failure mode.
      sessionActionInFlightRef.current = false;
      setAudioDiagnostic({ state: "idle", message: "Microphone ready" });
      setStatus("idle");
      utteranceLifecycleRef.current.resetToIdle();
      stopInFlightRef.current = false;
    }
    void refreshMe();
  }, [cleanupMedia, refreshMe]);
  finishDrainRef.current = finishDrain;

  // Desktop's continue-listening drain never destroys the recorder/session, so it can't rely
  // on finishDrain's teardown-based timeout to recover from an utterance whose final
  // transcript never arrives (e.g. Deepgram genuinely found no speech to transcribe). Without
  // this, awaitingFinalTranscriptRef would stay stuck forever, permanently blocking every
  const beginDrain = useCallback((reason = "vad_sustained_silence", generation = activeRecordingGenerationRef.current) => {
    if (!recordingRef.current) return false;
    if (generation !== activeRecordingGenerationRef.current) return false;

    // Desktop live mode keeps ONE continuous MediaRecorder/stream/socket/Deepgram session for
    // the whole live session: an ordinary sustained-silence utterance boundary never stops the
    // recorder. It only requests the current buffer be flushed and arms utteranceBoundaryRef
    // to emit the audio_utterance_end boundary once that flush is confirmed captured (see the
    // onBoundary wiring below, which also resets VAD/utterance-lifecycle state for the next
    // sentence). Only an explicit user Stop reaches the full-teardown path further below.
    const continueListening = reason === "vad_sustained_silence" && isDesktopChrome() && !explicitStopRequestedRef.current;
    if (continueListening) {
      const transition = utteranceLifecycleRef.current.requestFinalization(reason, generation);
      if (!transition.accepted) return false;
      const recorder = mediaRecorderRef.current;
      console.info("[UTTERANCE_FINALIZATION]", { reason: transition.reason, recordingGeneration: generation, phaseBefore: transition.phaseBefore, phaseAfter: transition.phaseAfter, recorderState: recorder?.state, continuousDesktopSession: true });
      if (recorder?.state === "recording") {
        try { recorder.requestData(); } catch { /* MediaRecorder may already be mid-flush. */ }
        const armed = utteranceBoundaryRef.current?.request({ sequence: sequenceRef.current, capturedAt: Date.now(), speechThreshold: utteranceLifecycleRef.current.snapshot().threshold }) ?? false;
        if (!armed) {
          // A boundary was already pending (should not happen given requestFinalization's own
          // phase guard, but stay safe): fall back to resetting for the next utterance directly.
          const sessionId = utteranceLifecycleRef.current.snapshot().sessionId;
          vadControllerRef.current.markPaused();
          utteranceLifecycleRef.current.start({ now: Date.now(), recordingGeneration: generation, sessionId });
          setStatus("listening");
          setAudioDiagnostic((current) => ({ ...current, state: "recording", message: "Listening" }));
        }
      }
      return true;
    }

    // Mobile (and any desktop path outside ordinary sustained-silence, e.g. an explicit Stop
    // already in progress) fully finalizes this utterance: stop capture, wait for the
    // transcript/translation to resolve, then return to idle.
    if (awaitingFinalTranscriptRef.current) return false;
    const transition = utteranceLifecycleRef.current.requestFinalization(reason, generation);
    if (!transition.accepted) return false;
    awaitingFinalTranscriptRef.current = true;
    setAwaitingFinalTranscript(true);
    drainPendingLanguagesRef.current.clear();
    setTranslationsPending([]);
    setStatus("draining");
    setAudioDiagnostic((current) => ({ ...current, state: "ready", message: "Finishing recording" }));
    const recorder = mediaRecorderRef.current;
    console.info("[UTTERANCE_FINALIZATION]", { reason: transition.reason, recordingGeneration: generation, phaseBefore: transition.phaseBefore, phaseAfter: transition.phaseAfter, recorderState: recorder?.state, transcriptPending: true, translationsPending: drainPendingLanguagesRef.current.size });
    if (recorder?.state === "recording") {
      try { recorder.requestData(); } catch { /* MediaRecorder may already be stopping. */ }
      if (recorderStoppedForGenerationRef.current !== activeRecordingGenerationRef.current) {
        recorderStoppedForGenerationRef.current = activeRecordingGenerationRef.current;
        recorderStopReasonRef.current = reason;
        recorder.stop();
      }
    }
    recordingRef.current = false;
    setMicrophoneActive(false);
    setMediaRecorderActive(false);
    processedStreamRef.current?.getTracks().forEach((track) => track.stop());
    processedStreamRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    if (vadPollTimerRef.current) window.clearInterval(vadPollTimerRef.current);
    vadPollTimerRef.current = null;
    vadControllerRef.current.stop();
    drainTimeoutRef.current = window.setTimeout(() => finishDrain("timeout"), RECORDING_DRAIN_TIMEOUT_MS);
    return true;
  }, [finishDrain]);

  const scheduleAudioRecovery = useCallback((reason: string) => {
    const phase = utteranceLifecycleRef.current.snapshot().phase;
    if (!recordingRef.current || phase === "draining" || phase === "finalizing") return;
    logFrontendDebug("audio", "AUDIO_RECOVERY_BLOCKED", { reason, recordingGeneration: activeRecordingGenerationRef.current });
    const isTabSource = audioSourceRef.current === "tab";
    const failureMessage = isTabSource ? "Tab/system audio sharing stopped unexpectedly." : "Microphone stopped unexpectedly.";
    const alertMessage = isTabSource
      ? `${failureMessage} Select Tab / System Audio and press the microphone to start a new session.`
      : `${failureMessage} Press the microphone to try again.`;
    setAudioDiagnostic({ state: "failed", message: failureMessage, lastRestartReason: reason });
    setAlert(alertMessage);
    try {
      cleanupMedia({ stopReason: reason });
      socketRef.current?.emit("end_session", { reason });
    } finally {
      // Whatever cleanup did, the session must land back in a pressable idle state — never
      // stuck mid-recovery, which would permanently block the next Start.
      setStatus("idle");
      utteranceLifecycleRef.current.resetToIdle();
      stopInFlightRef.current = false;
    }
  }, [cleanupMedia]);

  const emitAudioChunkPayload = useCallback((payload: AudioChunkPayload) => {
    const activeSocket = socketRef.current;

    if (activeSocket?.connected) {
      activeSocket.emit("audio_chunk", payload);
      console.info("[AUDIO_CHUNK_EMITTED]", { sequence: payload.sequence, bytes: payload.audio.size, socketConnected: activeSocket.connected, sessionReady: sessionReadyRef.current });
      if (payload.sequence === 1 || payload.sequence % 25 === 0) {
        logFrontendDebug("audio", "AUDIO_CHUNK_SENT", {
          sequence: payload.sequence,
          mimeType: payload.mimeType,
          audioLevel: payload.audioLevel
        });
      }
      return true;
    }

    const nextQueue = [...queuedAudioChunksRef.current, payload];
    if (nextQueue.length > MAX_QUEUED_AUDIO_CHUNKS) {
      queuedAudioDroppedRef.current += nextQueue.length - MAX_QUEUED_AUDIO_CHUNKS;
    }
    queuedAudioChunksRef.current = nextQueue.slice(-MAX_QUEUED_AUDIO_CHUNKS);
    logFrontendDebug("audio", "AUDIO_CHUNK_QUEUED", {
      sequence: payload.sequence,
      queued: queuedAudioChunksRef.current.length,
      dropped: queuedAudioDroppedRef.current
    });
    return false;
  }, []);

  const flushQueuedAudioChunks = useCallback(() => {
    const activeSocket = socketRef.current;
    if (!activeSocket?.connected || queuedAudioChunksRef.current.length === 0) return;

    const queuedChunks = queuedAudioChunksRef.current.splice(0, queuedAudioChunksRef.current.length);
    logFrontendDebug("socket", "AUDIO_CHUNKS_FLUSHED", { count: queuedChunks.length });
    for (const chunk of queuedChunks) {
      activeSocket.emit("audio_chunk", chunk);
    }
  }, []);

  const stopSession = useCallback(() => {
    if (status === "stopping" || stopInFlightRef.current) return;
    explicitStopRequestedRef.current = true;
    stopInFlightRef.current = true;
    sessionActionInFlightRef.current = true;
    setStatus("stopping");
    try {
      cleanupMedia({ stopReason: "explicit_user_stop", caller: "stopSession" });
      if (drainTimeoutRef.current) window.clearTimeout(drainTimeoutRef.current);
      drainTimeoutRef.current = null;
      awaitingFinalTranscriptRef.current = false;
      setAwaitingFinalTranscript(false);
      drainPendingLanguagesRef.current.clear();
      setTranslationsPending([]);
      socketRef.current?.emit("end_session");
    } finally {
      // However cleanup went, the mic button must never stay stuck disabled on "stopping" —
      // that would silently block every future press with no way to recover but a page reload.
      sessionActionInFlightRef.current = false;
      setAudioDiagnostic({ state: "idle", message: "Microphone ready" });
      setStatus("idle");
      utteranceLifecycleRef.current.resetToIdle();
      stopInFlightRef.current = false;
    }
    void refreshMe();
  }, [cleanupMedia, refreshMe, status]);

  useEffect(() => {
    if (!isAuthed || !tokenRef.current) return undefined;

    if (!API) {
      setAlert("Backend API URL is missing. Set VITE_API_URL and restart the frontend.");
      return undefined;
    }

    if (!SOCKET_URL) {
      setAlert("Backend socket URL is missing. Set VITE_SOCKET_URL and restart the frontend.");
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
      lastServerHeartbeatAtRef.current = Date.now();
      clientHeartbeatTimerRef.current = window.setInterval(() => {
        if (socketRef.current?.connected) {
          socketRef.current.emit("ping", { timestamp: Date.now() });
        }
        if (
          recordingRef.current &&
          socketRef.current?.connected &&
          lastServerHeartbeatAtRef.current &&
          Date.now() - lastServerHeartbeatAtRef.current > SOCKET_HEARTBEAT_STALE_MS
        ) {
          logFrontendDebug("socket", "SOCKET_HEARTBEAT_STALE", {
            ageMs: Date.now() - lastServerHeartbeatAtRef.current
          });
          setSocketReconnecting(true);
          shouldRestartSessionOnReconnectRef.current = true;
          const activeSocket = socketRef.current;
          updateSocketAuth();
          const engine = activeSocket?.io.engine as { close?: () => void } | undefined;
          if (engine?.close) {
            engine.close();
          } else {
            activeSocket?.disconnect();
            activeSocket?.connect();
          }
        }
      }, CLIENT_HEARTBEAT_MS);
    };

    const socket = io(SOCKET_URL, {
      auth: {
        token: tokenRef.current,
        clientSessionId: clientSessionIdRef.current
      },
      transports: [...SOCKET_TRANSPORTS],
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: MAX_SOCKET_RECONNECT_ATTEMPTS,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.35,
      timeout: 20000,
      autoConnect: true
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      logFrontendDebug("socket", "SOCKET_CONNECTED", { id: socket.id, url: SOCKET_URL });
      setSocketConnected(true);
      setSocketReconnecting(false);
      lastServerHeartbeatAtRef.current = Date.now();
      startClientHeartbeat();
      setAlert((current) => (current === "Unable to reach InterpShield. Please try again." ? null : current));
      setTranslationStatuses((current) => {
        const recovered: Record<string, TranslationLifecycleState> = {};
        for (const [language, state] of Object.entries(current)) {
          const stateTyped = state as any;
          recovered[language] = stateTyped === "failed" || stateTyped === "stale" || stateTyped === "cancelled" ? "retrying" : stateTyped;
          translationStatusUpdatedAtRef.current[language] = Date.now();
        }
        return recovered;
      });

      if (shouldRestartSessionOnReconnectRef.current && activeSessionPayloadRef.current) {
        shouldRestartSessionOnReconnectRef.current = false;
        socket.timeout(30000).emit("start_session", activeSessionPayloadRef.current, (timeoutError: Error | null, response?: { ok?: boolean; error?: string }) => {
          if (timeoutError || response?.error) {
            shouldRestartSessionOnReconnectRef.current = true;
            setSocketReconnecting(true);
            setAlert(response?.error || "Unable to resume the live interpreter.");
          }
        });
      }
    });

    socket.on("disconnect", () => {
      logFrontendDebug("socket", "SOCKET_DISCONNECTED", { recording: recordingRef.current });
      stopClientHeartbeat();
      setSocketConnected(false);
      if (recordingRef.current) {
        // Audio captured for the old backend session must never be replayed
        // into the fresh interpreter session created after reconnect.
        queuedAudioChunksRef.current = [];
        queuedAudioDroppedRef.current = 0;
        const recorder = mediaRecorderRef.current;
        if (recorder?.state === "recording") {
          try {
            recorder.pause();
            setMediaRecorderActive(false);
          } catch (error) {
            logFrontendDebug("audio", "RECORDER_PAUSE_ON_DISCONNECT_FAILED", {
              message: error instanceof Error ? error.message : String(error)
            });
          }
        }
        setSocketReconnecting(true);
        shouldRestartSessionOnReconnectRef.current = true;
        setStatus("connecting");
        updateTranslationStatuses(
          Object.fromEntries(targetLanguagesRef.current.map((language) => [language, "retrying"]))
        );
      }
    });

    socket.on("connect_error", (error) => {
      logFrontendDebug("socket", "SOCKET_CONNECT_ERROR", { message: error?.message });
      setSocketConnected(false);
      setSocketReconnecting(recordingRef.current);
      if (recordingRef.current) setAlert("Unable to reach the live interpreter.");
      const authFailed = /auth|token|session|required|expired|unauthori[sz]ed/i.test(error?.message || "");
      if (authFailed && tokenRef.current && !socketAuthRefreshInFlightRef.current) {
        socketAuthRefreshInFlightRef.current = true;
        void requestApi<{ token: string; user: AppUser }>("/api/auth/refresh", { method: "POST" }, tokenRef.current)
          .then((data) => {
            tokenRef.current = data.token;
            setToken(data.token);
            const normalizedUser = normalizeAuthUser(data.user) as AppUser;
            setUser(normalizedUser);
            localStorage.setItem("interp_shield_token", data.token);
            localStorage.setItem("interp_shield_user", JSON.stringify(normalizedUser));
            sessionStorage.removeItem("interp_shield_token");
            sessionStorage.removeItem("interp_shield_user");
            updateSocketAuth(data.token);
            if (!socket.connected) socket.connect();
          })
          .catch(() => undefined)
          .finally(() => {
            socketAuthRefreshInFlightRef.current = false;
          });
      }
    });

    const handleReconnectAttempt = () => {
      updateSocketAuth();
      logFrontendDebug("socket", "SOCKET_RECONNECT_ATTEMPT", {});
      console.info("[DESKTOP_PIPELINE_SOCKET_RECONNECT]", { state: "attempt" });
      if (recordingRef.current) setSocketReconnecting(true);
    };
    const handleReconnect = () => {
      logFrontendDebug("socket", "SOCKET_RECONNECTED", {});
      console.info("[DESKTOP_PIPELINE_SOCKET_RECONNECT]", { state: "connected" });
      setSocketReconnecting(false);
    };
    const handleReconnectError = () => {
      logFrontendDebug("socket", "SOCKET_RECONNECT_ERROR", {});
      if (recordingRef.current) setSocketReconnecting(true);
    };
    socket.io.on("reconnect_attempt", handleReconnectAttempt);
    socket.io.on("reconnect", handleReconnect);
    socket.io.on("reconnect_error", handleReconnectError);

    socket.on("server-config", (serverConfig: AppConfig) => setConfig(serverConfig));
    socket.on("session:heartbeat", () => {
      lastServerHeartbeatAtRef.current = Date.now();
      socket.emit("session:pong", { ts: Date.now() });
    });
    socket.on("pong", () => {
      lastServerHeartbeatAtRef.current = Date.now();
    });

    const handleDeepgramStreamReset = ({ generation }: { generation?: number }) => {
      const nextGeneration = Number(generation);
      if (!recordingRef.current || utteranceLifecycleRef.current.snapshot().phase !== "listening" || !Number.isFinite(nextGeneration) || nextGeneration <= lastHandledDeepgramGenerationRef.current) return;
      lastHandledDeepgramGenerationRef.current = nextGeneration;
      const recorder = mediaRecorderRef.current;
      pendingAudioStreamGenerationRef.current = nextGeneration;
      queuedAudioChunksRef.current = [];
      pendingSpeechChunksRef.current = [];
      recorderGenerationRestartRef.current = true;
      console.info("[AUDIO_STREAM_GENERATION_RESET]", { sessionId: clientSessionIdRef.current, oldGeneration: audioStreamGenerationRef.current, newGeneration: nextGeneration, recorderState: recorder?.state });
      if (recorder?.state === "recording" || recorder?.state === "paused") {
        recorderStopReasonRef.current = "deepgram_generation_change";
        recorder.stop();
      } else if (recorder?.state === "inactive") {
        audioStreamGenerationRef.current = nextGeneration;
        awaitingContainerHeaderRef.current = true;
        containerHeaderProbeFailuresRef.current = 0;
        recorderGenerationRestartRef.current = false;
        const previousState = recorder.state;
        console.info("[MEDIARECORDER_START_REQUEST]", { reason: "deepgram_generation_change", recordingGeneration: activeRecordingGenerationRef.current, previousState });
        recorder.start(audioChunkMsRef.current);
        console.info("[MEDIARECORDER_STARTED]", { reason: "deepgram_generation_change", recordingGeneration: activeRecordingGenerationRef.current, sessionId: activeSessionIdRef.current || clientSessionIdRef.current, previousState, mimeType: recorder.mimeType, streamGeneration: nextGeneration });
      }
    };
    socket.on("deepgram_stream_reset", handleDeepgramStreamReset);

    const markSessionReady = (payload?: { recordingGeneration?: number; sessionId?: string }) => {
      const readyGeneration = Number(payload?.recordingGeneration || activeSessionPayloadRef.current?.recordingGeneration);
      const currentPhase = utteranceLifecycleRef.current.snapshot().phase;
      const initialReady = currentPhase === "listening" && !sessionReadyRef.current;
      if (!Number.isFinite(readyGeneration) || readyGeneration !== activeRecordingGenerationRef.current || !["listening", "idle"].includes(currentPhase)) {
        console.info("[SESSION_START_ACK_IGNORED]", { readyGeneration, activeGeneration: activeRecordingGenerationRef.current, phase: currentPhase });
        return;
      }
      sessionActionInFlightRef.current = false;
      startInFlightRef.current = false;
      sessionReadyRef.current = true;
      activeSessionIdRef.current = payload?.sessionId || activeSessionIdRef.current;
      utteranceLifecycleRef.current.setSessionId(activeSessionIdRef.current || clientSessionIdRef.current);
      const recorder = mediaRecorderRef.current;
      if (initialReady && recorder?.state === "inactive" && recorderStartedForGenerationRef.current !== readyGeneration) {
        recorderStartedForGenerationRef.current = readyGeneration;
        recordingRef.current = true;
        console.info("[MEDIARECORDER_START_REQUEST]", { reason: "session_ready", recordingGeneration: readyGeneration, previousState: "inactive" });
        recorder.start(audioChunkMsRef.current);
        console.info("[MEDIARECORDER_STARTED]", { reason: "session_ready", recordingGeneration: readyGeneration, sessionId: activeSessionIdRef.current || clientSessionIdRef.current, previousState: "inactive", mimeType: recorder.mimeType, streamGeneration: audioStreamGenerationRef.current });
        setMicrophoneActive(true);
        setMediaRecorderActive(true);
      } else if (recorder?.state === "paused") {
        recorder.resume();
        setMicrophoneActive(true);
        setMediaRecorderActive(true);
      }
      const previousStartedAt = sessionStartedAtRef.current;
      sessionStartedAtRef.current = stableSessionStartTime(previousStartedAt);
      if (!previousStartedAt) setSessionSeconds(0);
      flushQueuedAudioChunks();
      audioRestartAttemptsRef.current = 0;
      setAudioDiagnostic((current) => ({
        ...current,
        state: "recording",
        message: "Listening",
        lastError: undefined
      }));
      setStatus("listening");
      utteranceLifecycleRef.current.setPhase("listening");
      if (initialReady) {
        if (captionWatchdogTimerRef.current) window.clearTimeout(captionWatchdogTimerRef.current);
        utteranceLifecycleRef.current.start({ now: Date.now(), recordingGeneration: readyGeneration, sessionId: activeSessionIdRef.current || clientSessionIdRef.current });
        utteranceLifecycleRef.current.setPhase("listening");
        const checkNoMeaningfulSpeech = () => {
          captionWatchdogTimerRef.current = null;
          const lifecycle = utteranceLifecycleRef.current.snapshot();
          if (activeRecordingGenerationRef.current !== readyGeneration || lifecycle.phase !== "listening" || lifecycle.meaningfulSpeechDetected) return;
          if (!utteranceLifecycleRef.current.shouldStopForNoSpeech()) {
            captionWatchdogTimerRef.current = window.setTimeout(checkNoMeaningfulSpeech, utteranceLifecycleRef.current.nextCheckDelay());
            return;
          }
          cleanupMedia({ stopReason: "no_meaningful_speech_timeout", caller: "noSpeechTimer" });
          socketRef.current?.emit("end_session", { reason: "no_meaningful_speech_timeout" });
          setAudioDiagnostic({ state: "idle", message: "No speech detected. Microphone ready" });
          setStatus("idle");
          utteranceLifecycleRef.current.resetToIdle();
          stopInFlightRef.current = false;
        };
        captionWatchdogTimerRef.current = window.setTimeout(checkNoMeaningfulSpeech, isDesktopChrome() ? utteranceLifecycleRef.current.nextCheckDelay() : CAPTION_WATCHDOG_MS);
      }
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
      const errorMessage = message || "Real-time processing failed.";
      const startupOrAuthError = /auth|token|required|unable to start|missing deepgram|live interpreter/i.test(errorMessage);
      if (recordingRef.current && !startupOrAuthError) {
        setAlert(errorMessage);
        setStatus("listening");
        return;
      }
      setStatus("error");
      setAlert(errorMessage);
    };

    socket.on("session_error", handleSessionError);
    socket.on("app-error", handleSessionError);
    socket.on("trial_expired", ({ message }: { message?: string }) => {
      if (recordingRef.current) stopSession();
      setAlert(message || "Your 5-minute free trial has ended. Choose a plan to continue using InterpShield.");
      navigate("subscription");
    });

    const trackLatency = (latency?: number, provider?: string) => {
      if (typeof latency === "number" && provider) {
        setLatencyHistory(prev => [...prev, { provider, latency, time: Date.now() }].slice(-100));
      }
    };

    socket.on("transcript_partial", ({ text, detectedLanguage, providerFinal, speechFinal, utteranceEnd, speechStarted }: { text?: string; detectedLanguage?: string; providerFinal?: boolean; speechFinal?: boolean; utteranceEnd?: boolean; speechStarted?: boolean }) => {
      const originalText = text?.trim() || "";
      if (captionWatchdogTimerRef.current) window.clearTimeout(captionWatchdogTimerRef.current);
      captionWatchdogTimerRef.current = null;
      logFrontendDebug("audio", "TRANSCRIPT_PARTIAL_RECEIVED", { chars: originalText.length, providerFinal, speechFinal, utteranceEnd });
      vadControllerRef.current.noteTranscript(originalText, { providerFinal, speechFinal, utteranceEnd });
      if (originalText) {
        utteranceLifecycleRef.current.confirmMeaningfulSpeech();
      }
      if (speechStarted && vadControllerRef.current.getState() === "soft-pause") {
        setStatus("speaking");
      }
      if (!originalText || originalText === lastInterimRef.current) return;

      lastInterimRef.current = originalText;
      schedulePartialTranscript({ text: originalText, detectedLanguage });
    });

    socket.on("transcript_final", ({ text, sessionId, jobId, sequence, detectedLanguage, latencyMs, provider, sourceLang: eventSourceLang, targetLang: eventTargetLang, targetLanguages: eventTargetLanguages }: { text?: string; sessionId?: string; jobId?: string | number; sequence?: number; detectedLanguage?: string; latencyMs?: number; provider?: string; sourceLang?: string; targetLang?: string; targetLanguages?: string[] }) => {
      if (sessionId && activeSessionIdRef.current && sessionId !== activeSessionIdRef.current) return;
      const originalText = text?.trim() || "";
      if (captionWatchdogTimerRef.current) window.clearTimeout(captionWatchdogTimerRef.current);
      captionWatchdogTimerRef.current = null;
      logFrontendDebug("audio", "TRANSCRIPT_FINAL_RECEIVED", { chars: originalText.length, sequence, jobId });
      console.info("[DESKTOP_PIPELINE_SPEECH_FINAL]", { sessionId, jobId, sequence, chars: originalText.length });
      const transcriptEventKey = `${sessionId || "session"}:${jobId ?? "job"}:${sequence ?? "sequence"}`;
      if (!originalText || transcriptEventKey === lastFinalTranscriptEventKeyRef.current) return;
      console.info("[UTTERANCE_FINALIZED]", { sessionId, utteranceId: transcriptEventKey, lifecyclePhase: "transcribing", reason: "stt_final_received" });
      if (detectedLanguage) setDetectedLanguage(detectedLanguage);
      if (typeof latencyMs === "number") setLastLatency(latencyMs);
      trackLatency(latencyMs, provider);

      lastInterimRef.current = "";
      lastFinalOriginalRef.current = originalText;
      lastFinalTranscriptEventKeyRef.current = transcriptEventKey;
      pendingPartialTranscriptRef.current = null;
      if (subtitleThrottleTimerRef.current) {
        window.clearTimeout(subtitleThrottleTimerRef.current);
        subtitleThrottleTimerRef.current = null;
      }
      const pendingTargetLanguages = normalizeTargetLanguages(eventTargetLanguages, eventTargetLang || targetLangRef.current);
      const lastTranslationOriginal = lastTranslationOriginalRef.current;
      const normalizedFinalOriginal = originalText.toLowerCase().replace(/\s+/g, " ").trim();
      const normalizedTranslationOriginal = lastTranslationOriginal.toLowerCase().replace(/\s+/g, " ").trim();
      const keepStreamingTranslation =
        normalizedTranslationOriginal &&
        (normalizedFinalOriginal.includes(normalizedTranslationOriginal) || normalizedTranslationOriginal.includes(normalizedFinalOriginal));
      const alreadyTranslatedLanguages = new Set(keepStreamingTranslation ? Object.keys(finalTranslationsRef.current) : []);
      const pendingLanguages = pendingTargetLanguages.filter((language) => !alreadyTranslatedLanguages.has(language));
      drainPendingLanguagesRef.current = new Set(modeRef.current === "transcribe" ? [] : pendingLanguages);
      if (drainPendingLanguagesRef.current.size > 0) setStatus("translating");
      const timestamp = new Date().toISOString();
      const transcriptSequence = Number(sequence);
      const translationId = `${timestamp}-${originalText.slice(0, 48)}`;
      const pendingEntry: PendingTranscriptEntry = {
        original: originalText,
        timestamp,
        sourceLang: detectedLanguage || eventSourceLang || sourceLangRef.current,
        targetLang: eventTargetLang || pendingTargetLanguages[0],
        targetLanguages: pendingTargetLanguages,
        sessionId,
        jobId,
        sequence: Number.isFinite(transcriptSequence) ? transcriptSequence : undefined,
        translationId
      };
      pendingFinalTranscriptRef.current = pendingEntry;
      rememberPendingFinalTranscript(pendingEntry);
      activeTranslationIdRef.current = translationId;
      console.info("[UTTERANCE_CREATED]", { sessionId, utteranceId: translationId, lifecyclePhase: "transcribing", reason: "transcript_final" });
      if (drainPendingLanguagesRef.current.size > 0) {
        for (const language of drainPendingLanguagesRef.current) {
          console.info("[TRANSLATION_REQUESTED]", { sessionId, utteranceId: translationId, targetLanguage: language, lifecyclePhase: "translating", reason: "transcript_final" });
        }
      }
      if (sessionId && activeBackendSessionIdRef.current !== sessionId) {
        activeBackendSessionIdRef.current = sessionId;
        latestTranslationSequenceRef.current = 0;
      }
      activeBackendTranslationJobIdRef.current = jobId || "";
      if (Number.isFinite(transcriptSequence)) {
        latestTranslationSequenceRef.current = transcriptSequence;
      }
      updateTranslationStatuses(Object.fromEntries(pendingLanguages.map((language) => [language, "queued"])));
      setInterimOriginal("");
      setLiveText("");
      setFinalText((current) => appendTextWindow(current, originalText));
      setOriginalSegments((current) => [...current, originalText].slice(-MAX_LIVE_SEGMENTS));
      if (!keepStreamingTranslation) {
        // A genuinely new utterance is starting: freeze whatever the previous utterance had
        // accumulated into the rolling window before resetting the "current utterance" slot —
        // otherwise a translation that hadn't rendered yet (still in flight when this utterance
        // boundary landed) would be silently discarded instead of shown.
        const previousTranslations = finalTranslationsRef.current;
        if (Object.keys(previousTranslations).length > 0) {
          setTranslatedTextWindow((current) => {
            const next = { ...current };
            for (const [language, text] of Object.entries(previousTranslations)) {
              const trimmed = text?.trim();
              if (trimmed) next[language] = appendTextWindow(next[language] || "", trimmed);
            }
            return next;
          });
        }
        finalTranslationsRef.current = {};
        lastFinalTranslationRef.current = "";
        setFinalTranslations({});
        setTranslationStatuses(Object.fromEntries(pendingTargetLanguages.map((language) => [language, "queued" as TranslationLifecycleState])));
      }
      lastCompletedTranslationRef.current = "";

      if (modeRef.current === "transcribe") {
        forgetPendingFinalTranscript(pendingEntry);
        pendingFinalTranscriptRef.current = null;
        finishDrainRef.current("processed");
      } else if (awaitingFinalTranscriptRef.current) {
        awaitingFinalTranscriptRef.current = false;
        setAwaitingFinalTranscript(false);
        setStatus("translating");
        setAudioDiagnostic((current) => ({ ...current, state: "ready", message: "Finishing translations" }));
        // The STT final has now arrived — the only remaining work is translation, a separate,
        // provider-latency-bound step. Re-arm the drain timeout with a bound sized for that work
        // (base + a per-language allowance) instead of leaving whatever was left of the
        // STT-oriented RECORDING_DRAIN_TIMEOUT_MS window, so 2-3 target languages under normal
        // provider latency are not killed by a clock meant to catch a missing STT final.
        if (drainPendingLanguagesRef.current.size > 0) {
          if (drainTimeoutRef.current) window.clearTimeout(drainTimeoutRef.current);
          const translationBudgetMs = TRANSLATION_DRAIN_TIMEOUT_MS + Math.max(0, drainPendingLanguagesRef.current.size - 1) * TRANSLATION_DRAIN_PER_LANGUAGE_MS;
          drainTimeoutRef.current = window.setTimeout(() => finishDrainRef.current("timeout"), translationBudgetMs);
        }
      }
    });

    socket.on("result", (payload: any) => {
      if (payload.type === "admin_stats") {
        setAdminStats(payload.stats);
      }
    });

    const handleTranslationUpdate = ({ original, text, translations, statusByLanguage, failedLanguages, diagnostics, diagnosticsByLanguage, latencyMs, provider, sessionId, jobId, sequence, sourceLang: eventSourceLang, targetLang: eventTargetLang, targetLanguages: eventTargetLanguages, partial, complete, streaming, lang, status }: { original?: string; text?: string; translations?: Record<string, string>; statusByLanguage?: Record<string, string>; failedLanguages?: string[]; diagnostics?: TranslationProviderDiagnostic | null; diagnosticsByLanguage?: Record<string, TranslationProviderDiagnostic>; latencyMs?: number; provider?: string; sessionId?: string; jobId?: string | number; sequence?: number; sourceLang?: string; targetLang?: string; targetLanguages?: string[]; partial?: boolean; complete?: boolean; streaming?: boolean; lang?: string; status?: string }) => {
      const currentPendingTranscript = pendingFinalTranscriptRef.current;
      const updateOriginal = original?.trim() || "";
      const previewJob = typeof jobId === "string" && jobId.startsWith("preview-");
      const streamingPreview = Boolean(streaming || previewJob);
      console.info("[DESKTOP_PIPELINE_TRANSLATION_RECEIVED]", { sessionId, jobId, sequence, original: updateOriginal, languages: Object.keys(translations || {}), status, partial, complete });
      for (const language of Object.keys(translations || {})) {
        console.info("[TRANSLATION_RECEIVED]", { sessionId, utteranceId: jobId ?? sequence ?? "unknown", targetLanguage: language, lifecyclePhase: complete !== false && !partial ? "completed" : "translating", reason: "socket_event" });
      }

      if (sessionId && activeBackendSessionIdRef.current && sessionId !== activeBackendSessionIdRef.current) {
        console.info("[TRANSLATION_REJECTED]", { sessionId, utteranceId: jobId ?? sequence ?? "unknown", lifecyclePhase: "unknown", reason: "session_mismatch" });
        return;
      }
      if (sessionId && !activeBackendSessionIdRef.current) {
        activeBackendSessionIdRef.current = sessionId;
      }

      const incomingSequence = Number(sequence);
      // The explicit lookup (by session/job/sequence/original text) is a strictly stronger
      // signal than "whatever the current pending transcript happens to be" — an event that
      // explicitly matches a still-tracked utterance is valid regardless of whether a newer
      // utterance has since become current (see the sequence-staleness exemption below). Section
      // 8's stale-event rule: only reject when the session/utterance truly no longer exists, or
      // it's an older revision of the exact same target — never merely because the global
      // "current" pointer has moved on.
      const explicitPendingMatch = streamingPreview
        ? null
        : findPendingFinalTranscript({
            sessionId,
            jobId,
            sequence: Number.isFinite(incomingSequence) ? incomingSequence : undefined,
            original: updateOriginal
          });
      const matchedPendingTranscript = streamingPreview ? currentPendingTranscript : explicitPendingMatch || currentPendingTranscript;
      const preFinalTranslation = Boolean(
        !streamingPreview &&
        updateOriginal &&
        !matchedPendingTranscript &&
        !currentPendingTranscript &&
        ((Number.isFinite(incomingSequence) && incomingSequence > latestTranslationSequenceRef.current) ||
          (!Number.isFinite(incomingSequence) && Boolean(jobId) && !activeBackendTranslationJobIdRef.current))
      );
      const sequenceIsStale = Number.isFinite(incomingSequence) && incomingSequence < latestTranslationSequenceRef.current && !streamingPreview && !preFinalTranslation && !explicitPendingMatch;
      if (sequenceIsStale) {
        console.info("[TRANSLATION_REJECTED]", { sessionId, utteranceId: jobId ?? sequence ?? "unknown", lifecyclePhase: "unknown", reason: "older_revision_of_same_target" });
        return;
      }
      const isCurrentLiveTranslation = Boolean(
        streamingPreview ||
          preFinalTranslation ||
          (jobId && activeBackendTranslationJobIdRef.current && String(jobId) === String(activeBackendTranslationJobIdRef.current)) ||
          (matchedPendingTranscript && currentPendingTranscript && matchedPendingTranscript.translationId === currentPendingTranscript.translationId) ||
          (!jobId && updateOriginal && updateOriginal === lastFinalOriginalRef.current)
      );

      if (!streamingPreview && Number.isFinite(incomingSequence) && incomingSequence < latestTranslationSequenceRef.current && !matchedPendingTranscript) {
        return;
      }

      if (matchedPendingTranscript && updateOriginal && updateOriginal !== matchedPendingTranscript.original) {
        console.info("[TRANSLATION_REJECTED]", { sessionId, utteranceId: matchedPendingTranscript.translationId, lifecyclePhase: "unknown", reason: "original_text_mismatch" });
        return;
      }
      if (!streamingPreview && !preFinalTranslation && !matchedPendingTranscript && updateOriginal && lastFinalOriginalRef.current && updateOriginal !== lastFinalOriginalRef.current) {
        console.info("[TRANSLATION_REJECTED]", { sessionId, utteranceId: jobId ?? sequence ?? "unknown", lifecyclePhase: "unknown", reason: "unknown_utterance" });
        return;
      }
      if (!streamingPreview && !preFinalTranslation && jobId && activeBackendTranslationJobIdRef.current && String(jobId) !== String(activeBackendTranslationJobIdRef.current) && !matchedPendingTranscript) {
        console.info("[TRANSLATION_REJECTED]", { sessionId, utteranceId: jobId, lifecyclePhase: "unknown", reason: "job_mismatch_unknown_utterance" });
        return;
      }

      const nextTargetLanguages = normalizeTargetLanguages(eventTargetLanguages || matchedPendingTranscript?.targetLanguages || targetLanguagesRef.current, eventTargetLang || matchedPendingTranscript?.targetLang || targetLangRef.current);
      const sourceText = updateOriginal || matchedPendingTranscript?.original || lastFinalOriginalRef.current;
      const singleLanguage = lang || eventTargetLang || nextTargetLanguages[0];
      const nextTranslations = normalizeTranslationMap(translations, text || "", singleLanguage, { sourceText });
      const newStreamingPreviewSource = streamingPreview && updateOriginal && updateOriginal !== lastTranslationOriginalRef.current;
      const shouldUpdateLiveTranslation = Boolean(isCurrentLiveTranslation);
      const mergedTranslations: Record<string, string> =
        shouldUpdateLiveTranslation && !newStreamingPreviewSource ? { ...finalTranslationsRef.current } : {};

      const incomingTranslation = formatTranslationsText(nextTranslations, nextTargetLanguages);
      const mergedTranslation = formatTranslationsText(mergedTranslations, nextTargetLanguages);
      const mergedTranslationSignature = JSON.stringify(orderedTranslationEntries(mergedTranslations, nextTargetLanguages));
      const isComplete = complete !== false && !partial;

      // A completed translation whose utterance matched a still-tracked pending transcript, but
      // is no longer the "current" one because a newer utterance already started (desktop's
      // continuous re-arm can begin utterance N+1 before N's translation round-trip finishes).
      // This used to be silently dropped from the live display entirely — it still reached
      // "history" via appendTranscriptHistory further below, but never the visible subtitles.
      // The utterance is still valid (its session and pending-transcript entry both still
      // exist); it is simply not the newest one, so fold it into the rolling window rather than
      // the current utterance's in-progress slot.
      if (!shouldUpdateLiveTranslation && explicitPendingMatch && isComplete) {
        const staleUtteranceLanguages = Object.entries(nextTranslations).filter(([language, translatedText]) =>
          isValidTranslationText({ text: String(translatedText || "").trim(), sourceText, targetLang: language })
        );
        if (staleUtteranceLanguages.length > 0) {
          setTranslatedTextWindow((current) => {
            const next = { ...current };
            for (const [language, translatedText] of staleUtteranceLanguages) {
              next[language] = appendTextWindow(next[language] || "", String(translatedText).trim());
            }
            return next;
          });
          for (const [language] of staleUtteranceLanguages) {
            console.info("[TRANSLATION_COMMITTED]", { sessionId, utteranceId: explicitPendingMatch.translationId, targetLanguage: language, lifecyclePhase: "superseded", reason: "completed_after_newer_utterance_started" });
          }
        } else {
          console.info("[TRANSLATION_REJECTED]", { sessionId, utteranceId: explicitPendingMatch.translationId, lifecyclePhase: "superseded", reason: "no_valid_language_text" });
        }
      }

      for (const [language, translatedText] of Object.entries(nextTranslations)) {
        const incomingText = String(translatedText || "").trim();
        if (!isValidTranslationText({ text: incomingText, sourceText, targetLang: language })) continue;
        const existingText = mergedTranslations[language] || finalTranslationsRef.current[language] || "";
        const shouldPreserveExisting = !isComplete && Boolean(existingText) && incomingText.length < existingText.length;
        if (!shouldPreserveExisting) {
          mergedTranslations[language] = incomingText;
        }
      }
      const alreadyCompletedForCurrentUtterance = !streamingPreview && !isComplete && Boolean(lastCompletedTranslationRef.current) && Boolean(updateOriginal) && Boolean(lastFinalOriginalRef.current) && updateOriginal === lastFinalOriginalRef.current && (Number.isFinite(incomingSequence) ? incomingSequence <= latestTranslationSequenceRef.current : true);
      if (alreadyCompletedForCurrentUtterance) return;
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

      const diagnosticObjectsByLanguage: Record<string, TranslationProviderDiagnostic> = {};
      if (diagnosticsByLanguage && typeof diagnosticsByLanguage === "object") {
        for (const [language, diagnostic] of Object.entries(diagnosticsByLanguage)) {
          const normalizedLanguage = normalizeLanguageCode(language);
          if (normalizedLanguage && diagnostic && typeof diagnostic === "object") diagnosticObjectsByLanguage[normalizedLanguage] = diagnostic;
        }
      }
      if (diagnostics && typeof diagnostics === "object") {
        const diagnosticLanguage = normalizeLanguageCode(diagnostics.language || lang || eventTargetLang || singleLanguage);
        if (diagnosticLanguage) diagnosticObjectsByLanguage[diagnosticLanguage] = diagnostics;
      }

      const diagnosticUpdates: Record<string, string> = {};
      for (const [language, diagnostic] of Object.entries(diagnosticObjectsByLanguage)) {
        const diagnosticStatus = coerceTranslationState(diagnostic.status || nextStatusUpdates[language]);
        const hasSuccessfulTranslation = Boolean(mergedTranslations[language] || nextTranslations[language]);
        const isFailureDiagnostic = !hasSuccessfulTranslation && (diagnosticStatus === "failed" || (failedLanguages || []).includes(language));
        if (!isFailureDiagnostic) {
          diagnosticUpdates[language] = "";
          continue;
        }

        nextStatusUpdates[language] = "failed";
        diagnosticUpdates[language] = formatProviderDiagnostic(diagnostic);
        console.info("[FRONTEND_TRANSLATION_DIAGNOSTIC]", {
          requestUrl: API,
          websocketUrl: WS_URL || SOCKET_URL,
          requestId: diagnostic.requestId || `${jobId || "job"}:${language}`,
          provider: diagnostic.provider || provider || "unknown",
          providerModel: diagnostic.providerModel || null,
          errorCode: diagnostic.errorCode || null,
          errorCategory: diagnostic.errorCategory || null,
          fallbackProvider: diagnostic.fallbackProvider || null,
          latency: diagnostic.latencyMs ?? latencyMs ?? null,
          retries: diagnostic.retryCount ?? 0,
          queueLength: diagnostic.queueLength ?? null,
          activeWorkers: diagnostic.activeWorkers ?? null,
          finalErrorReason: diagnostic.reason || diagnostic.message || "unknown",
          language,
          status: diagnostic.status || nextStatusUpdates[language] || status || "unknown"
        });
      }

      // ROOT CAUSE of "DONE + Waiting for speech...": this used to iterate Object.keys(nextTranslations)
      // directly — every language PRESENT in the raw incoming payload, regardless of whether its text
      // actually passed isValidTranslationText() in the merge loop above (e.g. rejected as a
      // source-echo). A language could be marked "translated" here while mergedTranslations[language]
      // was never actually set, leaving the status/text permanently out of sync: the card's state said
      // done, but there was no text to show, so it fell through to the "Waiting for speech…" fallback.
      // Only mark a language translated if its text genuinely made it into mergedTranslations.
      for (const language of Object.keys(nextTranslations)) {
        if (!mergedTranslations[language]) continue;
        nextStatusUpdates[language] = "translated";
        diagnosticUpdates[language] = "";
      }
      const hasStatusUpdate = Object.keys(nextStatusUpdates).length > 0;
      const translationId = matchedPendingTranscript?.translationId ||
        (preFinalTranslation ? `backend-${sessionId || "session"}-${jobId ?? "job"}-${sequence ?? "sequence"}` : "") ||
        (shouldUpdateLiveTranslation ? activeTranslationIdRef.current : "") || matchedPendingTranscript?.timestamp || "current";
      const completedSignature = isComplete
        ? `${translationId}|${mergedTranslationSignature}`
        : "";

      if (!incomingTranslation && !hasStatusUpdate) return;
      if (shouldUpdateLiveTranslation && Object.keys(diagnosticUpdates).length > 0) {
        setTranslationDiagnostics((current) => ({ ...current, ...diagnosticUpdates }));
      }
      if (hasStatusUpdate && shouldUpdateLiveTranslation) {
        updateTranslationStatuses(nextStatusUpdates);
        console.info("[DESKTOP_PIPELINE_REACT_STATUS_UPDATE]", { jobId, sequence, updates: nextStatusUpdates, preFinalTranslation });
        if (!streamingPreview && Number.isFinite(incomingSequence)) {
          latestTranslationSequenceRef.current = Math.max(latestTranslationSequenceRef.current, incomingSequence);
        }
        if (!streamingPreview && jobId) activeBackendTranslationJobIdRef.current = jobId;
      }
      if (!incomingTranslation || !mergedTranslation) return;
      if (shouldUpdateLiveTranslation && !isComplete && mergedTranslationSignature === lastFinalTranslationRef.current && !hasStatusUpdate) return;
      if (isComplete && completedTranslationSignaturesRef.current.has(completedSignature)) return;
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
      if (shouldUpdateLiveTranslation && !streamingPreview && Number.isFinite(incomingSequence)) {
        latestTranslationSequenceRef.current = Math.max(latestTranslationSequenceRef.current, incomingSequence);
      }
      if (shouldUpdateLiveTranslation && !streamingPreview && jobId) activeBackendTranslationJobIdRef.current = jobId;
      if (shouldUpdateLiveTranslation && typeof latencyMs === "number") setLastLatency(latencyMs);
      trackLatency(latencyMs, provider);

      if (shouldUpdateLiveTranslation) {
        lastTranslationOriginalRef.current = sourceText;
        lastFinalTranslationRef.current = mergedTranslationSignature;
        finalTranslationsRef.current = mergedTranslations;
        setFinalTranslations(mergedTranslations);
        console.info("[DESKTOP_PIPELINE_REACT_TRANSLATIONS_UPDATE]", { jobId, sequence, languages: Object.keys(mergedTranslations), preFinalTranslation });
        for (const language of Object.keys(nextTranslations)) {
          console.info("[TRANSLATION_COMMITTED]", { sessionId, utteranceId: translationId, targetLanguage: language, lifecyclePhase: isComplete ? "completed" : "translating", reason: "current_utterance" });
        }
        if (!streamingPreview && isComplete) queueDubbingTranslations(translationId, nextTranslations);
      }

      if (isComplete) {
        completedTranslationSignaturesRef.current.add(completedSignature);
        if (completedTranslationSignaturesRef.current.size > MAX_TRANSCRIPT_HISTORY_ENTRIES) {
          const oldestSignature = completedTranslationSignaturesRef.current.values().next().value;
          if (oldestSignature) completedTranslationSignaturesRef.current.delete(oldestSignature);
        }

        if (shouldUpdateLiveTranslation) {
          lastCompletedTranslationRef.current = completedSignature;
          setFinalTranslationText((current) => [current, mergedTranslation].filter(Boolean).join("\n\n").trim().slice(-3500));
          setTranslatedSegments((current) => [...current, mergedTranslation].slice(-MAX_LIVE_SEGMENTS));
        }
        appendTranscriptHistory({
          original: sourceText,
          translated: mergedTranslation,
          translations: mergedTranslations,
          timestamp: matchedPendingTranscript?.timestamp || new Date().toISOString(),
          sourceLang: eventSourceLang || matchedPendingTranscript?.sourceLang || sourceLangRef.current,
          targetLang: eventTargetLang || matchedPendingTranscript?.targetLang || nextTargetLanguages[0],
          targetLanguages: nextTargetLanguages
        });
        forgetPendingFinalTranscript(matchedPendingTranscript);
        if (matchedPendingTranscript && currentPendingTranscript && matchedPendingTranscript.translationId === currentPendingTranscript.translationId) {
          pendingFinalTranscriptRef.current = null;
        }
        if (modeRef.current !== "dubbing") {
          for (const language of Object.keys(nextTranslations)) drainPendingLanguagesRef.current.delete(language);
        }
        for (const language of failedLanguages || []) drainPendingLanguagesRef.current.delete(language);
        for (const [language, languageStatus] of Object.entries(nextStatusUpdates)) {
          if (["failed", "stale", "cancelled"].includes(languageStatus) || (modeRef.current !== "dubbing" && ["translated", "done"].includes(languageStatus))) {
            drainPendingLanguagesRef.current.delete(language);
          }
        }
        setTranslationsPending([...drainPendingLanguagesRef.current]);
        if (drainPendingLanguagesRef.current.size === 0) {
          console.info("[UTTERANCE_COMPLETED]", { sessionId, utteranceId: matchedPendingTranscript?.translationId || translationId, lifecyclePhase: "completed", reason: "all_targets_settled" });
        }
        if (utteranceLifecycleRef.current.snapshot().phase === "draining" && !awaitingFinalTranscriptRef.current && drainPendingLanguagesRef.current.size === 0) {
          finishDrainRef.current("processed");
        } else if (drainTimeoutRef.current && drainPendingLanguagesRef.current.size > 0) {
          // Section 7: await every selected target independently. One target settling (complete
          // or failed) is real, observable progress on this utterance — extend the mobile drain
          // timeout so the remaining target(s) get their own fresh window instead of racing
          // whatever was left of the very first target's budget.
          window.clearTimeout(drainTimeoutRef.current);
          drainTimeoutRef.current = window.setTimeout(() => finishDrainRef.current("timeout"), TRANSLATION_DRAIN_PER_LANGUAGE_MS + TRANSLATION_DRAIN_TIMEOUT_MS / 2);
        }
      }
    };

    const onTranslationUpdate = (payload: Parameters<typeof handleTranslationUpdate>[0]) => { console.info("[DESKTOP_PIPELINE_SOCKET_EVENT]", { event: "translation_update" }); handleTranslationUpdate(payload); };
    const onTranslationResult = (payload: Parameters<typeof handleTranslationUpdate>[0]) => { console.info("[DESKTOP_PIPELINE_SOCKET_EVENT]", { event: "translation_result" }); handleTranslationUpdate(payload); };
    const onTranslatedText = (payload: Parameters<typeof handleTranslationUpdate>[0]) => { console.info("[DESKTOP_PIPELINE_SOCKET_EVENT]", { event: "translated_text" }); handleTranslationUpdate(payload); };
    socket.on("translation_update", onTranslationUpdate);
    socket.on("translation_result", onTranslationResult);
    socket.on("translated_text", onTranslatedText);

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
      socket.off("deepgram_stream_reset", handleDeepgramStreamReset);
      socket.off("translation_update", onTranslationUpdate);
      socket.off("translation_result", onTranslationResult);
      socket.off("translated_text", onTranslatedText);
      socket.disconnect();
      stopClientHeartbeat();
      socket.io.off("reconnect_attempt", handleReconnectAttempt);
      socket.io.off("reconnect", handleReconnect);
      socket.io.off("reconnect_error", handleReconnectError);
      if (socketRef.current === socket) socketRef.current = null;
      setSocketConnected(false);
      setSocketReconnecting(false);
    };
    // finishDrain is intentionally NOT a dependency here: it transitively depends on
    // refreshMe -> token, and /api/auth/me issues a fresh JWT (a new iat) on every call. The
    // 15s trial-countdown poller (see the refreshMe effect above) calls refreshMe while
    // recording, which reassigns `token` roughly every 15s, which would give finishDrain a new
    // identity every 15s too. If finishDrain were a dependency, that churn would re-run this
    // entire effect — disconnecting and recreating the live socket connection out from under
    // any in-flight translation request, roughly every 15 seconds, for any trial user actively
    // recording. finishDrainRef (kept fresh on every render, see finishDrainRef.current =
    // finishDrain above) lets this effect call the latest finishDrain without depending on it.
  }, [isAuthed, queueDubbingTranslations, updateSocketAuth, updateTranslationStatuses, flushQueuedAudioChunks, rememberPendingFinalTranscript, forgetPendingFinalTranscript, findPendingFinalTranscript]);

  useEffect(() => {
    const reconnectSocket = () => {
      if (socketRef.current && !socketRef.current.connected) socketRef.current.connect();
    };

    window.addEventListener("online", reconnectSocket);
    return () => window.removeEventListener("online", reconnectSocket);
  }, []);

  useEffect(() => {
    const resumeVisibleAudio = () => {
      if (document.visibilityState !== "visible" || !recordingRef.current) return;
      const audioContext = audioContextRef.current;
      if (audioContext?.state === "suspended") void audioContext.resume().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", resumeVisibleAudio);
    return () => document.removeEventListener("visibilitychange", resumeVisibleAudio);
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
        if (!["queued", "translating", "processing", "retrying"].includes(state as string)) continue;
        const updatedAt = translationStatusUpdatedAtRef.current[language] || 0;
        if (updatedAt && now - updatedAt > STALE_TRANSLATION_STATE_MS) {
          staleUpdates[language] = "failed";
          setTranslationDiagnostics((current) => ({ ...current, [language]: "Translation timed out. Speak again to retry." }));
        }
      }

      if (Object.keys(staleUpdates).length > 0) updateTranslationStatuses(staleUpdates);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [translationStatuses, updateTranslationStatuses]);

  useEffect(() => {
    if (mode === "dubbing") return;
    stopDubbingPlayback(true);
    dubbingLifecycleRef.current?.resetSeen();
  }, [mode, stopDubbingPlayback]);

  const dubbingLanguageSignature = `${sourceLang}:${targetLanguages.join(",")}`;
  useEffect(() => {
    stopDubbingPlayback(true);
    dubbingLifecycleRef.current?.resetSeen();
  }, [dubbingLanguageSignature, stopDubbingPlayback]);

  const applyAuthSession = (session: { token: string; user: AppUser }, destination: View = "dashboard") => {
    const normalizedUser = normalizeAuthUser(session.user) as AppUser;
    tokenRef.current = session.token;
    setToken(session.token);
    setUser(normalizedUser);
    saveSession(session.token, normalizedUser);
    updateSocketAuth(session.token);
    applyUserSettings(normalizedUser.settings);
    setAuthError(null);
    setView(destination);
    window.history.replaceState(null, "", destination === "admin" ? "/admin" : `#${destination}`);
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
      const path = view === "signup" ? "/api/auth/signup" : view === "admin-login" ? "/api/admin/login" : "/api/auth/login";
      const session = await requestApi<{ token: string; user: AppUser }>(path, {
        method: "POST",
        body: JSON.stringify(body)
      });
      const refreshed = await requestApi<{ token?: string; user: AppUser }>("/api/auth/me", {}, session.token);
      const verifiedSession = { token: refreshed.token || session.token, user: refreshed.user };
      const destination = isAdminRole(refreshed.user.role) ? "admin" : "dashboard";
      applyAuthSession(verifiedSession, destination);
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
      const refreshed = await requestApi<{ token?: string; user: AppUser }>("/api/auth/me", {}, session.token);
      applyAuthSession(
        { token: refreshed.token || session.token, user: refreshed.user },
        isAdminRole(refreshed.user.role) ? "admin" : "dashboard"
      );
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Google sign-in failed.");
    } finally {
      authRequestRef.current = null;
      setAuthProvider(null);
    }
  }, []);

  const handleAdminUnauthorized = useCallback(() => {
    clearSessionStorage();
    setToken(null);
    setUser(null);
    navigate("admin-login");
  }, [navigate]);

  const handleAdminForbidden = useCallback(() => navigate("dashboard"), [navigate]);

  const logout = async () => {
    if (token) await requestApi("/api/auth/logout", { method: "POST" }, token).catch(() => undefined);

    clearSessionStorage();
    stopDubbingPlayback(true);
    // A logout mid-recording must fully release capture and reset the utterance lifecycle back
    // to idle — otherwise the next login's first mic press inherits a stale non-idle phase.
    if (recordingRef.current || utteranceLifecycleRef.current.snapshot().phase !== "idle") {
      cleanupMedia({ stopReason: "logout" });
    }
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
      const normalizedUser = normalizeAuthUser(data.user) as AppUser;
      setUser(normalizedUser);
      localStorage.setItem("interp_shield_user", JSON.stringify(normalizedUser));
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
    // "session_action_in_progress" must only ever mean a real session action is actually
    // running — never a merely stale utteranceLifecycleRef phase. Conflating the two (as this
    // guard used to, by OR-ing a raw phase !== "idle" check into the same block) permanently
    // wedges the mic button any time the lifecycle phase outlives the session that set it: every
    // later press is rejected before getUserMedia/getDisplayMedia is ever reached, with no path
    // back to idle short of a page reload.
    if (sessionActionInFlightRef.current || startInFlightRef.current || stopInFlightRef.current || recordingRef.current) {
      console.warn("[MIC_START_BLOCKED]", {
        reason: "session_action_in_progress",
        sessionActionInFlight: sessionActionInFlightRef.current,
        startInFlight: startInFlightRef.current,
        stopInFlight: stopInFlightRef.current,
        recordingActive: recordingRef.current,
        phase: utteranceLifecycleRef.current.snapshot().phase
      });
      return;
    }

    const lifecyclePhaseAtEntry = utteranceLifecycleRef.current.snapshot().phase;
    if (lifecyclePhaseAtEntry !== "idle") {
      // Every ref that would indicate a real in-progress session (checked above) is false, so a
      // non-idle lifecycle phase here can only be a stale leftover from a previous session that
      // completed, failed, or was interrupted without utteranceLifecycleRef itself being reset
      // back to idle. Before trusting that diagnosis, confirm there is genuinely no live
      // recorder/stream this phase could still legitimately belong to.
      const staleRecorder = mediaRecorderRef.current;
      const recorderGenuinelyActive = staleRecorder?.state !== undefined && staleRecorder.state !== "inactive";
      const streamGenuinelyLive = streamRef.current?.getTracks().some((track) => track.readyState === "live") ?? false;
      if (recorderGenuinelyActive || streamGenuinelyLive) {
        console.warn("[MIC_START_BLOCKED]", {
          reason: "recording_already_active",
          phase: lifecyclePhaseAtEntry,
          recorderState: staleRecorder?.state || "none",
          streamLive: streamGenuinelyLive,
          source: audioSourceRef.current
        });
        return;
      }
      console.warn("[MIC_STALE_LIFECYCLE_RECOVERED]", {
        previousPhase: lifecyclePhaseAtEntry,
        status,
        recordingActive: recordingRef.current,
        recorderState: staleRecorder?.state || "none",
        streamLive: streamGenuinelyLive,
        source: audioSourceRef.current
      });
      // Normalize only capture/utterance-lifecycle state — never auth, user, subscription,
      // translation history, settings, or provider state.
      utteranceLifecycleRef.current.resetToIdle();
      sessionReadyRef.current = false;
      awaitingFinalTranscriptRef.current = false;
      setAwaitingFinalTranscript(false);
      drainPendingLanguagesRef.current.clear();
      recorderStopReasonRef.current = "";
      recorderStartedForGenerationRef.current = null;
      recorderStoppedForGenerationRef.current = null;
      finalizationEmittedForGenerationRef.current = null;
      recorderGenerationRestartRef.current = false;
      if (drainTimeoutRef.current) window.clearTimeout(drainTimeoutRef.current);
      drainTimeoutRef.current = null;
      if (captionWatchdogTimerRef.current) window.clearTimeout(captionWatchdogTimerRef.current);
      captionWatchdogTimerRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      void audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = null;
    }

    console.info("[MIC_START_ENTERED]", { phase: utteranceLifecycleRef.current.snapshot().phase, source: audioSourceRef.current });
    primeSpeechSynthesis();

    if (!isAuthed) {
      console.warn("[MIC_START_BLOCKED]", { reason: "not_authenticated" });
      navigate("login");
      return;
    }

    if (user?.role === "user" && user.subscription && !user.subscription.canUseInterpreter) {
      console.warn("[MIC_START_BLOCKED]", { reason: "trial_exhausted" });
      setAlert("Your 5-minute free trial has ended. Choose a plan to continue using InterpShield.");
      navigate("subscription");
      return;
    }

    if (!FRONTEND_CONFIG_DIAGNOSTICS.ok) {
      console.warn("[MIC_START_BLOCKED]", { reason: "config_invalid" });
      setStatus("error");
      setAlert(FRONTEND_CONFIG_DIAGNOSTICS.errors[0] || "Frontend environment configuration is invalid.");
      return;
    }

    // Every guard/support check that can bail out lives here, BEFORE any state is mutated —
    // in particular before utteranceLifecycleRef.current.start() moves the lifecycle phase
    // away from "idle". Previously several of these checks returned early without reverting
    // that phase, permanently blocking every future press's entry guard (phase !== "idle")
    // even for a totally different audio source. Once we're past this point we're fully
    // committed to starting, and the try/catch below already reverts everything correctly.
    const activeAudioSource = audioSourceRef.current;
    console.info("[AUDIO_START_REQUEST]", { source: activeAudioSource, platform: isDesktopChrome() ? "desktop" : "mobile", previousStatus: status });

    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn("[MIC_START_BLOCKED]", { reason: "getusermedia_unsupported" });
      setStatus("error");
      setMicrophonePermission("unsupported");
      setMicrophoneAvailable(false);
      setAudioDiagnostic({ state: "failed", message: "Microphone unsupported" });
      setAlert("Microphone access is not supported in this browser.");
      return;
    }

    if (!("MediaRecorder" in window)) {
      console.warn("[MIC_START_BLOCKED]", { reason: "mediarecorder_unsupported" });
      setStatus("error");
      setAudioDiagnostic({ state: "failed", message: "Recording unsupported" });
      setAlert("Microphone recording is not supported in this browser.");
      return;
    }

    if (activeAudioSource === "tab" && !isTabAudioCaptureSupported(navigator.mediaDevices)) {
      console.warn("[MIC_START_BLOCKED]", { reason: "tab_audio_unsupported" });
      setStatus("error");
      setAudioDiagnostic({ state: "failed", message: "Tab/system audio capture is unavailable" });
      setAlert("This browser does not support sharing tab or system audio. Switch to Microphone mode to continue.");
      return;
    }

    const recordingGeneration = activeRecordingGenerationRef.current + 1;
    console.info("[INPUT_SOURCE_SELECTED]", { source: activeAudioSource, desktopChrome: isDesktopChrome(), recordingGeneration });
    activeRecordingGenerationRef.current = recordingGeneration;
    explicitStopRequestedRef.current = false;
    startInFlightRef.current = true;
    stopInFlightRef.current = false;
    recorderStartedForGenerationRef.current = null;
    recorderStoppedForGenerationRef.current = null;
    finalizationEmittedForGenerationRef.current = null;
    containerHeaderRetryCountRef.current = 0;
    containerHeaderProbeFailuresRef.current = 0;
    activeSessionIdRef.current = "";
    lastVadSilenceDurationRef.current = 0;
    utteranceLifecycleRef.current.start({ now: Date.now(), recordingGeneration, sessionId: clientSessionIdRef.current });
    sessionActionInFlightRef.current = true;
    setAlert(null);
    setStatus("connecting");
    setAudioDiagnostic({ state: "checking", message: "Checking microphone" });
    setDetectedLanguage(null);
    sessionStartedAtRef.current = null;
    if (!recordingRef.current) setSessionSeconds(0);
    setChunkCount(0);
    setLastLatency(null);
    setTranslationStatuses({});
    setTranslatedTextWindow({});
    translationStatusUpdatedAtRef.current = {};
    sequenceRef.current = 0;
    lastInterimRef.current = "";
    lastFinalOriginalRef.current = "";
    lastFinalTranscriptEventKeyRef.current = "";
    lastFinalTranslationRef.current = "";
    lastCompletedTranslationRef.current = "";
    completedTranslationSignaturesRef.current.clear();
    pendingFinalTranscriptRef.current = null;
    pendingFinalTranscriptsRef.current.clear();
    activeTranslationIdRef.current = "";
    activeBackendSessionIdRef.current = "";
    activeBackendTranslationJobIdRef.current = "";
    latestTranslationSequenceRef.current = 0;
    finalTranslationsRef.current = {};
    dubbingLifecycleRef.current?.resetSeen();
    pendingPartialTranscriptRef.current = null;
    if (subtitleThrottleTimerRef.current) {
      window.clearTimeout(subtitleThrottleTimerRef.current);
      subtitleThrottleTimerRef.current = null;
    }
    if (interimTimerRef.current) {
      window.clearTimeout(interimTimerRef.current);
      interimTimerRef.current = null;
    }

    // getUserMedia/getDisplayMedia must be requested as close to the original click as
    // possible: mobile browsers only honor these permission prompts within a bounded "user
    // activation" window after a real gesture. Previously this function awaited the socket
    // connection (which can legitimately take seconds, or up to its 30s timeout, whenever the
    // socket wasn't already connected — the common case right after login, backgrounding, or
    // a network hiccup) BEFORE ever calling getUserMedia, which could silently push the media
    // request past that window on real mobile devices ("sometimes works, sometimes doesn't").
    // The socket connection is awaited further below, once the stream is already in hand.
    const connectSocketIfNeeded = async () => {
      if (socketRef.current?.connected) return;
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
    };

    try {
      const audio = buildAudioConstraints({
        microphoneId,
        echoCancellation,
        noiseSuppression,
        autoGainControl
      });
      const fallbackAudio = buildAudioConstraints({
        microphoneId: "default",
        echoCancellation,
        noiseSuppression,
        autoGainControl
      });

      setAudioDiagnostic({
        state: "requesting",
        message: activeAudioSource === "tab" ? "Waiting for tab/system audio selection" : "Requesting microphone permission"
      });
      let stream: MediaStream;
      if (activeAudioSource === "tab") {
        console.info("[GET_DISPLAY_MEDIA_REQUEST]", { recordingGeneration });
        try {
          stream = await requestTabAudioStream(navigator.mediaDevices);
        } catch (error) {
          console.error("[GET_DISPLAY_MEDIA_ERROR]", { recordingGeneration, name: error instanceof Error ? error.name : "unknown" });
          throw error;
        }
        console.info("[GET_DISPLAY_MEDIA_SUCCESS]", { recordingGeneration, audioTracks: stream.getAudioTracks().length });
        console.info("[TAB_AUDIO_CAPTURE]", {
          audioTracks: stream.getAudioTracks().length,
          videoTracks: stream.getVideoTracks().length,
          audioReadyState: stream.getAudioTracks()[0]?.readyState,
          audioEnabled: stream.getAudioTracks()[0]?.enabled,
          audioMuted: stream.getAudioTracks()[0]?.muted
        });
      } else {
        console.info("[GET_USER_MEDIA_REQUEST]", { recordingGeneration });
        try {
          stream = await requestMicrophoneStream(audio, fallbackAudio);
        } catch (error) {
          console.error("[GET_USER_MEDIA_ERROR]", { recordingGeneration, name: error instanceof Error ? error.name : "unknown" });
          throw error;
        }
        console.info("[GET_USER_MEDIA_SUCCESS]", { recordingGeneration, audioTracks: stream.getAudioTracks().length });
      }
      if (activeRecordingGenerationRef.current !== recordingGeneration || explicitStopRequestedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        sessionActionInFlightRef.current = false;
        startInFlightRef.current = false;
        return;
      }
      streamRef.current = stream;
      // Kick off the socket connection now, in parallel with the WebAudio/MediaRecorder setup
      // below — it's awaited just before it's actually needed, right before emitting
      // start_session, so it never delays the getUserMedia/getDisplayMedia call itself.
      const socketReadyPromise = connectSocketIfNeeded();
      if (activeAudioSource === "microphone") {
        setMicrophonePermission("granted");
        setMicrophoneAvailable(true);
        void refreshMicrophones();
      }
      for (const track of stream.getAudioTracks()) {
        const settings = track.getSettings?.() || {};
        console.info("[INPUT_AUDIO_TRACK]", {
          source: activeAudioSource,
          label: track.label,
          readyState: track.readyState,
          enabled: track.enabled,
          muted: track.muted,
          sampleRate: settings.sampleRate,
          channelCount: settings.channelCount,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl
        });
      }

      const enhancedAudio = createAmplifiedAudioStream(stream);
      getAudioLevelRef.current = enhancedAudio.getAudioLevel;
      processedStreamRef.current = enhancedAudio.stream === stream ? null : enhancedAudio.stream;
      audioContextRef.current = enhancedAudio.audioContext;
      if (enhancedAudio.audioContext?.state === "suspended") {
        await enhancedAudio.audioContext.resume().catch(() => undefined);
      }

      const mimeType = getSupportedMimeType();
      const recorderSetup = createMediaRecorderWithFallback(enhancedAudio.stream, stream, mimeType);
      const recorder = recorderSetup.recorder;
      const recorderMimeType = recorderSetup.mimeType;
      sequenceRef.current = 0;
      audioStreamGenerationRef.current = 1;
      pendingAudioStreamGenerationRef.current = 1;
      awaitingContainerHeaderRef.current = true;
      recorderGenerationRestartRef.current = false;
      lastHandledDeepgramGenerationRef.current = 1;
      mediaRecorderRef.current = recorder;
      console.info("[MEDIARECORDER_CREATED]", { recordingGeneration, source: recorderSetup.source, mimeType: recorder.mimeType });
      const deviceLabel = stream.getAudioTracks()[0]?.label || (microphoneId === "default" ? "System default microphone" : "Selected microphone");
      setAudioDiagnostic({
        state: "ready",
        message: "Microphone ready",
        deviceLabel,
        mimeType: recorderMimeType,
        webAudio: Boolean(enhancedAudio.audioContext && recorderSetup.source === "enhanced")
      });
      logFrontendDebug("audio", "AUDIO_RECORDER_READY", {
        selectedMimeType: mimeType,
        actualMimeType: recorder.mimeType,
        chunkIntervalMs: audioChunkMsRef.current,
        recorderSource: recorderSetup.source,
        webAudio: Boolean(enhancedAudio.audioContext),
        deviceLabel
      });
      console.info("[MEDIARECORDER_FORMAT]", {
        source: activeAudioSource,
        requestedMimeType: mimeType,
        actualMimeType: recorder.mimeType,
        audioBitsPerSecond: (recorder as MediaRecorder & { audioBitsPerSecond?: number }).audioBitsPerSecond,
        recorderSource: recorderSetup.source,
        chunkIntervalMs: audioChunkMsRef.current,
        recordingGeneration
      });

      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          // A track ending is only a real failure if InterpShield still expects it to be
          // live. Every intentional stop/replacement path (explicit Stop, mobile utterance
          // completion, desktop generation restart, cleanupMedia teardown) already flips one
          // of these flags/refs before it ever calls track.stop(), so this is a defense-in-
          // depth check against exactly one signal being missed, not a guess.
          const phase = utteranceLifecycleRef.current.snapshot().phase;
          const isCurrentGeneration = activeRecordingGenerationRef.current === recordingGeneration;
          const isCurrentStream = streamRef.current === stream;
          const recordingExpected = recordingRef.current;
          const intentionalStopInProgress = explicitStopRequestedRef.current || stopInFlightRef.current;
          const recorderTransitionInProgress = recorderGenerationRestartRef.current;
          const expected = isTrackEndExpected({
            isCurrentGeneration,
            isCurrentStream,
            recordingExpected,
            intentionalStopInProgress,
            recorderTransitionInProgress,
            phase
          });
          console.info("[AUDIO_TRACK_ENDED]", {
            expected,
            source: activeAudioSource,
            generation: recordingGeneration,
            activeGeneration: activeRecordingGenerationRef.current,
            phase,
            recordingExpected,
            isCurrentGeneration,
            isCurrentStream,
            intentionalStopInProgress,
            recorderTransitionInProgress
          });
          if (expected) return;
          if (activeAudioSource === "tab") {
            console.info("[TAB_AUDIO_CAPTURE]", {
              event: "track_ended",
              audioTracks: stream.getAudioTracks().length,
              trackReadyState: track.readyState,
              muted: track.muted,
              enabled: track.enabled
            });
          }
          scheduleAudioRecovery("track_ended");
        };
      }

      const sendCapturedChunk = (chunk: Omit<AudioChunkPayload, "sequence">) => {
        if ((dubbingTransmissionGatedRef.current && !chunk.containerHeader) || chunk.audio.size < MIN_MEDIA_CHUNK_BYTES) return false;
        sequenceRef.current += 1;
        lastAudioChunkSentAtRef.current = chunk.capturedAt;
        emitAudioChunkPayload({ ...chunk, sequence: sequenceRef.current });
        utteranceLifecycleRef.current.noteEmitted();
        if (sequenceRef.current % 3 === 0) setChunkCount(sequenceRef.current);
        return true;
      };

      const emitUtteranceFinalization = (capturedAt: number, finalChunk: boolean, reason: string) => {
        if (finalizationEmittedForGenerationRef.current === activeRecordingGenerationRef.current) return false;
        finalizationEmittedForGenerationRef.current = activeRecordingGenerationRef.current;
        socketRef.current?.emit("audio_utterance_end", { sequence: sequenceRef.current, capturedAt, finalChunk });
        logFrontendDebug("audio", "UTTERANCE_BOUNDARY_EMITTED", { sequence: sequenceRef.current, reason });
        // Desktop's recordingGeneration stays constant across many utterances in one live
        // session, so this per-generation dedup guard is reset immediately after firing —
        // otherwise only the FIRST utterance in the whole session could ever emit a boundary.
        finalizationEmittedForGenerationRef.current = null;
        return true;
      };

      utteranceBoundaryRef.current?.stop();
      utteranceBoundaryRef.current = createUtteranceBoundaryController({
        timeoutMs: FINAL_CHUNK_ACK_TIMEOUT_MS,
        getAudioLevel: enhancedAudio.getAudioLevel,
        onCancelled: () => {
          if (!vadControllerRef.current.cancelFinalization()) return;
          setStatus("speaking");
          setAudioDiagnostic((current) => ({ ...current, state: "recording", message: "Speaking" }));
        },
        onBoundary: (boundary, reason) => {
          if (utteranceLifecycleRef.current.snapshot().phase !== "draining") return;
          pendingSpeechChunksRef.current = [];
          emitUtteranceFinalization(boundary.capturedAt, reason === "dataavailable", reason);
          // The flush chunk containing this utterance's tail audio is now confirmed captured
          // and sent (or the timeout fallback fired): only now is it safe to reset VAD/
          // utterance-lifecycle state for the next sentence — resetting any earlier would let
          // the flush chunk itself get buffered as "next utterance" audio instead of sent.
          const sessionId = utteranceLifecycleRef.current.snapshot().sessionId;
          vadControllerRef.current.markPaused();
          utteranceLifecycleRef.current.start({ now: Date.now(), recordingGeneration: activeRecordingGenerationRef.current, sessionId });
          setStatus("listening");
          setAudioDiagnostic((current) => ({ ...current, state: "recording", message: "Listening" }));
        }
      });

      recorder.ondataavailable = async (event) => {
        if (activeRecordingGenerationRef.current !== recordingGeneration || mediaRecorderRef.current !== recorder || (!recordingRef.current && utteranceLifecycleRef.current.snapshot().phase !== "draining")) return;
        const capturedAt = Date.now();
        const audioLevel = enhancedAudio.getAudioLevel();
        let finalChunkSent = false;
        try {
          // While still awaiting this generation's container header, a chunk must never be
          // dropped by the small-chunk filter below: MediaRecorder's WebM muxer can legitimately
          // flush the EBML header alone as its own small (sometimes just a few bytes) blob before
          // any audio cluster exists yet. Dropping that chunk here left awaitingContainerHeaderRef
          // still true for the NEXT (larger, but no longer byte-0-of-file) chunk, which then
          // failed the signature check for a completely different reason: it genuinely was not
          // the start of the file anymore (see containerSignature below) — this, not a real
          // corrupt/invalid stream, is what was triggering AUDIO_CONTAINER_HEADER_INVALID /
          // AUDIO_CONTAINER_HEADER_RETRY on otherwise perfectly valid desktop capture.
          if (!awaitingContainerHeaderRef.current && event.data.size < MIN_MEDIA_CHUNK_BYTES) return;
          if (isDesktopChrome()) {
            const speechSnapshot = utteranceLifecycleRef.current.observeAudio({ audioLevel, noiseFloor: vadControllerRef.current.getNoiseFloor(), bytes: event.data.size, containerAudio: /audio\/(webm|ogg)/i.test(recorderMimeType), now: capturedAt });
            if (speechSnapshot.speechLikeSample && speechSnapshot.meaningfulSpeechDetected) {
              if (captionWatchdogTimerRef.current) window.clearTimeout(captionWatchdogTimerRef.current);
              captionWatchdogTimerRef.current = null;
            }
            if (sequenceRef.current % 25 === 0) {
              console.info("[DESKTOP_AUDIO_LEVEL]", {
                audioLevel,
                noiseFloor: vadControllerRef.current.getNoiseFloor(),
                threshold: speechSnapshot.threshold,
                speechLikeSample: speechSnapshot.speechLikeSample,
                meaningfulSpeechDetected: speechSnapshot.meaningfulSpeechDetected,
                bytes: event.data.size
              });
              console.info("[DESKTOP_RECORDER_STATE]", {
                recorderState: recorder.state,
                recordingGeneration: activeRecordingGenerationRef.current,
                streamGeneration: audioStreamGenerationRef.current,
                sequence: sequenceRef.current,
                sessionId: activeSessionIdRef.current || clientSessionIdRef.current
              });
            }
          }
          const elapsedSinceLastChunk = capturedAt - lastAudioChunkSentAtRef.current;
          // Same reasoning as the size filter above: a fast recorder restart (including the
          // container-header retry path itself) can leave lastAudioChunkSentAtRef close enough
          // in time that this throttle would otherwise swallow the new generation's true first,
          // header-bearing chunk.
          if (!awaitingContainerHeaderRef.current && elapsedSinceLastChunk < MIN_AUDIO_CHUNK_INTERVAL_MS && audioLevel < 0.002) return;
          const isGenerationHeader = awaitingContainerHeaderRef.current;
          let signature = { valid: false, container: "unknown", hex: "" };
          if (isGenerationHeader) {
            signature = containerSignature(await event.data.slice(0, 16).arrayBuffer());
            if (!signature.valid) {
              containerHeaderProbeFailuresRef.current += 1;
              console.error("[AUDIO_CONTAINER_HEADER_INVALID]", { mimeType: recorderMimeType, streamGeneration: audioStreamGenerationRef.current, signature: signature.hex, retryCount: containerHeaderRetryCountRef.current, probeFailures: containerHeaderProbeFailuresRef.current });
              // A single failed probe is not, by itself, proof the container is genuinely
              // corrupt — a fast MediaRecorder chunk boundary can leave this chunk simply not
              // starting at byte 0 of the file without any real encoding problem. Skip only this
              // one chunk (still awaiting the header, recorder untouched) and let the next chunk
              // be evaluated fresh, exactly as the mobile MIN_MEDIA_CHUNK_BYTES/timing exemptions
              // above already protect the true first chunk from being discarded before this
              // point. Only a second consecutive failure for the same generation escalates to
              // the stop/restart recovery path — real, sustained container corruption fails
              // again immediately, so it is still caught just as reliably as before.
              if (containerHeaderProbeFailuresRef.current < 2) return;
              // A missing/invalid header (e.g. right after a Deepgram-triggered stream reset)
              // is a transient MediaRecorder timing hiccup, not proof the whole capture
              // pipeline is broken: retry an in-place restart, reusing the same tested
              // generation/header recovery path as a genuine Deepgram reconnect, a bounded
              // number of times before treating it as a real failure needing full teardown.
              if (isDesktopChrome() && containerHeaderRetryCountRef.current < MAX_CONTAINER_HEADER_RETRIES && recordingRef.current && !explicitStopRequestedRef.current) {
                containerHeaderRetryCountRef.current += 1;
                containerHeaderProbeFailuresRef.current = 0;
                console.warn("[AUDIO_CONTAINER_HEADER_RETRY]", { attempt: containerHeaderRetryCountRef.current, maxAttempts: MAX_CONTAINER_HEADER_RETRIES, streamGeneration: audioStreamGenerationRef.current });
                pendingAudioStreamGenerationRef.current = audioStreamGenerationRef.current + 1;
                queuedAudioChunksRef.current = [];
                pendingSpeechChunksRef.current = [];
                recorderGenerationRestartRef.current = true;
                if (recorder.state === "recording" && recorderStoppedForGenerationRef.current !== activeRecordingGenerationRef.current) {
                  recorderStoppedForGenerationRef.current = activeRecordingGenerationRef.current;
                  recorderStopReasonRef.current = "container_header_retry";
                  recorder.stop();
                }
                return;
              }
              scheduleAudioRecovery("container_header_missing");
              return;
            }
            awaitingContainerHeaderRef.current = false;
            containerHeaderRetryCountRef.current = 0;
            containerHeaderProbeFailuresRef.current = 0;
          }
          const chunk = {
            audio: event.data,
            audioLevel,
            chunkMs: audioChunkMsRef.current,
            capturedAt,
            mimeType: recorderMimeType,
            streamGeneration: audioStreamGenerationRef.current,
            containerHeader: isGenerationHeader
          };
          if (isGenerationHeader || sequenceRef.current % 25 === 0) {
            console.info("[AUDIO_CHUNK_CAPTURED]", { sessionId: clientSessionIdRef.current, sequence: sequenceRef.current + 1, streamGeneration: audioStreamGenerationRef.current, bytes: event.data.size, audioLevel, chunkIntervalMs: elapsedSinceLastChunk, mimeType: recorderMimeType, recorderState: recorder.state, containerHeader: isGenerationHeader, signature: signature.hex });
          }
          if (isGenerationHeader) {
            sendCapturedChunk(chunk);
            return;
          }
          if (dubbingTransmissionGatedRef.current) return;
          if (utteranceLifecycleRef.current.snapshot().phase === "draining") {
            finalChunkSent = sendCapturedChunk(chunk);
            return;
          }
          if (isDesktopChrome()) {
            // Desktop trusts Deepgram's own VAD/endpointing (vad_events, endpointing,
            // utterance_end_ms) to decide what is speech. Client-side RMS/VAD is diagnostic
            // and UI-only here — it must never gate whether a valid, already-encoded chunk is
            // delivered, even at genuinely low microphone RMS (e.g. audioLevel ~0.0054).
            finalChunkSent = sendCapturedChunk(chunk);
            return;
          }
          const vadState = vadControllerRef.current.getState();
          if (vadState === "speaking" || vadState === "soft-pause" || vadState === "finalizing") {
            finalChunkSent = sendCapturedChunk(chunk);
            return;
          }
          if (vadState === "listening" || vadState === "paused") {
            pendingSpeechChunksRef.current.push({ ...chunk, sequence: 0 });
            const cutoff = capturedAt - DEFAULT_VAD_CONFIG.preSpeechBufferMs;
            pendingSpeechChunksRef.current = pendingSpeechChunksRef.current.filter((item) => item.capturedAt >= cutoff);
          }
        } finally {
          // Android can emit an empty or throttled event after requestData().
          // A boundary is safe only after its non-empty final chunk was sent.
          if (finalChunkSent) utteranceBoundaryRef.current?.onDataAvailable(audioLevel);
        }
      };

      recorder.onerror = (event) => {
        const message = "Microphone recording stopped unexpectedly.";
        setAudioDiagnostic((current) => ({
          ...current,
          state: "recovering",
          message,
          lastError: event instanceof Event ? event.type : "recorder_error"
        }));
        scheduleAudioRecovery("recorder_error");
      };

      recorder.onstop = () => {
        if (activeRecordingGenerationRef.current !== recordingGeneration) return;
        const lifecycle = utteranceLifecycleRef.current.snapshot();
        console.info("[MEDIARECORDER_STOP]", { reason: recorderStopReasonRef.current, recordingGeneration: lifecycle.recordingGeneration, sessionId: lifecycle.sessionId, currentState: recorder.state, speechDetected: lifecycle.speechStarted, silenceDuration: lastVadSilenceDurationRef.current, pendingFinalTranscript: awaitingFinalTranscriptRef.current, socketConnected: Boolean(socketRef.current?.connected), mimeType: recorder.mimeType, streamGeneration: audioStreamGenerationRef.current });
        if (recorderStopReasonRef.current === "vad_sustained_silence") emitUtteranceFinalization(Date.now(), true, "recorder_stop");
        if (recorderGenerationRestartRef.current && recordingRef.current) {
          recorderGenerationRestartRef.current = false;
          audioStreamGenerationRef.current = pendingAudioStreamGenerationRef.current;
          sequenceRef.current = 0;
          pendingSpeechChunksRef.current = [];
          awaitingContainerHeaderRef.current = true;
          containerHeaderProbeFailuresRef.current = 0;
          const previousState = recorder.state;
          console.info("[MEDIARECORDER_START_REQUEST]", { reason: "deepgram_generation_change_onstop", recordingGeneration: activeRecordingGenerationRef.current, previousState });
          recorder.start(audioChunkMsRef.current);
          console.info("[MEDIARECORDER_STARTED]", { reason: "deepgram_generation_change_onstop", recordingGeneration: activeRecordingGenerationRef.current, sessionId: activeSessionIdRef.current || clientSessionIdRef.current, previousState, mimeType: recorder.mimeType, streamGeneration: audioStreamGenerationRef.current });
          setMediaRecorderActive(true);
          return;
        }
        stopInFlightRef.current = false;
        // recorderStoppedForGenerationRef is set by our own code immediately before every
        // intentional recorder.stop() call (beginDrain, cleanupMedia). If it doesn't match
        // the active generation, this recorder stopped on its own — a genuine unexpected
        // failure, not one of the tracked reasons above. `status` (React state) is not used
        // here: it's captured in this closure once at session start and never updates, so it
        // can never reliably distinguish an expected stop from an unexpected one.
        const stopWasIntentional = recorderStoppedForGenerationRef.current === activeRecordingGenerationRef.current;
        console.info("[MEDIARECORDER_STOP_CLASSIFIED]", {
          reason: classifyRecorderStop({ stopWasIntentional, trackedReason: recorderStopReasonRef.current }),
          stopWasIntentional,
          recordingExpected: recordingRef.current,
          recordingGeneration: activeRecordingGenerationRef.current
        });
        if (shouldRecoverFromRecorderStop({ recordingExpected: recordingRef.current, stopWasIntentional })) {
          scheduleAudioRecovery("unexpected_recorder_stop");
        }
      };

      const desktopChrome = isDesktopChrome();
      vadControllerRef.current = createVadController({
        autoFinalize: autoStopOnSilence,
        ...(desktopChrome
          ? { speechThreshold: 0.003, silenceThreshold: 0.0018, noiseFloorMultiplier: 1.5, consecutiveSpeechSamples: 3, hardFinalizeMs: 1600 }
          : { hardFinalizeMs: 1400 })
      });
      vadControllerRef.current.start(Date.now());
      setStatus("calibrating");
      if (vadPollTimerRef.current) window.clearInterval(vadPollTimerRef.current);
      vadPollTimerRef.current = window.setInterval(() => {
        if (!recordingRef.current) return;
        if (dubbingTransmissionGatedRef.current) return;
        const action = vadControllerRef.current.update(getAudioLevelRef.current(), Date.now(), false);
        if (!action) return;
        if ("silenceMs" in action) lastVadSilenceDurationRef.current = action.silenceMs || 0;
        if (action.type === "speech_started" || action.type === "speech_resumed") utteranceLifecycleRef.current.confirmMeaningfulSpeech();
        utteranceLifecycleRef.current.observeVad({ type: action.type, silenceMs: "silenceMs" in action ? action.silenceMs : 0, now: Date.now() });
        const speechSnapshot = utteranceLifecycleRef.current.snapshot();
        console.info("[VAD_STATE]", { speechStarted: speechSnapshot.speechStarted, meaningfulSpeechDetected: speechSnapshot.meaningfulSpeechDetected, consecutiveSpeechSamples: speechSnapshot.consecutiveSpeechSamples, audioLevel: action.level, threshold: action.speech, silenceDurationMs: "silenceMs" in action ? action.silenceMs : 0, phase: speechSnapshot.phase, recordingGeneration: speechSnapshot.recordingGeneration, noiseFloor: vadControllerRef.current.getNoiseFloor() });
        if (action.type === "calibrated") {
          setStatus("listening");
          return;
        }
        if (action.type === "speech_candidate") {
          if (enhancedAudio.audioContext?.state === "suspended") void enhancedAudio.audioContext.resume().catch(() => undefined);
          return;
        }
        if (action.type === "speech_cancelled") {
          return;
        }
        if (action.type === "speech_started") {
          if (captionWatchdogTimerRef.current) window.clearTimeout(captionWatchdogTimerRef.current);
          captionWatchdogTimerRef.current = null;
          const buffered = pendingSpeechChunksRef.current.splice(0);
          for (const bufferedChunk of buffered) {
            const { sequence: _discardedSequence, ...capturedChunk } = bufferedChunk;
            void _discardedSequence;
            sendCapturedChunk(capturedChunk);
          }
          setStatus("speaking");
          setAudioDiagnostic((current) => ({ ...current, state: "recording", message: "Speaking" }));
          if (captionWatchdogTimerRef.current) window.clearTimeout(captionWatchdogTimerRef.current);
          captionWatchdogTimerRef.current = window.setTimeout(() => {
            captionWatchdogTimerRef.current = null;
            if (!recordingRef.current || lastInterimRef.current || lastFinalOriginalRef.current) return;
            setAlert("No caption received yet. Still listening…");
          }, CAPTION_WATCHDOG_MS);
          return;
        }
        if (action.type === "speech_resumed") {
          setStatus("speaking");
          setAudioDiagnostic((current) => ({ ...current, state: "recording", message: "Speaking" }));
          return;
        }
        if (action.type === "soft_pause") {
          setStatus("soft-pause");
          setAudioDiagnostic((current) => ({ ...current, state: "recording", message: "Waiting for more speech" }));
          return;
        }
        if (action.type === "finalize") {
          setStatus("finalizing");
          setAudioDiagnostic((current) => ({ ...current, state: "recording", message: "Finishing caption" }));
          beginDrain("vad_sustained_silence", activeRecordingGenerationRef.current);
        }
      }, VAD_POLL_INTERVAL_MS);

      const activeSourceLang = normalizeLanguageCode(sourceLang) || "en";
      const activeTargetLanguages = normalizeTargetLanguages(targetLanguages, targetLang);
      const sessionPayload = {
        clientSessionId: clientSessionIdRef.current,
        sourceLang: activeSourceLang,
        targetLang: activeTargetLanguages[0],
        targetLanguages: activeTargetLanguages,
        translate: modeRef.current !== "transcribe",
        twoWay: activeTargetLanguages.length > 1,
        mimeType: recorderMimeType,
        roomId: shareableMode ? `live:${user?.id || "guest"}` : undefined,
        participantId: user?.id || socketRef.current?.id || "browser",
        audioProfile: {
          noiseSuppression,
          echoCancellation,
          autoGainControl,
          webAudio: Boolean(enhancedAudio.audioContext && recorderSetup.source === "enhanced")
        },
        preferredProvider,
        userPlan: user?.plan || "free",
        recordingGeneration
      };
      activeSessionPayloadRef.current = sessionPayload;
      shouldRestartSessionOnReconnectRef.current = false;

      await socketReadyPromise;
      if (activeRecordingGenerationRef.current !== recordingGeneration || explicitStopRequestedRef.current) {
        sessionActionInFlightRef.current = false;
        cleanupMedia({ stopReason: "session_start_superseded" });
        return;
      }

      socketRef.current?.timeout(30000).emit(
        "start_session",
        sessionPayload,
        (timeoutError: Error | null, response?: { ok?: boolean; error?: string; sessionId?: string }) => {
          const stale = activeRecordingGenerationRef.current !== recordingGeneration;
          console.info("[SESSION_START_ACK]", { reason: "explicit_user_start", recordingGeneration, stale, ok: !timeoutError && !response?.error, error: response?.error || timeoutError?.message || null, mimeType: recorderMimeType, sessionId: response?.sessionId });
          if (stale) return;
          activeSessionIdRef.current = response?.sessionId || activeSessionIdRef.current;
          utteranceLifecycleRef.current.setSessionId(activeSessionIdRef.current || clientSessionIdRef.current);
          if (timeoutError || response?.error) {
            sessionActionInFlightRef.current = false;
            startInFlightRef.current = false;
            cleanupMedia({ stopReason: "session_start_failed" });
            utteranceLifecycleRef.current.resetToIdle();
            setStatus("error");
            setAlert(response?.error || "Unable to reach the live interpreter.");
          }
        }
      );
    } catch (error) {
      sessionActionInFlightRef.current = false;
      startInFlightRef.current = false;
      cleanupMedia({ stopReason: "session_start_exception" });
      utteranceLifecycleRef.current.resetToIdle();
      setStatus("error");
      const message = mediaErrorMessage(error, activeAudioSource);
      setAudioDiagnostic({
        state: message.includes("permission") ? "blocked" : "failed",
        message,
        lastError: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      });

      if (activeAudioSource === "microphone" && error instanceof DOMException && (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")) {
        setMicrophoneAvailable(false);
        setAlert(message);
        return;
      }

      if (activeAudioSource === "microphone" && error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
        setMicrophonePermission("denied");
        setAlert(message);
        return;
      }

      if (activeAudioSource === "microphone" && isDeviceConstraintError(error)) {
        setMicrophoneId("default");
        setAlert(message);
        return;
      }

      setAlert(message);
    }
  }, [autoGainControl, beginDrain, cleanupMedia, echoCancellation, emitAudioChunkPayload, isAuthed, microphoneId, navigate, noiseSuppression, preferredProvider, refreshMicrophones, scheduleAudioRecovery, shareableMode, sourceLang, targetLang, targetLanguages, user?.id, user?.plan, status]);

  const handleMicClick = useCallback(() => {
    const phase = utteranceLifecycleRef.current.snapshot().phase;
    console.info("[MIC_BUTTON_CLICK]", {
      isRecording,
      status,
      audioSource,
      sessionActionInFlight: sessionActionInFlightRef.current,
      startInFlight: startInFlightRef.current,
      stopInFlight: stopInFlightRef.current,
      recordingActive: recordingRef.current,
      phase
    });
    if (isRecording) {
      stopSession();
      return;
    }
    // The click registers (the button is not natively disabled here), but startSession()'s own
    // entry guard can still silently no-op if any of these are stuck true from a prior session
    // that failed to fully reset — log exactly which one so a real device report can show
    // precisely why nothing happened. A stale, non-idle lifecycle phase alone does NOT block
    // startSession() (it self-heals via [MIC_STALE_LIFECYCLE_RECOVERED]), so it's reported here
    // as context, not as a blocking reason.
    const blockedReasons = {
      sessionActionInFlight: sessionActionInFlightRef.current,
      startInFlight: startInFlightRef.current,
      stopInFlight: stopInFlightRef.current,
      recordingActive: recordingRef.current,
      notAuthenticated: !isAuthed,
      trialExhausted: Boolean(user?.role === "user" && user.subscription && !user.subscription.canUseInterpreter)
    };
    if (Object.values(blockedReasons).some(Boolean) || phase !== "idle") {
      console.warn("[MIC_BUTTON_DISABLED_REASON]", { ...blockedReasons, utteranceLifecyclePhaseStale: phase !== "idle" });
    }
    void startSession();
  }, [isAuthed, isRecording, startSession, status, stopSession, user?.role, user?.subscription]);

  useEffect(() => {
    // TranslationPanel's native disabled={isBusy} mirrors status === "stopping" exactly (see
    // TranslationPanel.tsx). Logging this snapshot on every relevant transition — not only on
    // click — is what lets a real device report show a button stuck disabled even when no
    // click ever registered to trigger [MIC_BUTTON_CLICK] in the first place.
    console.info("[MIC_BUTTON_STATE]", {
      disabled: status === "stopping",
      status,
      recording: isRecording,
      startInFlight: startInFlightRef.current,
      stopInFlight: stopInFlightRef.current,
      sessionActionInFlight: sessionActionInFlightRef.current,
      awaitingFinalTranscript: awaitingFinalTranscriptRef.current,
      source: audioSource
    });

    // The impossible combination this whole fix exists to catch: every indicator agrees nothing
    // is recording or in flight, yet the utterance lifecycle never made it back to "idle". This
    // opportunistically self-heals it (there is provably no live recorder/stream to protect)
    // even before the user presses the mic again, and gives production visibility into how the
    // stale phase is actually being reached.
    if (status === "idle" && !isRecording && !startInFlightRef.current && !stopInFlightRef.current && !sessionActionInFlightRef.current) {
      const lifecycle = utteranceLifecycleRef.current.snapshot();
      if (lifecycle.phase !== "idle") {
        const recorder = mediaRecorderRef.current;
        const recorderGenuinelyActive = recorder?.state !== undefined && recorder.state !== "inactive";
        const streamGenuinelyLive = streamRef.current?.getTracks().some((track) => track.readyState === "live") ?? false;
        console.error("[MIC_LIFECYCLE_INVARIANT_VIOLATION]", {
          status,
          recordingActive: recordingRef.current,
          phase: lifecycle.phase,
          recorderState: recorder?.state || "none",
          streamLive: streamGenuinelyLive,
          source: audioSource
        });
        if (!recorderGenuinelyActive && !streamGenuinelyLive) utteranceLifecycleRef.current.resetToIdle();
      }
    }
  }, [status, isRecording, audioSource]);

  useEffect(() => {
    // TranslationPanel natively disables the mic button (unclickable, no onClick fires at
    // all) while status === "stopping". If stopSession() ever throws before reaching its own
    // setStatus("idle"), the button would stay disabled forever with no click to diagnose
    // from — this watchdog surfaces exactly that condition on its own.
    if (status !== "stopping") return undefined;
    const timer = window.setTimeout(() => {
      console.warn("[MIC_BUTTON_DISABLED_REASON]", { reason: "status_stuck_stopping", status, stopInFlight: stopInFlightRef.current, recordingActive: recordingRef.current });
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

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
    setTranslatedTextWindow({});
    setTranslationStatuses({});
    translationStatusUpdatedAtRef.current = {};
    setInterimOriginal("");
    if (!recordingRef.current) setSessionSeconds(0);
    setChunkCount(0);
    setLastLatency(null);
    setDetectedLanguage(null);
    lastInterimRef.current = "";
    lastFinalOriginalRef.current = "";
    lastFinalTranscriptEventKeyRef.current = "";
    lastFinalTranslationRef.current = "";
    lastCompletedTranslationRef.current = "";
    completedTranslationSignaturesRef.current.clear();
    lastTranslationOriginalRef.current = "";
    activeTranslationIdRef.current = "";
    activeBackendSessionIdRef.current = "";
    activeBackendTranslationJobIdRef.current = "";
    latestTranslationSequenceRef.current = 0;
    finalTranslationsRef.current = {};
    pendingFinalTranscriptRef.current = null;
    pendingFinalTranscriptsRef.current.clear();
    dubbingLifecycleRef.current?.resetSeen();
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

  const handleNavbarNavigate = (target: "dashboard" | "help" | "pricing" | "settings" | "login" | "admin") => {
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
    const translationEntries: TranscriptTranslationEntry[] = displayTranslationEntries.map(([language, translatedText, translationState, diagnostic]) => ({
      language,
      label: `${languageName(language)} (${language.toUpperCase()})`,
      text: translatedText,
      state: translationStateLabel(translationState),
      diagnostic
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

    const handleAudioSourceChange = (source: AudioSourceMode) => {
      if (isRecording) return;
      setAudioSource(source);
    };

    return (
      <main className="mx-auto w-full max-w-5xl space-y-8 px-4 pb-16 sm:px-6">
        <HeroSection />

        <div className="space-y-6">
          <ModeTabs activeMode={privacyMode} disabled={isRecording} onChange={handlePrivacyModeChange} />
          <ToolTabs activeTool={mode} disabled={isRecording} onChange={selectMode} />
          {isDesktopChrome() && isTabAudioCaptureSupported(typeof navigator !== "undefined" ? navigator.mediaDevices : undefined) && (
            <AudioSourceTabs activeSource={audioSource} disabled={isRecording} onChange={handleAudioSourceChange} />
          )}
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
          microphoneLabel={microphoneStatusLabel}
          alert={alert || microphoneNotice}
          aiDegraded={aiDegraded}
          onMicClick={handleMicClick}
          onSpeakTranslation={speakTranslatedCaption}
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

          <div ref={conversationHistoryRef} className="max-h-72 scroll-smooth overflow-y-auto overscroll-contain pb-3 pt-4 pr-1 [scrollbar-gutter:stable]">
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
    const priceFor = (monthly: number) => yearly ? yearlyMonthlyPrice(monthly) : monthly;
    const formatPrice = (price: number) => Number.isInteger(price) ? String(price) : price.toFixed(2);

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
              <p className="text-xl font-black text-gray-950">{plan.name.toUpperCase()}</p>
              <p className="mt-4 text-4xl font-black text-gray-950">${formatPrice(priceFor(plan.monthlyPrice))}<span className="text-sm text-gray-500">/mo</span></p>
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
            <p className="text-xl font-black text-gray-950">ENTERPRISE</p>
            <p className="mt-4 text-3xl font-black text-gray-950">Custom</p>
            <ul className="mt-5 space-y-3 text-sm text-gray-600">
              {["Custom pricing", "Unlimited team members", "Dedicated onboarding", "Security review", "API access", "Dedicated support"].map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                  {feature}
                </li>
              ))}
            </ul>
            <button onClick={() => setAlert("Enterprise contact form is ready for your sales workflow.")} className="mt-6 w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm font-black text-gray-800 hover:bg-gray-50">
              Contact Sales
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
            {isAdminRole(user?.role) && (
              <button onClick={() => navigate("admin")} className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 font-bold text-blue-700 hover:bg-blue-100">
                <Shield className="h-4 w-4" />
                Admin Dashboard
              </button>
            )}
            <button onClick={() => navigate("subscription")} className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-200 bg-white px-4 py-3 font-bold text-blue-700">Subscription</button>
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
    <div className="min-h-dvh min-w-0 bg-gray-50 text-gray-900">
      {renderTopNav()}
      {view === "landing" && renderLanding()}
      {view === "login" && <AuthPage mode="login" authProvider={authProvider} error={authError} onSubmit={handleAuthSubmit} onGoogle={handleGoogleLogin} onGoogleError={setAuthError} onNavigate={navigate} />}
      {view === "signup" && <AuthPage mode="signup" authProvider={authProvider} error={authError} onSubmit={handleAuthSubmit} onGoogle={handleGoogleLogin} onGoogleError={setAuthError} onNavigate={navigate} />}
      {view === "admin-login" && <AdminLogin api={API} error={authError} busy={authProvider === "manual"} onLogin={(email, password) => void handleAuthSubmit({ email, password })} />}
      {view === "dashboard" && isAuthed && renderDashboard()}
      {view === "pricing" && renderPricing()}
      {view === "subscription" && isAuthed && <SubscriptionPage user={user} />}
      {view === "admin" && token && isAdminRole(user?.role) && <AdminDashboard api={API} token={token} currentUser={user as any} onLogout={() => void logout()} onUnauthorized={handleAdminUnauthorized} onForbidden={handleAdminForbidden} />}
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
