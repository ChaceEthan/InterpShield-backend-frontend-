// @ts-nocheck
import express from "express";
import { getUserByToken, loginUser, loginWithGoogle, registerUser } from "../services/authService.js";

const readBearerToken = (req) => {
  const header = req.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
};

const ensureJsonBody = (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ error: "Request body must be JSON." });
    return false;
  }

  return true;
};

export const requireAuth = (env) => async (req, res, next) => {
  try {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    req.user = await getUserByToken(token, env);
    next();
  } catch (error) {
    if (error?.statusCode === 503) {
      res.status(503).json({ error: error.message });
      return;
    }

    res.status(401).json({ error: "Invalid or expired session." });
  }
};

export const createAuthRouter = (env) => {
  const router = express.Router();

  router.post("/signup", async (req, res, next) => {
    try {
      if (!ensureJsonBody(req, res)) return;

      res.status(201).json(await registerUser(req.body, env));
    } catch (error) {
      next(error);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      if (!ensureJsonBody(req, res)) return;

      res.json(await loginUser(req.body, env));
    } catch (error) {
      next(error);
    }
  });

  router.post("/google", async (req, res, next) => {
    try {
      if (!ensureJsonBody(req, res)) return;

      res.json(await loginWithGoogle(req.body, env));
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", requireAuth(env), (req, res) => {
    res.json({ user: req.user });
  });

  router.post("/logout", (_req, res) => {
    res.json({ ok: true });
  });

  return router;
};
