import { requireDatabase } from "../config/database.js";
import History from "../models/History.js";
import User from "../models/User.js";
import { httpError, safeUser } from "./authService.js";

const safeHistoryItem = (item) => ({
  id: item._id?.toString?.() || item.id,
  title: item.title,
  sourceLang: item.sourceLang,
  targetLang: item.targetLang,
  originalText: item.originalText,
  translatedText: item.translatedText,
  durationSeconds: item.durationSeconds,
  createdAt: item.createdAt?.toISOString?.() || item.createdAt
});

const findUserOrThrow = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw httpError("User not found", 404);
  return user;
};

export const updateUserSettings = async (userId, settings, env) => {
  requireDatabase(env);

  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw httpError("Settings payload must be an object.", 400);
  }

  const user = await findUserOrThrow(userId);
  user.settings = {
    ...(user.settings || {}),
    ...settings
  };
  await user.save();

  return safeUser(user);
};

export const upgradeUserPlan = async (userId, env) => {
  requireDatabase(env);

  const user = await findUserOrThrow(userId);
  user.plan = "pro";
  user.upgradedAt = new Date();
  await user.save();

  return safeUser(user);
};

export const listHistory = async (userId, env) => {
  requireDatabase(env);

  const history = await History.find({ userId }).sort({ createdAt: -1 }).lean();
  return history.map(safeHistoryItem);
};

export const saveHistoryItem = async (userId, payload = {}, env) => {
  requireDatabase(env);

  const item = await History.create({
    userId,
    title: payload.title?.trim() || "Live interpreter session",
    sourceLang: payload.sourceLang || "en",
    targetLang: payload.targetLang || "es",
    originalText: payload.originalText || "",
    translatedText: payload.translatedText || "",
    durationSeconds: Number(payload.durationSeconds || 0)
  });

  return safeHistoryItem(item);
};
