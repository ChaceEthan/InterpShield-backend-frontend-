// @ts-nocheck
import express from "express";
import { requireAuth } from "./auth.js";
import { listHistory, saveHistoryItem, updateUserSettings, upgradeUserPlan } from "../services/userService.js";

export const createUserRouter = (env) => {
  const router = express.Router();
  const protectedRoute = requireAuth(env);

  router.use(protectedRoute);

  router.get("/profile", (req, res) => {
    res.json({ user: req.user });
  });

  router.patch("/settings", async (req, res, next) => {
    try {
      res.json({ user: await updateUserSettings(req.user.id, req.body, env) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/upgrade", async (req, res, next) => {
    try {
      res.json({ user: await upgradeUserPlan(req.user.id, env) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/history", async (req, res, next) => {
    try {
      res.json({ history: await listHistory(req.user.id, env) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/history", async (req, res, next) => {
    try {
      res.status(201).json({ item: await saveHistoryItem(req.user.id, req.body, env) });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
