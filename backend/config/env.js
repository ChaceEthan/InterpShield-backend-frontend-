// @ts-nocheck
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { configureProjectRuntimePaths, getProjectPaths } from "../../project-paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(backendRoot, ".env"), quiet: true });
const projectPaths = getProjectPaths();
const runtimePathStatus = configureProjectRuntimePaths(projectPaths);

const placeholderValues = new Set([
  "",
  "null",
  "undefined",
  "your_deepgram_api_key",
  "your_gemini_api_key",
  "your_openai_key",
  "your_mongo_uri",
  "YOUR_DEEPGRAM_API_KEY_HERE",
  "YOUR_GEMINI_API_KEY_HERE",
  "YOUR_OPENAI_API_KEY_HERE"
]);

const readSecret = (value) => {
  const trimmed = value?.trim() || "";
  const unquoted = trimmed.match(/^(['"])(.*)\1$/)?.[2] || trimmed;
  return placeholderValues.has(unquoted) ? "" : unquoted;
};

const readNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));

const readBoolean = (value, fallback = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
};

const localClientOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];

const normalizeOrigin = (origin = "") => {
  const trimmed = origin.trim();
  if (!trimmed) return "";

  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return trimmed.replace(/\/$/, "").toLowerCase();
  }
};

const readClientOrigins = (...originValues) => {
  const configuredOrigins = originValues
    .filter(Boolean)
    .join(",")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  const allowLocalOrigins =
    process.env.ALLOW_LOCAL_ORIGINS === "true" ||
    (process.env.ALLOW_LOCAL_ORIGINS !== "false" && process.env.NODE_ENV !== "production");
  const origins = [...(allowLocalOrigins ? localClientOrigins : []), ...configuredOrigins];
  return [...new Set(origins)];
};

const requireHttpsOrigin = (origin = "") => {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

const debugFlags = {
  audio: readBoolean(process.env.AUDIO_DEBUG),
  socket: readBoolean(process.env.SOCKET_DEBUG),
  translation: readBoolean(process.env.TRANSLATION_DEBUG),
  provider: readBoolean(process.env.PROVIDER_DEBUG),
  env: readBoolean(process.env.ENV_DEBUG)
};

export const debugEnabled = (name) => Boolean(debugFlags[name] || readBoolean(process.env.DEBUG));

export const env = {
  port: readNumber(process.env.PORT, 10000),
  clientOrigins: readClientOrigins(process.env.CLIENT_URL, process.env.CORS_ORIGIN),
  allowVercelPreviewOrigins: process.env.ALLOW_VERCEL_PREVIEW_ORIGINS === "true",
  googleClientId: readSecret(process.env.GOOGLE_CLIENT_ID),
  googleClientSecret: readSecret(process.env.GOOGLE_CLIENT_SECRET),
  mongoUri: readSecret(process.env.MONGO_URI),
  deepgramApiKey: readSecret(process.env.DEEPGRAM_API_KEY),
  geminiApiKey: readSecret(process.env.GEMINI_API_KEY),
  openaiApiKey: readSecret(process.env.OPENAI_API_KEY),
  hasJwtSecret: Boolean(readSecret(process.env.JWT_SECRET)),
  jwtSecret: readSecret(process.env.JWT_SECRET),
  paths: projectPaths,
  runtimePathStatus,
  maxSessionSeconds: clampNumber(readNumber(process.env.MAX_SESSION_SECONDS, 14400), 600, 28800),
  audioChunkMs: clampNumber(readNumber(process.env.AUDIO_CHUNK_MS, 700), 500, 800),
  debugFlags
};

export const getMode = () => (env.deepgramApiKey && env.geminiApiKey ? "production" : "unavailable");

export const getPublicConfig = () => ({
  status: "ok",
  services: {
    deepgram: true,
    gemini: true,
    openai: Boolean(env.openaiApiKey)
  },
  backend: true,
  hasDeepgramKey: Boolean(env.deepgramApiKey),
  hasGeminiKey: Boolean(env.geminiApiKey),
  hasOpenAIKey: Boolean(env.openaiApiKey),
  hasGoogleClientId: Boolean(env.googleClientId),
  mode: getMode(),
  maxSessionSeconds: env.maxSessionSeconds,
  audioChunkMs: env.audioChunkMs,
  runtimeRoot: projectPaths.root
});

export const getConfigDiagnostics = () => {
  const errors = [];
  const warnings = [];

  if (!env.clientOrigins.length) {
    errors.push("CLIENT_URL or CORS_ORIGIN must be configured.");
  }

  for (const origin of env.clientOrigins) {
    if (!requireHttpsOrigin(origin)) {
      errors.push(`Client origin must be an HTTPS origin: ${origin}`);
    }
  }

  if (!Number.isFinite(env.port) || env.port <= 0) {
    errors.push("PORT must be a positive number.");
  }

  if (!env.jwtSecret) errors.push("JWT_SECRET is required.");
  if (!env.deepgramApiKey) errors.push("DEEPGRAM_API_KEY is required.");
  if (!env.geminiApiKey) errors.push("GEMINI_API_KEY is required.");
  if (!env.openaiApiKey) warnings.push("OPENAI_API_KEY is missing. OpenAI fallback translation is disabled.");
  if (!env.mongoUri) warnings.push("MONGO_URI is missing. Auth and saved history require MongoDB.");
  if (!env.googleClientId) warnings.push("GOOGLE_CLIENT_ID is not configured on the backend; frontend Google ID token verification still works without audience locking.");
  if (!env.googleClientSecret) warnings.push("GOOGLE_CLIENT_SECRET is not used by the current backend Google ID-token flow.");

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    clientOrigins: env.clientOrigins,
    allowVercelPreviewOrigins: env.allowVercelPreviewOrigins,
    allowLocalOrigins: env.clientOrigins.some((origin) => /localhost|127\.0\.0\.1/.test(origin)),
    debugFlags: env.debugFlags
  };
};

export const validateStartupConfig = () => {
  const diagnostics = getConfigDiagnostics();

  if (debugEnabled("env")) {
    console.info("[ENV_DIAGNOSTICS]", diagnostics);
  }

  if (!diagnostics.ok) {
    throw new Error(`Invalid InterpShield environment: ${diagnostics.errors.join("; ")}`);
  }

  return diagnostics;
};

export const warnAboutMissingConfig = () => {
  const diagnostics = getConfigDiagnostics();
  for (const warning of diagnostics.warnings) {
    console.warn(warning);
  }

  if (!env.deepgramApiKey) {
    console.warn("DEEPGRAM_API_KEY is missing. Speech-to-text is unavailable until it is configured.");
  }

  if (!env.geminiApiKey) {
    console.warn("GEMINI_API_KEY is missing. Translation is unavailable until it is configured.");
  }

  if (!env.hasJwtSecret) {
    console.warn("JWT_SECRET is missing. Auth tokens are disabled until JWT_SECRET is set.");
  }

  for (const warning of runtimePathStatus.warnings) {
    console.warn(`Runtime path warning: ${warning}`);
  }

};
