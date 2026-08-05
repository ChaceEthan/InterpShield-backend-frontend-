// @ts-nocheck
import express from "express";
import User from "../models/User.js";
import { requireAuth } from "./auth.js";
import { requireAdmin } from "../middleware/authorization.js";
import { createSession, hashPassword, httpError, verifyPassword } from "../services/authService.js";
import { getAdminOverview, getAdminUser, listAdminUsers, listAuditLogs, resetUserUsage, updateUserPlan, updateUserRole, updateUserStatus, writeAuditLog } from "../services/adminService.js";

const attempts = new Map(); const WINDOW_MS = 900000; const MAX_ATTEMPTS = 5;
const clientKey = (req) => String(req.ip || req.socket?.remoteAddress || "unknown");
const loginRateLimit = (req, res, next) => { const key = clientKey(req); const now = Date.now(); const entry = attempts.get(key) || { count: 0, resetAt: now + WINDOW_MS }; if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + WINDOW_MS; } if (entry.count >= MAX_ATTEMPTS) return res.status(429).json({ error: "Too many login attempts. Try again later." }); req.adminAttempt = entry; req.adminAttemptKey = key; next(); };

export const createAdminRouter = (env) => {
  const router = express.Router();
  router.post("/login", loginRateLimit, async (req, res, next) => { try {
    const email = String(req.body?.email || req.body?.username || "").trim().toLowerCase();
    const user = await User.findOne({ email }).select("+password");
    const valid = user && ["admin", "super_admin"].includes(user.role) && (user.status || "active") === "active" && await verifyPassword(String(req.body?.password || ""), user.password);
    if (!valid) { req.adminAttempt.count += 1; attempts.set(req.adminAttemptKey, req.adminAttempt); await writeAuditLog({ action: "admin_login_failed", targetUserId: user?._id, reason: "invalid_credentials", ip: clientKey(req) }).catch(() => undefined); throw httpError("Invalid credentials.", 401); }
    attempts.delete(req.adminAttemptKey); user.lastLoginAt = new Date(); user.lastActiveAt = user.lastLoginAt; await user.save();
    await writeAuditLog({ adminUserId: user._id, action: "admin_login", reason: "successful_login", ip: clientKey(req) }); res.json(createSession(user, env));
  } catch (error) { next(error); } });
  router.use(requireAuth(env), requireAdmin);
  router.get("/overview", async (_req, res, next) => { try { res.json(await getAdminOverview()); } catch (e) { next(e); } });
  router.get("/users", async (req, res, next) => { try { res.json({ users: await listAdminUsers(req.query) }); } catch (e) { next(e); } });
  router.get("/users/:id", async (req, res, next) => { try { res.json({ user: await getAdminUser(req.params.id) }); } catch (e) { next(e); } });
  router.patch("/users/:id/status", async (req, res, next) => { try { res.json({ user: await updateUserStatus({ actor: req.user, targetId: req.params.id, status: req.body?.status, reason: req.body?.reason, ip: clientKey(req) }) }); } catch (e) { next(e); } });
  router.patch("/users/:id/plan", async (req, res, next) => { try { res.json({ user: await updateUserPlan({ actor: req.user, targetId: req.params.id, planOverride: req.body?.planOverride, accessOverrideEndsAt: req.body?.accessOverrideEndsAt, reason: req.body?.reason, ip: clientKey(req) }) }); } catch (e) { next(e); } });
  router.patch("/users/:id/usage", async (req, res, next) => { try { res.json({ user: await resetUserUsage({ actor: req.user, targetId: req.params.id, reason: req.body?.reason, ip: clientKey(req) }) }); } catch (e) { next(e); } });
  router.patch("/users/:id/role", async (req, res, next) => { try { res.json({ user: await updateUserRole({ actor: req.user, targetId: req.params.id, role: req.body?.role, reason: req.body?.reason, ip: clientKey(req) }) }); } catch (e) { next(e); } });
  router.get("/audit-logs", async (req, res, next) => { try { res.json({ logs: await listAuditLogs(req.query.limit) }); } catch (e) { next(e); } });
  router.post("/change-password", async (req, res, next) => { try { const current = String(req.body?.currentPassword || ""); const nextPassword = String(req.body?.newPassword || ""); if (nextPassword.length < 10) throw httpError("New password must be at least 10 characters.", 400); const user = await User.findById(req.user.id).select("+password"); if (!user || !await verifyPassword(current, user.password)) throw httpError("Invalid credentials.", 401); user.password = await hashPassword(nextPassword); user.mustChangePassword = false; await user.save(); await writeAuditLog({ adminUserId: user._id, action: "admin_password_changed", reason: "self_service", ip: clientKey(req) }); res.json({ ok: true }); } catch (e) { next(e); } });
  router.get("/session", (req, res) => res.json({ user: req.user }));
  return router;
};
