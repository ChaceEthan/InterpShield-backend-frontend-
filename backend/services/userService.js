import crypto from "node:crypto";
import { withUserStore } from "./authService.js";

const safeHistoryItem = (item) => ({
  id: item.id,
  title: item.title,
  sourceLang: item.sourceLang,
  targetLang: item.targetLang,
  originalText: item.originalText,
  translatedText: item.translatedText,
  durationSeconds: item.durationSeconds,
  createdAt: item.createdAt
});

export const updateUserSettings = async (userId, settings, env) => {
  return withUserStore(env, async (store) => {
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new Error("User not found");

    user.settings = {
      ...(user.settings || {}),
      ...settings
    };

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      picture: user.picture || "",
      plan: user.plan || "free",
      provider: user.provider || "password",
      settings: user.settings,
      createdAt: user.createdAt
    };
  });
};

export const upgradeUserPlan = async (userId, env) => {
  return withUserStore(env, async (store) => {
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new Error("User not found");

    user.plan = "pro";
    user.upgradedAt = new Date().toISOString();

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      picture: user.picture || "",
      plan: user.plan,
      provider: user.provider || "password",
      settings: user.settings,
      createdAt: user.createdAt
    };
  });
};

export const listHistory = async (userId, env) => {
  return withUserStore(env, async (store) => {
    return store.history
      .filter((item) => item.userId === userId)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map(safeHistoryItem);
  });
};

export const saveHistoryItem = async (userId, payload, env) => {
  return withUserStore(env, async (store) => {
    const item = {
      id: crypto.randomUUID(),
      userId,
      title: payload.title?.trim() || "Live interpreter session",
      sourceLang: payload.sourceLang || "en",
      targetLang: payload.targetLang || "es",
      originalText: payload.originalText || "",
      translatedText: payload.translatedText || "",
      durationSeconds: Number(payload.durationSeconds || 0),
      createdAt: new Date().toISOString()
    };

    store.history.push(item);
    return safeHistoryItem(item);
  });
};
