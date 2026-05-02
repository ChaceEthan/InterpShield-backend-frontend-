// @ts-nocheck
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(backendRoot, "..");
const isProductionProcess = process.env.NODE_ENV === "production";

dotenv.config({ quiet: true });
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
dotenv.config({ path: path.join(backendRoot, ".env"), quiet: true, override: !isProductionProcess });

const placeholderValues = new Set([
  "",
  "null",
  "undefined",
  "your_deepgram_api_key",
  "your_gemini_api_key",
  "your_google_translate_api_key",
  "your_mongo_uri",
  "demo_deepgram_key_replace_me",
  "demo_gemini_key_replace_me",
  "demo_google_translate_key_replace_me",
  "YOUR_DEEPGRAM_API_KEY_HERE",
  "YOUR_GEMINI_API_KEY_HERE",
  "YOUR_GOOGLE_TRANSLATE_API_KEY_HERE"
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

const readProjectPath = (value, fallback) => {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
};

const localClientOrigin = "http://localhost:5173";
const productionClientOrigin = "https://interpshield.vercel.app";
const legacyProductionClientOrigin = "https://interp-shield-backend-frontend-fron.vercel.app";

const normalizeOrigin = (origin) => origin.trim().replace(/\/$/, "").toLowerCase();

const readClientOrigins = (clientUrl) => {
  const configuredOrigins = (clientUrl || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  const origins = [localClientOrigin, productionClientOrigin, legacyProductionClientOrigin, ...configuredOrigins];
  return [...new Set(origins)];
};

export const env = {
  port: readNumber(process.env.PORT, 10000),
  nodeEnv: process.env.NODE_ENV || "development",
  clientOrigins: readClientOrigins(process.env.CLIENT_URL),
  dataDir: readProjectPath(process.env.DATA_DIR, path.join(projectRoot, ".data")),
  mongoUri: readSecret(process.env.MONGO_URI),
  deepgramApiKey: readSecret(process.env.DEEPGRAM_API_KEY),
  geminiApiKey: readSecret(process.env.GEMINI_API_KEY),
  googleTranslateApiKey: readSecret(process.env.GOOGLE_TRANSLATE_API_KEY || process.env.GOOGLE_API_KEY),
  hasJwtSecret: Boolean(readSecret(process.env.JWT_SECRET)),
  jwtSecret: readSecret(process.env.JWT_SECRET) || (isProductionProcess ? "" : "interp-shield-local-dev-secret-change-me"),
  jwtIssuer: process.env.JWT_ISSUER || "interp-shield",
  maxSessionSeconds: readNumber(process.env.MAX_SESSION_SECONDS, 120),
  audioChunkMs: readNumber(process.env.AUDIO_CHUNK_MS, 700)
};

export const getMode = () => (env.deepgramApiKey && (env.geminiApiKey || env.googleTranslateApiKey) ? "production" : "demo");

export const getPublicConfig = () => ({
  status: "ok",
  services: {
    deepgram: true,
    gemini: true,
    googleTranslate: true
  },
  backend: true,
  hasDeepgramKey: Boolean(env.deepgramApiKey),
  hasGeminiKey: Boolean(env.geminiApiKey),
  hasGoogleTranslateKey: Boolean(env.googleTranslateApiKey),
  mode: getMode(),
  maxSessionSeconds: env.maxSessionSeconds,
  audioChunkMs: env.audioChunkMs
});

export const warnAboutMissingConfig = () => {
  console.log("Deepgram key exists:", Boolean(env.deepgramApiKey));

  if (!env.mongoUri) {
    console.warn("MONGO_URI is missing. Auth and user data require MongoDB Atlas in production.");
  }

  if (!env.deepgramApiKey) {
    console.warn("Deepgram key is missing. STT will use demo fallback.");
  }

  if (!env.geminiApiKey) {
    console.warn("Gemini key is missing. Primary translation requires GEMINI_API_KEY.");
  }

  if (!env.googleTranslateApiKey) {
    console.warn("Google Translate key is missing. Fallback translation requires GOOGLE_TRANSLATE_API_KEY.");
  }

  if (!env.hasJwtSecret) {
    if (env.nodeEnv === "production") {
      console.warn("JWT_SECRET is missing. Auth tokens are disabled until JWT_SECRET is set.");
    } else {
      console.warn("JWT_SECRET is missing. Using a local development secret.");
    }
  }

};
