import User from "../models/User.js";
import { calculateDaysRemaining, normalizeSubscription } from "./subscriptionService.js";
export const runSubscriptionExpirationCheck = async (now = new Date()) => {
  const users = await User.find({ role: "user", status: { $in: ["active", "expired"] } }); let expired = 0;
  for (const user of users) {
    const previous = user.status; normalizeSubscription(user, now); const days = calculateDaysRemaining(user.trialEndsAt, now);
    const notice = user.status === "expired" ? "expired" : days === 3 ? "three_days" : days === 1 ? "one_day" : null;
    if (notice && !user.subscriptionNotifications?.some((item) => item.type === notice)) user.subscriptionNotifications.push({ type: notice, sentAt: now });
    if (previous !== user.status || notice) await user.save(); if (previous !== "expired" && user.status === "expired") expired += 1;
  }
  return { checked: users.length, expired };
};
export const migrateLegacySubscriptions = async (now = new Date()) => { const users = await User.find({}); for (const user of users) { normalizeSubscription(user, now); await user.save(); } return { migrated: users.length }; };
