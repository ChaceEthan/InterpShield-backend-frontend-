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
  "your-secret",
  "your_secret",
  "your-client-id",
  "your_client_id",
  "your_deepgram_api_key",
  "your_deepgram_key",
  "your_gemini_api_key",
  "your_gemini_key",
  "your_openai_key",
  "your_openai_api_key",
  "your_mongo_uri",
  "YOUR_DEEPGRAM_API_KEY_HERE",
  "YOUR_GEMINI_API_KEY_HERE",
  "YOUR_OPENAI_API_KEY_HERE"
]);
const placeholderPattern = /\b(your[-_ ]?|replace[-_ ]?me|example|placeholder)\b/i;

const readSecret = (value) => {
  const trimmed = value?.trim() || "";
  const unquoted = trimmed.match(/^(['"])(.*)\1$/)?.[2] || trimmed;
  return placeholderValues.has(unquoted) || placeholderPattern.test(unquoted) ? "" : unquoted;
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

const readNodeEnv = (value) => {
  const normalized = String(value || "development").trim().toLowerCase();
  return ["development", "test", "production"].includes(normalized) ? normalized : "development";
};

const nodeEnv = readNodeEnv(process.env.NODE_ENV);

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

const readMaxSessionSeconds = () => {
  const configured = clampNumber(readNumber(process.env.MAX_SESSION_SECONDS, 86400), 600, 86400);
  return nodeEnv === "production" ? 86400 : configured;
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
  nodeEnv,
  port: readNumber(process.env.PORT, 10000),
  clientOrigins: readClientOrigins(process.env.CLIENT_URL, process.env.CORS_ORIGIN),
  allowVercelPreviewOrigins: process.env.ALLOW_VERCEL_PREVIEW_ORIGINS === "true",
  googleClientId: readSecret(process.env.GOOGLE_CLIENT_ID),
  googleClientSecret: readSecret(process.env.GOOGLE_CLIENT_SECRET),
  mongoUri: readSecret(process.env.MONGO_URI),
  deepgramApiKey: readSecret(process.env.DEEPGRAM_API_KEY),
  geminiApiKey: readSecret(process.env.GEMINI_API_KEY),
  geminiModel: String(process.env.GEMINI_MODEL || "gemini-flash-latest").trim() || "gemini-flash-latest",
  openaiApiKey: readSecret(process.env.OPENAI_API_KEY),
  hasJwtSecret: Boolean(readSecret(process.env.JWT_SECRET)),
  jwtSecret: readSecret(process.env.JWT_SECRET),
  adminWebhookUrl: readSecret(process.env.ADMIN_WEBHOOK_URL),
  paths: projectPaths,
  runtimePathStatus,
  maxSessionSeconds: readMaxSessionSeconds(),
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
  const isProduction = env.nodeEnv === "production";

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

  if (!process.env.NODE_ENV) warnings.push("NODE_ENV is not set; defaulting to development.");
  if (process.env.NODE_ENV && env.nodeEnv !== String(process.env.NODE_ENV).trim().toLowerCase()) {
    errors.push("NODE_ENV must be one of development, test, or production.");
  }

  if (!env.jwtSecret) errors.push("JWT_SECRET is required.");
  if (!env.deepgramApiKey) errors.push("DEEPGRAM_API_KEY is required.");
  if (!env.geminiApiKey) errors.push("GEMINI_API_KEY is required.");
  if (!env.openaiApiKey) {
    const message = "OPENAI_API_KEY is required for production provider failover.";
    if (isProduction) errors.push(message);
    else warnings.push(`${message} OpenAI fallback translation is disabled locally.`);
  }
  if (!env.mongoUri) errors.push("MONGO_URI is required for auth and saved history.");
  if (!env.googleClientId) errors.push("GOOGLE_CLIENT_ID is required so Google ID tokens are audience-checked.");
  if (!env.googleClientSecret) warnings.push("GOOGLE_CLIENT_SECRET is not used by the current backend Google ID-token flow.");
  if (env.maxSessionSeconds < 86400) warnings.push(`MAX_SESSION_SECONDS is ${env.maxSessionSeconds}; production meetings should use 86400 for 24-hour sessions.`);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nodeEnv: env.nodeEnv,
    port: env.port,
    maxSessionSeconds: env.maxSessionSeconds,
    audioChunkMs: env.audioChunkMs,
    clientOrigins: env.clientOrigins,
    allowVercelPreviewOrigins: env.allowVercelPreviewOrigins,
    allowLocalOrigins: env.clientOrigins.some((origin) => /localhost|127\.0\.0\.1/.test(origin)),
    paths: env.runtimePathStatus,
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
