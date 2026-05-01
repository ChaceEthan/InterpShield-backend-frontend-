// @ts-nocheck
import http from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { env, getPublicConfig, warnAboutMissingConfig } from "./config/env.js";
import { createAuthRouter } from "./routes/auth.js";
import { createUserRouter } from "./routes/user.js";
import { registerInterpreterSocket } from "./sockets/interpreterSocket.js";

warnAboutMissingConfig();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: env.clientOrigin,
    methods: ["GET", "POST", "PATCH"]
  },
  maxHttpBufferSize: 2e6,
  pingInterval: 15000,
  pingTimeout: 20000
});

app.use(cors({ origin: env.clientOrigin }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/config", (_req, res) => {
  res.json(getPublicConfig());
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "interp-shield-backend", ...getPublicConfig() });
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

server.listen(env.port, () => {
  console.log(`InterpShield backend running on http://localhost:${env.port}`);
});
