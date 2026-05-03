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

  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".vercel.app") ||
    env.clientOrigins.includes(normalizedOrigin)
  );
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
  pingInterval: 15000,
  pingTimeout: 20000
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
    gemini: Boolean(env.geminiApiKey)
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

const connectDatabaseSafely = async () => {
  try {
    await connectDatabase(env);
  } catch (error) {
    console.warn("MongoDB connection unavailable:", error?.message || error);
  }
};

const startServer = async () => {
  try {
    await connectDatabaseSafely();

    if (env.mongoUri) {
      const retryDatabaseConnection = setInterval(() => {
        if (getDatabaseStatus() !== "connected") {
          void connectDatabaseSafely();
        }
      }, 30000);
      retryDatabaseConnection.unref?.();
    }

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
