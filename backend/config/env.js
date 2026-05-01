// @ts-nocheck
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(backendRoot, "..");

dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
dotenv.config({ path: path.join(backendRoot, ".env"), quiet: true });

const placeholderValues = new Set([
  "",
  "null",
  "undefined",
  "your_deepgram_api_key",
  "your_gemini_api_key",
  "demo_deepgram_key_replace_me",
  "demo_gemini_key_replace_me",
  "YOUR_DEEPGRAM_API_KEY_HERE",
  "YOUR_GEMINI_API_KEY_HERE"
]);

const readSecret = (value) => {
  const trimmed = value?.trim() || "";
  return placeholderValues.has(trimmed) ? "" : trimmed;
};

const readNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readProjectPath = (value, fallback) => {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
};

export const env = {
  port: readNumber(process.env.PORT, 5000),
  clientOrigin: process.env.CLIENT_ORIGIN || "*",
  dataDir: readProjectPath(process.env.DATA_DIR, path.join(projectRoot, ".data")),
  deepgramApiKey: readSecret(process.env.DEEPGRAM_API_KEY),
  geminiApiKey: readSecret(process.env.GEMINI_API_KEY),
  googleClientId: readSecret(process.env.GOOGLE_CLIENT_ID),
  jwtSecret: readSecret(process.env.JWT_SECRET) || "interp-shield-local-dev-secret-change-me",
  jwtIssuer: process.env.JWT_ISSUER || "interp-shield",
  maxSessionSeconds: readNumber(process.env.MAX_SESSION_SECONDS, 120),
  audioChunkMs: readNumber(process.env.AUDIO_CHUNK_MS, 700)
};

export const getMode = () => (env.deepgramApiKey && env.geminiApiKey ? "production" : "demo");

export const getPublicConfig = () => ({
  backend: true,
  hasDeepgramKey: Boolean(env.deepgramApiKey),
  hasGeminiKey: Boolean(env.geminiApiKey),
  hasGoogleClientId: Boolean(env.googleClientId),
  mode: getMode(),
  maxSessionSeconds: env.maxSessionSeconds,
  audioChunkMs: env.audioChunkMs
});

export const warnAboutMissingConfig = () => {
  if (!env.deepgramApiKey) {
    console.warn("Deepgram key is missing. STT will use demo fallback.");
  }

  if (!env.geminiApiKey) {
    console.warn("Gemini key is missing. Translation will use demo fallback.");
  }

  if (!process.env.JWT_SECRET || env.jwtSecret === "interp-shield-local-dev-secret-change-me") {
    console.warn("JWT_SECRET is missing. Using a local development secret.");
  }

  if (!env.googleClientId) {
    console.warn("GOOGLE_CLIENT_ID is missing. Google Sign-In will run in local demo mode.");
  }
};
