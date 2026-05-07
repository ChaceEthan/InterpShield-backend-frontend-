// @ts-nocheck
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(backendRoot, ".env"), quiet: true });

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

const localClientOrigin = "http://localhost:5173";
const localClientOriginAlt = "http://127.0.0.1:5173";

const normalizeOrigin = (origin = "") => {
  const trimmed = origin.trim();
  if (!trimmed) return "";

  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return trimmed.replace(/\/$/, "").toLowerCase();
  }
};

const readClientOrigins = (clientUrl) => {
  const configuredOrigins = (clientUrl || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  const origins = [localClientOrigin, localClientOriginAlt, ...configuredOrigins];
  return [...new Set(origins)];
};

export const env = {
  port: readNumber(process.env.PORT, 10000),
  clientOrigins: readClientOrigins(process.env.CLIENT_URL),
  mongoUri: readSecret(process.env.MONGO_URI),
  deepgramApiKey: readSecret(process.env.DEEPGRAM_API_KEY),
  geminiApiKey: readSecret(process.env.GEMINI_API_KEY),
  openaiApiKey: readSecret(process.env.OPENAI_API_KEY),
  hasJwtSecret: Boolean(readSecret(process.env.JWT_SECRET)),
  jwtSecret: readSecret(process.env.JWT_SECRET),
  maxSessionSeconds: 3600,
  audioChunkMs: 700
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
  mode: getMode(),
  maxSessionSeconds: env.maxSessionSeconds,
  audioChunkMs: env.audioChunkMs
});

export const warnAboutMissingConfig = () => {
  if (!env.mongoUri) {
    console.warn("MONGO_URI is missing. Auth and user data require MongoDB Atlas in production.");
  }

  if (!env.deepgramApiKey) {
    console.warn("DEEPGRAM_API_KEY is missing. Speech-to-text is unavailable until it is configured.");
  }

  if (!env.geminiApiKey) {
    console.warn("GEMINI_API_KEY is missing. Translation is unavailable until it is configured.");
  }

  if (!env.openaiApiKey) {
    console.warn("OPENAI_API_KEY is missing. OpenAI fallback translation is disabled.");
  }

  if (!env.hasJwtSecret) {
    console.warn("JWT_SECRET is missing. Auth tokens are disabled until JWT_SECRET is set.");
  }

};
