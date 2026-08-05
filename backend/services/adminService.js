import crypto from "node:crypto";
import mongoose from "mongoose";
import AuditLog from "../models/AuditLog.js";
import History from "../models/History.js";
import User from "../models/User.js";
import { httpError, safeUser } from "./authService.js";
import { canManageUser } from "../middleware/authorization.js";

export const ADMIN_ROLES = ["admin", "super_admin"];
export const USER_STATUSES = ["active", "suspended", "deactivated"];
export const ACCESS_PLANS = ["free", "starter", "pro", "unlimited"];
const safeText = (value, max = 500) => String(value || "").trim().slice(0, max);
const validId = (id) => mongoose.isValidObjectId(id);

export const writeAuditLog = async ({ adminUserId, action, targetUserId, reason, metadata = {}, ip = "" }) =>
  AuditLog.create({
    adminUserId: validId(adminUserId) ? adminUserId : undefined,
    action: safeText(action, 100),
    targetUserId: validId(targetUserId) ? targetUserId : undefined,
    reason: safeText(reason),
    metadata,
    ipHash: ip ? crypto.createHash("sha256").update(ip).digest("hex") : ""
  });

export const adminUserView = (user) => ({
  ...safeUser(user),
  status: user.status || "active",
  role: user.role || "user",
  planOverride: user.planOverride,
  accessOverrideEndsAt: user.accessOverrideEndsAt,
  suspendedAt: user.suspendedAt,
  suspensionReason: user.suspensionReason || "",
  deactivatedAt: user.deactivatedAt,
  lastActiveAt: user.lastActiveAt,
  lastLoginAt: user.lastLoginAt,
  usage: {
    dailyMinutes: user.dailyUsageMinutes || 0,
    totalMinutes: user.totalUsageMinutes || 0,
    captionMinutes: user.totalCaptionMinutes || 0,
    translationMinutes: user.totalTranslationMinutes || 0,
    translationRequests: user.translationRequestsThisMonth || 0,
    dubbingJobs: user.totalDubbingJobs || 0,
    sessions: user.sessionCount || 0
  }
});

export const getAdminOverview = async () => {
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const startMonth = new Date(startToday.getFullYear(), startToday.getMonth(), 1);
  const [groups, totals, sessions, newToday, newMonth, recent] = await Promise.all([
    User.aggregate([{ $group: { _id: { status: { $ifNull: ["$status", "active"] }, plan: "$plan" }, count: { $sum: 1 } } }]),
    User.aggregate([{ $group: { _id: null, captionMinutes: { $sum: { $ifNull: ["$totalUsageMinutes", 0] } }, translationMinutes: { $sum: { $ifNull: ["$totalTranslationMinutes", 0] } }, dubbingJobs: { $sum: { $ifNull: ["$totalDubbingJobs", 0] } } } }]),
    History.countDocuments({}), User.countDocuments({ createdAt: { $gte: startToday } }), User.countDocuments({ createdAt: { $gte: startMonth } }),
    User.find({ lastActiveAt: { $ne: null } }).sort({ lastActiveAt: -1 }).limit(10).lean()
  ]);
  const allUsers = groups.reduce((sum, item) => sum + item.count, 0);
  const count = (predicate) => groups.filter(predicate).reduce((sum, item) => sum + item.count, 0);
  return {
    totalUsers: allUsers,
    activeUsers: count((x) => x._id.status === "active"),
    suspendedUsers: count((x) => x._id.status === "suspended"),
    plans: {
      free: count((x) => x._id.plan === "free"),
      starter: count((x) => x._id.plan === "pro_lite"),
      pro: count((x) => ["creator", "business", "team"].includes(x._id.plan))
    },
    totalSessions: sessions,
    totalCaptionMinutes: totals[0]?.captionMinutes || 0,
    totalTranslationMinutes: totals[0]?.translationMinutes || 0,
    totalDubbingJobs: totals[0]?.dubbingJobs || 0,
    newUsersToday: newToday,
    newUsersThisMonth: newMonth,
    recentActivity: recent.map((user) => ({ id: String(user._id), name: user.name, lastActiveAt: user.lastActiveAt, lastLoginAt: user.lastLoginAt }))
  };
};

export const listAdminUsers = async (query = {}) => {
  const filter = {};
  if (query.search) filter.$or = ["name", "email"].map((field) => ({ [field]: { $regex: safeText(query.search, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }));
  if (["user", ...ADMIN_ROLES].includes(query.role)) filter.role = query.role;
  if (USER_STATUSES.includes(query.status)) filter.status = query.status;
  if (["free", "pro_lite", "creator", "business", "team"].includes(query.plan)) filter.plan = query.plan;
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const users = await User.find(filter).sort({ createdAt: -1 }).limit(limit);
  return users.map(adminUserView);
};

export const getAdminUser = async (id) => {
  if (!validId(id)) throw httpError("User not found.", 404);
  const user = await User.findById(id);
  if (!user) throw httpError("User not found.", 404);
  return adminUserView(user);
};

const requireReason = (reason) => {
  const clean = safeText(reason);
  if (clean.length < 3) throw httpError("A reason is required.", 400);
  return clean;
};

export const updateUserStatus = async ({ actor, targetId, status, reason, ip }) => {
  if (!USER_STATUSES.includes(status)) throw httpError("Invalid account status.", 400);
  const target = await User.findById(targetId);
  if (!target) throw httpError("User not found.", 404);
  if (!canManageUser(actor, target)) throw httpError("Access denied.", 403);
  if (String(target._id) === actor.id && status !== "active") throw httpError("You cannot disable your own account.", 400);
  const cleanReason = requireReason(reason);
  target.status = status;
  target.suspendedAt = status === "suspended" ? new Date() : undefined;
  target.suspendedBy = status === "suspended" ? actor.id : undefined;
  target.suspensionReason = status === "suspended" ? cleanReason : "";
  target.deactivatedAt = status === "deactivated" ? new Date() : undefined;
  await target.save();
  await writeAuditLog({ adminUserId: actor.id, targetUserId: targetId, action: status === "active" ? "user_reactivated" : `user_${status}`, reason: cleanReason, ip });
  return adminUserView(target);
};

export const updateUserPlan = async ({ actor, targetId, planOverride, accessOverrideEndsAt, reason, ip }) => {
  if (!ACCESS_PLANS.includes(planOverride)) throw httpError("Invalid access plan.", 400);
  const target = await User.findById(targetId);
  if (!target) throw httpError("User not found.", 404);
  if (!canManageUser(actor, target)) throw httpError("Access denied.", 403);
  const cleanReason = requireReason(reason);
  target.planOverride = planOverride;
  const effectivePlans = { free: "free", starter: "pro_lite", pro: "creator" };
  if (effectivePlans[planOverride]) target.plan = effectivePlans[planOverride];
  target.accessOverrideEndsAt = accessOverrideEndsAt ? new Date(accessOverrideEndsAt) : undefined;
  await target.save();
  await writeAuditLog({ adminUserId: actor.id, targetUserId: targetId, action: "plan_changed", reason: cleanReason, metadata: { planOverride }, ip });
  return adminUserView(target);
};

export const resetUserUsage = async ({ actor, targetId, reason, ip }) => {
  const target = await User.findById(targetId);
  if (!target) throw httpError("User not found.", 404);
  if (!canManageUser(actor, target)) throw httpError("Access denied.", 403);
  const cleanReason = requireReason(reason);
  target.dailyUsageMinutes = 0; target.translationRequestsThisMonth = 0; target.dailyUsageResetAt = new Date();
  await target.save();
  await writeAuditLog({ adminUserId: actor.id, targetUserId: targetId, action: "usage_reset", reason: cleanReason, ip });
  return adminUserView(target);
};

export const updateUserRole = async ({ actor, targetId, role, reason, ip }) => {
  if (!ADMIN_ROLES.includes(actor.role)) throw httpError("Access denied.", 403);
  if (actor.role !== "super_admin" || !["user", "admin"].includes(role)) throw httpError("Super admin access required.", 403);
  const target = await User.findById(targetId);
  if (!target) throw httpError("User not found.", 404);
  if (target.role === "super_admin") throw httpError("A super admin role cannot be modified here.", 403);
  const cleanReason = requireReason(reason); target.role = role; await target.save();
  await writeAuditLog({ adminUserId: actor.id, targetUserId: targetId, action: "role_changed", reason: cleanReason, metadata: { role }, ip });
  return adminUserView(target);
};

export const listAuditLogs = async (limit = 100) => AuditLog.find({}).select("-ipHash").sort({ createdAt: -1 }).limit(Math.min(200, Number(limit) || 100)).lean();
