// @ts-nocheck
import http from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { connectDatabase, getDatabaseStatus } from "./config/database.js";
import { env, getPublicConfig, warnAboutMissingConfig } from "./config/env.js";
import { createAuthRouter } from "./routes/auth.js";
import { createUserRouter } from "./routes/user.js";
import { registerInterpreterSocket } from "./sockets/interpreterSocket.js";

warnAboutMissingConfig();

const app = express();
const server = http.createServer(app);

const normalizeOrigin = (origin = "") => origin.trim().replace(/\/$/, "").toLowerCase();
const corsOrigins = new Set(env.clientOrigins.map(normalizeOrigin));
const corsMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"];
const corsAllowedHeaders = ["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With"];
const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  return corsOrigins.has(normalizeOrigin(origin));
};
const corsOrigin = (origin, callback) => {
  callback(null, isAllowedOrigin(origin));
};
const applyCorsHeaders = (req, res) => {
  const origin = req.get("origin");

  if (isAllowedOrigin(origin) && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.vary("Origin");
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", corsMethods.join(", "));
  res.setHeader("Access-Control-Allow-Headers", corsAllowedHeaders.join(", "));
};
const corsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: corsMethods,
  allowedHeaders: corsAllowedHeaders,
  optionsSuccessStatus: 204
};
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
  allowUpgrades: true,
  maxHttpBufferSize: 2e6,
  pingInterval: 10000,
  pingTimeout: 20000,
  connectTimeout: 20000
});

app.use((req, res, next) => {
  applyCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});
app.use(cors(corsOptions));
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.removeHeader("Cross-Origin-Embedder-Policy");
  next();
});
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "interp-shield-backend",
    message: "InterpShield backend is running"
  });
});

app.get("/api/config", (_req, res, next) => {
  try {
    res.status(200).json(getPublicConfig());
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "interp-shield-backend",
    database: getDatabaseStatus(),
    ...getPublicConfig()
  });
});

app.get("/api/debug/env", (_req, res) => {
  res.json({
    deepgram: Boolean(env.deepgramApiKey),
    gemini: Boolean(env.geminiApiKey),
    googleTranslate: Boolean(env.googleTranslateApiKey)
  });
});

app.use("/api/auth", createAuthRouter(env));
app.use("/api/user", createUserRouter(env));

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.use((error, _req, res, _next) => {
  const message = error?.message || "Unexpected server error.";
  const status = error?.statusCode || (message.includes("required") || message.includes("already") ? 400 : 500);
  res.status(status).json({ error: message });
});

registerInterpreterSocket(io, env, getPublicConfig);

const startServer = async () => {
  try {
    await connectDatabase(env);

    server.listen(env.port, () => {
      console.log(`Server running on port ${env.port}`);
      console.log(`Local backend URL: http://localhost:${env.port}`);
    });
  } catch (error) {
    console.error("Failed to start InterpShield backend:", error?.message || error);
    process.exit(1);
  }
};

void startServer();
