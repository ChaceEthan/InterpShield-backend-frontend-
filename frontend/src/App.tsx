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
import { AnimatePresence, motion } from "motion/react";
import { io, type Socket } from "socket.io-client";

type View = "landing" | "login" | "signup" | "dashboard" | "pricing" | "history" | "help" | "settings";
type Mode = "transcribe" | "translate" | "dubbing";
type SessionStatus = "idle" | "connecting" | "listening" | "stopping" | "error";
type TranslationStatus = "idle" | "pending" | "live" | "stale";
type Plan = "free" | "pro";
type SummaryLength = "short" | "standard" | "long";

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
  settings?: UserSettings;
}

interface AppConfig {
  status: "ok";
  services: {
    deepgram: boolean;
    gemini: boolean;
    googleTranslate: boolean;
  };
  backend: boolean;
  hasDeepgramKey: boolean;
  hasGeminiKey: boolean;
  hasGoogleTranslateKey: boolean;
  hasGoogleClientId: boolean;
  mode: "production" | "demo";
  maxSessionSeconds: number;
  audioChunkMs: number;
}

interface InterpretationResult {
  originalText: string;
  translatedText: string;
  isFinal: boolean;
  sourceLang: string;
  targetLang: string;
  detectedLanguage?: string;
  latencyMs?: number;
}

interface HistoryItem {
  id: string;
  title: string;
  sourceLang: string;
  targetLang: string;
  originalText: string;
  translatedText: string;
  durationSeconds: number;
  createdAt: string;
}

interface GoogleCredentialResponse {
  credential?: string;
  select_by?: string;
}

declare global {
  interface Window {
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
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const AUDIO_MIME_TYPES = ["audio/webm", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
const VIEWS: View[] = ["landing", "login", "signup", "dashboard", "pricing", "history", "help", "settings"];
const PROTECTED_VIEWS = new Set<View>(["dashboard", "history", "settings"]);

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
  { code: "ru", name: "Russian", region: "Global" }
];

const TOOL_ITEMS: Array<{ mode: Mode; label: string; icon: LucideIcon }> = [
  { mode: "transcribe", label: "Transcribe", icon: FileText },
  { mode: "translate", label: "Translate", icon: Languages },
  { mode: "dubbing", label: "Dubbing", icon: Volume2 }
];

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

const readStoredToken = () => sessionStorage.getItem("interp_shield_token") || localStorage.getItem("interp_shield_token");
const readStoredUser = () => sessionStorage.getItem("interp_shield_user") || localStorage.getItem("interp_shield_user");

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
  const audio: MediaTrackConstraints = {
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    sampleRate: { ideal: 44100 },
    channelCount: { ideal: 1 },
    sampleSize: { ideal: 16 }
  };

  if (microphoneId !== "default") audio.deviceId = { exact: microphoneId };
  return audio;
};

const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

const languageName = (code: string) => LANGUAGES.find((language) => language.code === code)?.name || code;

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
  sessionStorage.removeItem("interp_shield_token");
  sessionStorage.removeItem("interp_shield_user");
  localStorage.removeItem("interp_shield_token");
  localStorage.removeItem("interp_shield_user");
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
  <section className={`rounded-xl border border-white/10 bg-white/[0.055] shadow-2xl shadow-slate-950/30 backdrop-blur-xl ${className}`}>{children}</section>
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
  <button type="button" onClick={() => onChange(!value)} className="flex w-full items-center justify-between gap-4 rounded-lg border border-white/10 bg-slate-950/45 px-4 py-3 text-left transition hover:bg-white/[0.07]">
    <span>
      <span className="block text-sm font-bold text-white">{label}</span>
      {description && <span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span>}
    </span>
    <span className={`flex h-6 w-11 shrink-0 items-center rounded-full p-1 transition ${value ? "bg-blue-500" : "bg-slate-700"}`}>
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
    <span className="text-xs font-bold uppercase tracking-widest text-slate-500">{label}</span>
    <span className="relative mt-2 block">
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full appearance-none rounded-lg border border-white/10 bg-slate-950/75 px-3 py-3 pr-9 text-sm font-semibold text-white outline-none focus:border-blue-500/50">
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
    </span>
  </label>
);

const TypingSubtitle = ({ text, muted = false, empty = "Waiting for speech..." }: { text: string; muted?: boolean; empty?: string }) => {
  const [visibleText, setVisibleText] = useState("");

  useEffect(() => {
    const cleanText = text.trim();
    if (!cleanText) {
      setVisibleText("");
      return;
    }

    let index = 0;
    const step = Math.max(1, Math.ceil(cleanText.length / 80));
    setVisibleText("");

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

const GoogleSignIn = ({
  loading,
  onCredential,
  onError
}: {
  loading: boolean;
  onCredential: (credential: string) => void;
  onError: (message: string) => void;
}) => {
  const [loaded, setLoaded] = useState(false);
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const renderedRef = useRef(false);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    const existingScript = document.querySelector<HTMLScriptElement>("script[data-google-identity]");
    if (existingScript) {
      setLoaded(true);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.onload = () => setLoaded(true);
    script.onerror = () => onError("Unable to load Google Sign-In. Check your network and try again.");
    document.head.appendChild(script);
  }, [onError]);

  useEffect(() => {
    if (!loaded || !GOOGLE_CLIENT_ID || !window.google) return;

    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      auto_select: false,
      cancel_on_tap_outside: true,
      callback: (response) => {
        if (!response.credential) {
          onError("Google did not return a valid credential.");
          return;
        }

        onCredential(response.credential);
      }
    });

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
      <button type="button" onClick={() => onError("Google Sign-In is not configured for this deployment.")} className="flex w-full items-center justify-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-800 shadow-lg shadow-slate-950/20 transition hover:-translate-y-0.5 hover:bg-slate-50">
        <GoogleIcon />
        Continue with Google
      </button>
    );
  }

  return (
    <div className="relative flex min-h-11 w-full items-center justify-center overflow-hidden rounded-lg bg-white shadow-lg shadow-slate-950/20 transition hover:-translate-y-0.5">
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
  loading,
  error,
  onSubmit,
  onGoogle,
  onGoogleError,
  onNavigate
}: {
  mode: "login" | "signup";
  loading: boolean;
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

  return (
    <main className="mx-auto grid min-h-[calc(100vh-76px)] w-full max-w-6xl grid-cols-1 gap-8 px-5 py-10 lg:grid-cols-[1fr_420px] lg:items-center">
      <div className="space-y-6">
        <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-blue-100">
          <Shield className="h-3.5 w-3.5" />
          Secure interpreter workspace
        </div>
        <div className="max-w-2xl">
          <h1 className="text-5xl font-black tracking-normal text-white md:text-7xl">Live Translate</h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-slate-400">Professional live captions, translation, and AI meeting tools in one workspace.</p>
        </div>
      </div>

      <GlassPanel className="p-6">
        <div className="mb-6">
          <p className="text-xl font-black text-white">{isSignup ? "Create account" : "Welcome back"}</p>
          <p className="mt-1 text-sm text-slate-500">{isSignup ? "Start your InterpShield workspace." : "Login to open your dashboard."}</p>
        </div>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({ name, email, password });
          }}
        >
          {isSignup && (
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-blue-500/50" placeholder="Isaac David" />
            </label>
          )}

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Email</span>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-blue-500/50" placeholder="you@example.com" required />
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-blue-500/50" placeholder="Minimum 6 characters" required />
          </label>

          {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-100">{error}</div>}

          <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-500 px-4 py-3 text-sm font-black text-slate-950 transition hover:bg-white disabled:cursor-wait disabled:opacity-70">
            <KeyRound className="h-4 w-4" />
            {loading ? "Please wait..." : isSignup ? "Sign up" : "Login"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs font-bold uppercase tracking-widest text-slate-600">
          <span className="h-px flex-1 bg-white/10" />
          or
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <GoogleSignIn loading={loading} onCredential={onGoogle} onError={onGoogleError} />

        <button onClick={() => onNavigate(isSignup ? "login" : "signup")} className="mt-4 w-full rounded-lg border border-white/10 px-4 py-3 text-sm font-bold text-slate-300 hover:bg-white/5">
          {isSignup ? "Already have an account? Login" : "New here? Create an account"}
        </button>
      </GlassPanel>
    </main>
  );
};

export default function App() {
  const [view, setView] = useState<View>(initialView);
  const [user, setUser] = useState<AppUser | null>(() => {
    const stored = readStoredUser();
    return stored ? (JSON.parse(stored) as AppUser) : null;
  });
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">("monthly");
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);

  const [mode, setMode] = useState<Mode>("translate");
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("es");
  const [privateMode, setPrivateMode] = useState(true);
  const [shareableMode, setShareableMode] = useState(false);
  const [twoWay, setTwoWay] = useState(false);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [originalSegments, setOriginalSegments] = useState<string[]>([]);
  const [translatedSegments, setTranslatedSegments] = useState<string[]>([]);
  const [interimOriginal, setInterimOriginal] = useState("");
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const [translationStatus, setTranslationStatus] = useState<TranslationStatus>("idle");
  const [translationProvider, setTranslationProvider] = useState<string | null>(null);
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

  const socketRef = useRef<Socket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingRef = useRef(false);
  const modeRef = useRef<Mode>("translate");
  const activeSessionPayloadRef = useRef<{
    sourceLang: string;
    targetLang: string;
    translate: boolean;
    twoWay: boolean;
    mimeType: string;
  } | null>(null);
  const shouldRestartSessionOnReconnectRef = useRef(false);
  const sequenceRef = useRef(0);
  const sessionStartedAtRef = useRef<number | null>(null);
  const lastInterimRef = useRef("");
  const lastFinalOriginalRef = useRef("");
  const lastFinalTranslationRef = useRef("");
  const interimTimerRef = useRef<number | null>(null);

  const isAuthed = Boolean(user && token);
  const isPro = user?.plan === "pro";
  const isRecording = status === "connecting" || status === "listening";
  const latestOriginal = interimOriginal || originalSegments.at(-1) || "";
  const latestTranslation = translatedSegments.at(-1) || "";
  const maxSessionSeconds = config?.maxSessionSeconds || 120;
  const statusLabel = status === "connecting" ? "Connecting" : status === "listening" ? "Live" : status === "stopping" ? "Stopping" : status === "error" ? "Attention" : "Ready";
  const translationStatusLabel =
    translationStatus === "pending"
      ? latestTranslation
        ? "Translating new speech. Keeping the last stable line on screen."
        : "Translating speech..."
      : translationStatus === "stale"
        ? latestTranslation
          ? "Network is slow. Showing the last successful translation."
          : "Translation is catching up. Waiting for the first stable line."
        : translationStatus === "live"
          ? `Stable translation${translationProvider ? ` via ${translationProvider === "google" ? "Google Translate" : "Gemini"}` : ""}.`
          : "";

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
      setMicrophones(devices.filter((device) => device.kind === "audioinput"));
    } catch {
      setMicrophones([]);
    }
  }, []);

  const applyUserSettings = (settings?: UserSettings) => {
    if (!settings) return;

    setSourceLang(settings.preferredSourceLang || "en");
    setTargetLang(settings.preferredTargetLang || "es");
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
  }, [fetchConfig, refreshMicrophones]);

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
    recordingRef.current = isRecording;
  }, [isRecording]);

  const cleanupMedia = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    mediaRecorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recordingRef.current = false;
    activeSessionPayloadRef.current = null;
    shouldRestartSessionOnReconnectRef.current = false;
    sessionStartedAtRef.current = null;
  }, []);

  const stopSession = useCallback(() => {
    setStatus("stopping");
    cleanupMedia();
    socketRef.current?.emit("end_session");
    setStatus("idle");
  }, [cleanupMedia]);

  useEffect(() => {
    if (!token || !user) return undefined;

    if (!API) {
      setAlert("Backend API URL is missing. Set VITE_API_URL and restart the frontend.");
      return undefined;
    }

    const socket = io(API, {
      auth: { token },
      transports: ["websocket"],
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 650
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("Socket connected");
      setAlert((current) => (current === "Unable to reach InterpShield. Please try again." ? null : current));

      if (shouldRestartSessionOnReconnectRef.current && activeSessionPayloadRef.current) {
        shouldRestartSessionOnReconnectRef.current = false;
        socket.emit("start_session", activeSessionPayloadRef.current);
      }
    });

    socket.on("disconnect", () => {
      if (recordingRef.current) {
        shouldRestartSessionOnReconnectRef.current = true;
        setStatus("error");
        setAlert("Connection lost. Your session was paused.");
      }
    });

    socket.on("connect_error", () => {
      if (recordingRef.current) setAlert("Unable to reach the live interpreter.");
    });

    socket.on("server-config", (serverConfig: AppConfig) => setConfig(serverConfig));

    const markSessionReady = () => {
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === "inactive") {
        const chunkMs = Math.max(500, Math.min(800, config?.audioChunkMs || 700));
        recorder.start(chunkMs);
        console.log("Mic started");
        sessionStartedAtRef.current = Date.now();
        setSessionSeconds(0);
      }
      setStatus("listening");
    };

    socket.on("session_ready", markSessionReady);
    socket.on("session:ready", markSessionReady);
    socket.on("session:closed", () => setStatus((current) => (current === "stopping" ? "idle" : current)));
    socket.on("warning", ({ message }: { message?: string }) => {
      const warning = message || "";
      if (warning.includes("session limit") || warning.includes("silence")) setAlert(warning);
    });
    socket.on("translation_status", ({ state, provider }: { state?: TranslationStatus; provider?: string }) => {
      if (modeRef.current === "transcribe") return;
      if (state === "idle" || state === "pending" || state === "live" || state === "stale") {
        setTranslationStatus(state);
      }
      if (provider) setTranslationProvider(provider);
    });
    const handleSessionError = ({ message }: { message?: string }) => {
      setStatus("error");
      setAlert(message || "Real-time processing failed.");
    };

    socket.on("session_error", handleSessionError);
    socket.on("app-error", handleSessionError);

    socket.on("transcript_partial", ({ text, detectedLanguage }: { text?: string; detectedLanguage?: string }) => {
      const originalText = text?.trim() || "";
      if (!originalText || originalText === lastInterimRef.current) return;
      if (detectedLanguage) setDetectedLanguage(detectedLanguage);

      lastInterimRef.current = originalText;
      if (interimTimerRef.current) window.clearTimeout(interimTimerRef.current);
      interimTimerRef.current = window.setTimeout(() => {
        setInterimOriginal(originalText);
        interimTimerRef.current = null;
      }, 45);
      setStatus("listening");
    });

    socket.on("transcript_final", ({ text, detectedLanguage, latencyMs }: { text?: string; detectedLanguage?: string; latencyMs?: number }) => {
      const originalText = text?.trim() || "";
      if (!originalText || originalText === lastFinalOriginalRef.current) return;
      if (detectedLanguage) setDetectedLanguage(detectedLanguage);
      if (typeof latencyMs === "number") setLastLatency(latencyMs);

      lastInterimRef.current = "";
      lastFinalOriginalRef.current = originalText;
      setInterimOriginal("");
      setOriginalSegments((current) => [...current, originalText].slice(-40));
      if (modeRef.current !== "transcribe") setTranslationStatus("pending");
      setStatus("listening");
    });

    socket.on("translation_update", ({ text, latencyMs, provider, stale }: { text?: string; latencyMs?: number; provider?: string; stale?: boolean }) => {
      const nextTranslation = text?.trim() || "";
      if (typeof latencyMs === "number") setLastLatency(latencyMs);
      if (provider) setTranslationProvider(provider);

      if (!nextTranslation) return;

      setTranslationStatus(stale ? "stale" : "live");
      if (nextTranslation === lastFinalTranslationRef.current) return;

      lastFinalTranslationRef.current = nextTranslation;
      setTranslatedSegments((current) => [...current, nextTranslation].slice(-40));
    });

    return () => {
      if (interimTimerRef.current) window.clearTimeout(interimTimerRef.current);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [config?.audioChunkMs, token, user]);

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
    if (mode !== "dubbing" || translatedSegments.length === 0 || !("speechSynthesis" in window)) return;

    const latest = translatedSegments.at(-1);
    if (!latest) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(latest);
    utterance.lang = targetLang;
    window.speechSynthesis.speak(utterance);
  }, [mode, targetLang, translatedSegments]);

  const applyAuthSession = (session: { token: string; user: AppUser }) => {
    setToken(session.token);
    setUser(session.user);
    saveSession(session.token, session.user);
    applyUserSettings(session.user.settings);
    setAuthError(null);
    navigate("dashboard");
  };

  const handleAuthSubmit = async (payload: { name?: string; email: string; password: string }) => {
    setAuthLoading(true);
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
      setAuthLoading(false);
    }
  };

  const handleGoogleLogin = useCallback(async (credential: string) => {
    setAuthLoading(true);
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
      setAuthLoading(false);
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
      setHistory(data.history);
    } catch {
      setAlert("Unable to load history.");
    }
  }, [token]);

  useEffect(() => {
    if (view === "history") void fetchHistory();
  }, [fetchHistory, view]);

  const startSession = useCallback(async () => {
    if (!isAuthed) {
      navigate("login");
      return;
    }

    setAlert(null);
    setStatus("connecting");
    setDetectedLanguage(null);
    setChunkCount(0);
    setLastLatency(null);
    setTranslationStatus("idle");
    setTranslationProvider(null);
    sequenceRef.current = 0;
    lastInterimRef.current = "";
    lastFinalOriginalRef.current = "";
    lastFinalTranslationRef.current = "";
    if (interimTimerRef.current) {
      window.clearTimeout(interimTimerRef.current);
      interimTimerRef.current = null;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setAlert("Microphone not detected");
      return;
    }

    if (!("MediaRecorder" in window)) {
      setStatus("error");
      setAlert("Microphone recording is not supported in this browser.");
      return;
    }

    try {
      if (!socketRef.current?.connected) socketRef.current?.connect();

      const audio = buildAudioConstraints({
        microphoneId,
        echoCancellation,
        noiseSuppression,
        autoGainControl
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      streamRef.current = stream;
      void refreshMicrophones();

      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 96_000
      });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size < 128 || !socketRef.current?.connected) return;

        socketRef.current.emit("audio_chunk", event.data);
        console.log("Audio chunk sent");
        sequenceRef.current += 1;
        setChunkCount((current) => current + 1);
      };

      recorder.onerror = () => {
        setStatus("error");
        setAlert("Microphone recording stopped unexpectedly.");
        cleanupMedia();
      };

      const sessionPayload = {
        sourceLang,
        targetLang,
        translate: modeRef.current !== "transcribe",
        twoWay,
        mimeType: "audio/webm"
      };
      activeSessionPayloadRef.current = sessionPayload;
      shouldRestartSessionOnReconnectRef.current = false;

      socketRef.current?.timeout(8000).emit(
        "start_session",
        sessionPayload,
        (timeoutError: Error | null, response?: { ok?: boolean; error?: string }) => {
          if (timeoutError || response?.error) {
            cleanupMedia();
            setStatus("error");
            setAlert(response?.error || "Unable to reach the live interpreter.");
          }
        }
      );
    } catch (error) {
      cleanupMedia();
      setStatus("error");

      if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")) {
        setAlert("Microphone not detected");
        return;
      }

      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
        setAlert("Microphone permission denied");
        return;
      }

      setAlert("Microphone not detected");
    }
  }, [autoGainControl, cleanupMedia, echoCancellation, isAuthed, microphoneId, navigate, noiseSuppression, refreshMicrophones, sourceLang, targetLang, twoWay]);

  const selectMode = (nextMode: Mode) => {
    setMode(nextMode);
  };

  const swapLanguages = () => {
    if (isRecording) return;
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
  };

  const clearLiveSession = () => {
    setOriginalSegments([]);
    setTranslatedSegments([]);
    setInterimOriginal("");
    setSessionSeconds(0);
    setChunkCount(0);
    setLastLatency(null);
    setTranslationStatus("idle");
    setTranslationProvider(null);
    setDetectedLanguage(null);
    lastInterimRef.current = "";
    lastFinalOriginalRef.current = "";
    lastFinalTranslationRef.current = "";
    if (interimTimerRef.current) {
      window.clearTimeout(interimTimerRef.current);
      interimTimerRef.current = null;
    }
  };

  const persistSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    const settings = { [key]: value } as UserSettings;
    void updateSettings(settings);
  };

  const renderTopNav = () => (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-slate-950/82 px-4 py-3 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3">
        <button onClick={() => navigate(isAuthed ? "dashboard" : "landing")} className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500 text-white shadow-lg shadow-blue-500/20">
            <Shield className="h-5 w-5" />
          </div>
          <div className="text-left">
            <p className="text-lg font-black tracking-normal text-white">InterpShield</p>
            <p className="text-xs font-semibold text-slate-500">Built by Isaac David</p>
          </div>
        </button>

        <nav className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-400">
          <button onClick={() => navigate("pricing")} className="flex items-center gap-2 rounded-lg bg-blue-500 px-4 py-2 font-black text-white hover:bg-blue-400">
            <Crown className="h-4 w-4" />
            Get Pro
          </button>
          <button onClick={() => navigate("history")} className="rounded-lg px-3 py-2 hover:bg-white/5 hover:text-white">History</button>
          <button onClick={() => (isAuthed ? setSettingsOpen((current) => !current) : navigate("login"))} className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-white/5 hover:text-white">
            <Settings className="h-4 w-4" />
            Settings
          </button>
          {isAuthed ? (
            <button onClick={() => navigate("settings")} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2 py-1.5">
              <FlagUs />
              <span className="hidden text-xs font-bold text-slate-300 sm:inline">{user?.name.split(" ")[0]}</span>
            </button>
          ) : (
            <button onClick={() => navigate("login")} className="rounded-lg px-3 py-2 hover:bg-white/5 hover:text-white">Login</button>
          )}
        </nav>
      </div>

      <AnimatePresence>
        {settingsOpen && isAuthed && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="absolute right-4 top-[68px] z-40 w-80 rounded-xl border border-white/10 bg-slate-950 p-4 shadow-2xl">
            <p className="text-sm font-black text-white">Settings</p>
            <div className="mt-3 space-y-2 text-sm">
              <button onClick={() => navigate("settings")} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-slate-300 hover:bg-white/5">
                <Languages className="h-4 w-4" />
                Language preferences
              </button>
              <button onClick={() => navigate("settings")} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-slate-300 hover:bg-white/5">
                <SlidersHorizontal className="h-4 w-4" />
                Audio and AI settings
              </button>
              <button onClick={() => void logout()} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-red-200 hover:bg-red-500/10">
                <LogOut className="h-4 w-4" />
                Logout
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );

  const renderLanding = () => (
    <main className="mx-auto w-full max-w-7xl px-5 py-8">
      <section className="grid min-h-[calc(100vh-150px)] grid-cols-1 gap-8 lg:grid-cols-[1fr_520px] lg:items-center">
        <div className="space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-blue-100">
            <Sparkles className="h-3.5 w-3.5" />
            AI live interpreter SaaS
          </div>
          <h1 className="max-w-4xl text-6xl font-black tracking-normal text-white md:text-8xl">Live Translate</h1>
          <p className="max-w-xl text-lg leading-8 text-slate-400">Generate translated captions in real-time with a secure SaaS workspace for sessions, summaries, history, and Pro tools.</p>
          <div className="flex flex-wrap gap-3">
            <button onClick={() => navigate("signup")} className="rounded-lg bg-blue-500 px-5 py-3 text-sm font-black text-slate-950 shadow-lg shadow-blue-500/20 hover:bg-white">Start free</button>
            <button onClick={() => navigate("login")} className="rounded-lg border border-white/10 bg-white/5 px-5 py-3 text-sm font-bold text-white hover:bg-white/10">Login</button>
          </div>
        </div>

        <GlassPanel className="overflow-hidden">
          <div className="aspect-video bg-[linear-gradient(135deg,rgba(14,165,233,0.22),rgba(15,23,42,0.1)),radial-gradient(circle_at_top,rgba(34,211,238,0.18),transparent_45%)] p-5">
            <div className="flex h-full flex-col justify-between rounded-xl border border-white/10 bg-slate-950/65 p-5">
              <div className="flex items-center justify-between text-xs font-bold uppercase tracking-widest text-slate-500">
                <span>Interpreter Preview</span>
                <span>00:18 live</span>
              </div>
              <div className="space-y-4 text-center">
                <p className="text-sm font-bold uppercase tracking-widest text-slate-500">Original</p>
                <p className="text-base font-bold text-slate-300">We can begin the product demo now.</p>
                <p className="pt-4 text-sm font-bold uppercase tracking-widest text-blue-300">Spanish</p>
                <p className="text-3xl font-black leading-tight text-white md:text-4xl">Podemos comenzar la demostracion ahora.</p>
              </div>
              <div className="flex items-center justify-center">
                <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-4 py-2 text-xs font-bold uppercase tracking-widest text-blue-100">Subtitles streaming</span>
              </div>
            </div>
          </div>
        </GlassPanel>
      </section>
    </main>
  );

  const renderDashboard = () => (
    <main className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-5 px-4 py-5 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-4">
        <GlassPanel className="p-4">
          <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">Tools</p>
          <div className="space-y-2">
            <button onClick={() => { setPrivateMode(!privateMode); persistSetting("privateMode", !privateMode); }} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm font-bold ${privateMode ? "border-blue-500/20 bg-blue-500/10 text-blue-100" : "border-white/10 bg-slate-950/50 text-slate-400"}`}>
              <span className="flex items-center gap-2"><Lock className="h-4 w-4" />Private Mode</span>
              <span>{privateMode ? "On" : "Off"}</span>
            </button>
            <button onClick={() => { setShareableMode(!shareableMode); persistSetting("shareableMode", !shareableMode); }} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm font-bold ${shareableMode ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200" : "border-white/10 bg-slate-950/50 text-slate-400"}`}>
              <span className="flex items-center gap-2"><Share2 className="h-4 w-4" />Shareable</span>
              <span>{shareableMode ? "On" : "Off"}</span>
            </button>
            {TOOL_ITEMS.map(({ mode: toolMode, label, icon: Icon }) => (
              <button key={toolMode} onClick={() => selectMode(toolMode)} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm font-bold ${mode === toolMode ? "border-white/20 bg-white/10 text-white" : "border-white/10 bg-slate-950/50 text-slate-400 hover:text-white"}`}>
                <span className="flex items-center gap-2"><Icon className="h-4 w-4" />{label}</span>
              </button>
            ))}
          </div>
        </GlassPanel>

      </aside>

      <section className="space-y-5">
        <GlassPanel className="p-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-end">
            <LanguageSelect label="Speaker Language" value={sourceLang} disabled={isRecording} onChange={setSourceLang} />
            <button onClick={swapLanguages} disabled={isRecording} className="flex h-12 w-12 items-center justify-center self-center rounded-lg border border-white/10 bg-slate-950/70 text-slate-400 hover:border-blue-500/40 hover:text-white disabled:opacity-40 lg:self-end" aria-label="Swap languages">
              <ArrowRightLeft className="h-5 w-5" />
            </button>
            <LanguageSelect label="Translation Language" value={targetLang} disabled={isRecording} onChange={setTargetLang} />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
            <button onClick={() => setTwoWay((current) => !current)} className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-bold ${twoWay ? "border-blue-500/20 bg-blue-500/10 text-blue-100" : "border-white/10 bg-slate-950/60 text-slate-400 hover:text-white"}`}>
              <ArrowRightLeft className="h-4 w-4" />
              Two-way translation
            </button>
          </div>
        </GlassPanel>

        <GlassPanel className="overflow-hidden">
          <div className="flex flex-col gap-2 border-b border-white/10 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-xl font-black text-white">Live AI Interpreter</h1>
              <p className="mt-1 text-sm font-semibold text-slate-400">{languageName(detectedLanguage || sourceLang)} <span className="text-slate-600">-&gt;</span> {languageName(targetLang)}</p>
            </div>
            <span className={`w-fit rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider ${status === "listening" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300" : status === "error" ? "border-red-500/20 bg-red-500/10 text-red-200" : "border-white/10 bg-slate-950/60 text-slate-400"}`}>
              {statusLabel}
            </span>
          </div>

          <div className="flex min-h-[430px] flex-col justify-between p-5">
            <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center text-center">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">Original text</p>
              <p className="mx-auto min-h-10 max-w-3xl text-base font-semibold leading-7 text-slate-400 md:text-lg">
                <TypingSubtitle text={latestOriginal} muted={Boolean(interimOriginal)} empty="Waiting for speech." />
              </p>

              <div className="mx-auto mt-8 w-full max-w-3xl rounded-xl border border-blue-500/10 bg-blue-500/[0.045] p-5 md:p-7">
                <p className="mb-3 text-xs font-bold uppercase tracking-widest text-blue-100/70">Translated text</p>
                <p className="min-h-24 text-2xl font-black leading-snug tracking-normal text-white sm:text-3xl md:text-4xl">
                  <TypingSubtitle text={mode === "transcribe" ? latestOriginal : latestTranslation} empty="Translated subtitles appear here." />
                </p>
                {mode !== "transcribe" && translationStatusLabel && (
                  <p className={`mt-4 text-xs font-bold uppercase tracking-widest ${translationStatus === "stale" ? "text-amber-200" : translationStatus === "pending" ? "text-blue-100/70" : "text-emerald-200"}`}>
                    {translationStatusLabel}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-8 flex flex-col items-center gap-3">
              <button onClick={!isRecording ? () => void startSession() : stopSession} disabled={status === "stopping"} className={`relative flex h-20 w-20 items-center justify-center rounded-full text-white shadow-2xl transition hover:scale-105 disabled:cursor-wait disabled:opacity-70 ${isRecording ? "bg-red-500 shadow-red-500/25" : "bg-blue-500 text-white shadow-blue-500/25"}`} aria-label={isRecording ? "Stop recording" : "Start recording"}>
                {isRecording && <span className="pulse-ring absolute inset-0 rounded-full border border-white/70" />}
                {isRecording ? <CircleStop className="h-8 w-8" /> : <Mic className="h-8 w-8" />}
              </button>
              <p className="text-sm font-bold text-slate-300">Press and hold to talk</p>
              <div className="flex flex-wrap justify-center gap-2 text-xs">
                <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 font-mono text-slate-300"><Timer className="h-3.5 w-3.5 text-slate-500" />{formatTime(sessionSeconds)}</span>
                <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 font-bold uppercase tracking-wider text-slate-500">2 min max session</span>
                {chunkCount > 0 && <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 font-bold text-slate-500">{chunkCount} chunks</span>}
                {lastLatency !== null && <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 font-bold text-emerald-300">{lastLatency}ms</span>}
              </div>
            </div>
          </div>
        </GlassPanel>

        <AnimatePresence>
          {alert && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <p>{alert}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex justify-end">
          <button onClick={clearLiveSession} className="text-sm font-bold text-slate-500 hover:text-white">Clear subtitles</button>
        </div>
      </section>
    </main>
  );

  const renderPricing = () => {
    const yearly = billingCycle === "yearly";
    const priceFor = (monthly: number) => Math.round(monthly * (yearly ? 0.8 : 1));

    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-10">
        <div className="mb-8 flex flex-col gap-4 text-center md:items-center">
          <p className="text-xs font-bold uppercase tracking-widest text-blue-300">Pricing</p>
          <h1 className="text-4xl font-black text-white md:text-5xl">Plans for every live workflow</h1>
          <div className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-slate-950/70 p-1">
            <button onClick={() => setBillingCycle("monthly")} className={`rounded-full px-4 py-2 text-sm font-bold ${billingCycle === "monthly" ? "bg-white text-slate-950" : "text-slate-400"}`}>Monthly</button>
            <button onClick={() => setBillingCycle("yearly")} className={`rounded-full px-4 py-2 text-sm font-bold ${billingCycle === "yearly" ? "bg-blue-500 text-white" : "text-slate-400"}`}>Yearly</button>
            <span className="pr-3 text-xs font-bold uppercase tracking-widest text-blue-300">Save 20% yearly</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {PRICING_PLANS.map((plan) => (
            <GlassPanel key={plan.name} className={`p-5 ${plan.highlighted ? "border-blue-500/35" : ""}`}>
              {plan.highlighted && <span className="mb-3 inline-flex rounded-full bg-blue-500 px-3 py-1 text-xs font-black uppercase tracking-wider text-slate-950">Popular</span>}
              <p className="text-xl font-black text-white">{plan.name}</p>
              <p className="mt-4 text-4xl font-black text-white">${priceFor(plan.monthly)}<span className="text-sm text-slate-500">/mo</span></p>
              <ul className="mt-5 space-y-3 text-sm text-slate-300">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                    {feature}
                  </li>
                ))}
              </ul>
              <button onClick={() => void upgradePlan()} className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-black ${plan.highlighted ? "bg-blue-500 text-white hover:bg-white" : "border border-white/10 bg-white/5 text-white hover:bg-white/10"}`}>
                Subscribe
              </button>
            </GlassPanel>
          ))}

          <GlassPanel className="p-5">
            <p className="text-xl font-black text-white">Enterprise</p>
            <p className="mt-4 text-3xl font-black text-white">Custom</p>
            <ul className="mt-5 space-y-3 text-sm text-slate-300">
              {["Custom pricing", "Dedicated onboarding", "Security review", "Contact form"].map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                  {feature}
                </li>
              ))}
            </ul>
            <button onClick={() => setAlert("Enterprise contact form is ready for your sales workflow.")} className="mt-6 w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm font-black text-white hover:bg-white/10">
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
          <p className="text-xs font-bold uppercase tracking-widest text-slate-500">History</p>
          <h1 className="mt-2 text-4xl font-black text-white">Session history</h1>
        </div>
        <button onClick={() => void fetchHistory()} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-white/10">Refresh</button>
      </div>
      <div className="space-y-3">
        {history.length === 0 && <GlassPanel className="p-6 text-sm text-slate-500">No saved sessions yet.</GlassPanel>}
        {history.map((item) => (
          <GlassPanel key={item.id} className="p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="font-black text-white">{item.title}</p>
                <p className="mt-1 text-xs font-bold uppercase tracking-widest text-slate-500">{languageName(item.sourceLang)} to {languageName(item.targetLang)} - {new Date(item.createdAt).toLocaleString()}</p>
              </div>
              <button onClick={() => (isPro ? setAlert("History export prepared.") : navigate("pricing"))} className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm font-bold text-slate-300 hover:bg-white/5">
                <Download className="h-4 w-4" />
                Export
                {!isPro && <Lock className="h-3.5 w-3.5 text-amber-300" />}
              </button>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <p className="rounded-lg border border-white/10 bg-slate-950/60 p-3 text-sm text-slate-300">{item.originalText || "No transcript text"}</p>
              <p className="rounded-lg border border-blue-500/10 bg-blue-500/5 p-3 text-sm text-blue-50">{item.translatedText || "No translation text"}</p>
            </div>
          </GlassPanel>
        ))}
      </div>
    </main>
  );

  const renderHelp = () => (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <h1 className="text-5xl font-black text-white">Help</h1>
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        {[
          ["Microphone", "Allow microphone permission in your browser or Android WebView."],
          ["Live sessions", "Use the mic button to stream short audio chunks for low-latency subtitles."],
          ["Plans", "Upgrade from Pricing to unlock dubbing and exports."]
        ].map(([title, text]) => (
          <GlassPanel key={title} className="p-5">
            <BadgeHelp className="h-5 w-5 text-blue-300" />
            <p className="mt-4 font-black text-white">{title}</p>
            <p className="mt-2 text-sm leading-6 text-slate-500">{text}</p>
          </GlassPanel>
        ))}
      </div>
    </main>
  );

  const renderSettings = () => (
    <main className="mx-auto w-full max-w-6xl px-5 py-8">
      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Settings</p>
        <h1 className="mt-2 text-4xl font-black text-white">Workspace preferences</h1>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <GlassPanel className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-blue-300" />
            <p className="font-black text-white">General settings</p>
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
            <p className="font-black text-white">Audio processing</p>
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
            <p className="font-black text-white">AI settings</p>
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
            <ToggleRow label="Scene detection" value={sceneDetection} onChange={(value) => { setSceneDetection(value); persistSetting("sceneDetection", value); }} />
            <ToggleRow label="Action item extraction" value={actionItemExtraction} onChange={(value) => { setActionItemExtraction(value); persistSetting("actionItemExtraction", value); }} />
            <ToggleRow label="Per-speaker summary" value={perSpeakerSummary} onChange={(value) => { setPerSpeakerSummary(value); persistSetting("perSpeakerSummary", value); }} />
            <ToggleRow label="Sentiment tracking" value={sentimentTracking} onChange={(value) => { setSentimentTracking(value); persistSetting("sentimentTracking", value); }} />
            <ToggleRow label="Keywords extraction" value={keywordsExtraction} onChange={(value) => { setKeywordsExtraction(value); persistSetting("keywordsExtraction", value); }} />
          </div>
        </GlassPanel>

        <GlassPanel className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <User className="h-5 w-5 text-blue-300" />
            <p className="font-black text-white">Account</p>
          </div>
          <div className="space-y-3 text-sm text-slate-300">
            <div className="rounded-lg border border-white/10 bg-slate-950/45 p-4">
              <p className="font-black text-white">{user?.name}</p>
              <p className="mt-1 text-slate-500">{user?.email}</p>
              <p className="mt-3 w-fit rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-black uppercase tracking-widest text-blue-100">{user?.plan || "free"} plan</p>
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
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.14),transparent_30%),radial-gradient(circle_at_82%_14%,rgba(16,185,129,0.1),transparent_26%),linear-gradient(180deg,#020617,#0f172a_62%,#020617)]" />
      {renderTopNav()}
      {view === "landing" && renderLanding()}
      {view === "login" && <AuthPage mode="login" loading={authLoading} error={authError} onSubmit={handleAuthSubmit} onGoogle={handleGoogleLogin} onGoogleError={setAuthError} onNavigate={navigate} />}
      {view === "signup" && <AuthPage mode="signup" loading={authLoading} error={authError} onSubmit={handleAuthSubmit} onGoogle={handleGoogleLogin} onGoogleError={setAuthError} onNavigate={navigate} />}
      {view === "dashboard" && isAuthed && renderDashboard()}
      {view === "pricing" && renderPricing()}
      {view === "history" && isAuthed && renderHistory()}
      {view === "help" && renderHelp()}
      {view === "settings" && isAuthed && renderSettings()}

      <footer className="border-t border-white/10 px-5 py-5">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 text-xs text-slate-600 md:flex-row md:items-center md:justify-between">
          <span>InterpShield - Built by Isaac David</span>
          <span>Live captions, translation, dubbing, summaries, and session history.</span>
        </div>
      </footer>
    </div>
  );
}
