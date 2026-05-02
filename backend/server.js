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
const defaultClientOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "https://interpshield.vercel.app"
];
const configuredClientOrigins = (process.env.CLIENT_URL || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const corsOrigins = [...new Set([...defaultClientOrigins, ...env.clientOrigins, ...configuredClientOrigins])];
const corsOptions = {
  origin: corsOrigins,
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};
const io = new Server(server, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  transports: ["websocket", "polling"],
  allowUpgrades: true,
  maxHttpBufferSize: 2e6,
  pingInterval: 10000,
  pingTimeout: 20000,
  connectTimeout: 20000
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

app.get("/api/config", (_req, res) => {
  res.json(getPublicConfig());
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
