// @ts-nocheck
import http from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { connectDatabase, getDatabaseStatus } from "./config/database.js";
import { env, getConfigDiagnostics, getPublicConfig, validateStartupConfig, warnAboutMissingConfig } from "./config/env.js";
import { createAuthRouter } from "./routes/auth.js";
import { createAdminRouter } from "./routes/admin.js";
import { createUserRouter } from "./routes/user.js";
import { getGeminiHealth } from "./services/gemini.js";
import { getInterpreterSessionHistory } from "./services/interpreter.js";
import { getOpenAIHealth } from "./services/openai.js";
import { runStartupAdminBootstrap } from "./services/adminBootstrap.js";
import { runSubscriptionExpirationCheck } from "./services/subscriptionJobs.js";
import { getInterpreterSocketHealth, registerInterpreterSocket } from "./sockets/interpreterSocket.js";

validateStartupConfig();
warnAboutMissingConfig();

const app = express();
const server = http.createServer(app);

const isAllowedCorsOrigin = (origin) => {
  if (!origin) return true;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  const normalizedOrigin = parsed.origin.toLowerCase();

  const allowedOrigins = new Set(env.clientOrigins.map((allowedOrigin) => allowedOrigin.toLowerCase()));

  return allowedOrigins.has(normalizedOrigin) || (env.allowVercelPreviewOrigins && hostname.endsWith(".vercel.app"));
};

const corsOrigin = (origin, callback) => {
  callback(null, isAllowedCorsOrigin(origin));
};

const corsOptions = {
  origin: corsOrigin,
  credentials: true
};
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 2e6,
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  connectTimeout: 30000,
  path: "/socket.io",
  allowUpgrades: true,
  allowEIO3: false
});

app.use(cors(corsOptions));
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "interp-shield-backend",
    message: "InterpShield backend is running"
  });
});

const baseHealthPayload = () => ({
  status: "ok",
  service: "interp-shield-backend",
  database: getDatabaseStatus(),
  config: getConfigDiagnostics(),
  ...getPublicConfig()
});

app.get("/api/config", (_req, res) => {
  res.json(getPublicConfig());
});

app.get("/api/health", (_req, res) => {
  res.json(baseHealthPayload());
});

app.get("/health", (_req, res) => {
  res.json(baseHealthPayload());
});

const fullHealthPayload = () => {
  const realtime = getInterpreterSocketHealth();
  const providers = {
    socketSessions: realtime.providers,
    gemini: getGeminiHealth(),
    openai: getOpenAIHealth()
  };

  return {
    ...baseHealthPayload(),
    socket: {
      connectedClients: io.engine.clientsCount,
      ...realtime.socket,
      rooms: realtime.rooms
    },
    translation: realtime.translation,
    audio: realtime.audio,
    providers
  };
};

app.get("/health/full", (_req, res) => {
  res.json(fullHealthPayload());
});

app.get("/health/socket", (_req, res) => {
  const health = getInterpreterSocketHealth();
  res.json({
    status: "ok",
    service: "interp-shield-backend",
    socket: {
      connectedClients: io.engine.clientsCount,
      ...health.socket,
      rooms: health.rooms
    }
  });
});

app.get("/health/audio", (_req, res) => {
  const health = getInterpreterSocketHealth();
  res.json({
    status: "ok",
    service: "interp-shield-backend",
    audio: health.audio
  });
});

app.get("/health/translation", (_req, res) => {
  const health = getInterpreterSocketHealth();
  res.json({
    status: "ok",
    service: "interp-shield-backend",
    translation: health.translation,
    providers: health.providers
  });
});

app.get("/health/providers", (_req, res) => {
  const health = getInterpreterSocketHealth();
  res.json({
    status: "ok",
    service: "interp-shield-backend",
    providers: {
      socketSessions: health.providers,
      gemini: getGeminiHealth(),
      openai: getOpenAIHealth()
    }
  });
});

app.get("/api/history/:sessionId", (req, res) => {
  res.json({
    history: getInterpreterSessionHistory(req.params.sessionId)
  });
});

app.use("/api/auth", createAuthRouter(env));
app.use("/api/admin", createAdminRouter(env));
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

const connectDatabaseSafely = async () => {
  try {
    await connectDatabase(env);
  } catch (error) {
    if (env.nodeEnv === "production") {
      throw error;
    }
    console.warn("MongoDB connection unavailable:", error?.message || error);
  }
};

const startServer = async () => {
  try {
    await connectDatabaseSafely();
    await runStartupAdminBootstrap({ config: env });
    await runSubscriptionExpirationCheck().catch((error) => console.warn("Subscription check unavailable:", error?.message || error));
    const subscriptionTimer = setInterval(() => void runSubscriptionExpirationCheck().catch((error) => console.warn("Subscription check failed:", error?.message || error)), 24 * 60 * 60 * 1000);
    subscriptionTimer.unref?.();

    if (env.mongoUri) {
      const retryDatabaseConnection = setInterval(() => {
        if (getDatabaseStatus() !== "connected") {
          void connectDatabaseSafely();
        }
      }, 30000);
      retryDatabaseConnection.unref?.();
    }

    server.listen(env.port);
  } catch (error) {
    console.error("Failed to start InterpShield backend:", error?.message || error);
    process.exit(1);
  }
};

void startServer();
