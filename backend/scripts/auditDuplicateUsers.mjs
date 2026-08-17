// Read-only production audit: reports User documents whose emails collide once normalized
// (trimmed + lowercased) even though they may differ as stored (legacy mixed-case data created
// before the schema enforced lowercase, or created before the case-insensitive collation index
// existed). This is intentionally report-only — it never modifies, merges, or deletes anything.
// A human must review the report and decide how to reconcile each group, preserving history,
// payments, and sessions per account before any manual merge.
import { pathToFileURL } from "node:url";
import { connectDatabase } from "../config/database.js";
import { env } from "../config/env.js";
import User from "../models/User.js";

export const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

/**
 * Pure grouping logic, kept separate from the database query so it can be exercised by a
 * regression test without a live MongoDB connection.
 * @param {any[]} docs
 */
export const groupUsersByNormalizedEmail = (docs) => {
  const groups = new Map();
  for (const user of docs) {
    const key = normalizeEmail(user.email);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(user);
  }

  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([normalizedEmail, group]) => ({
      normalizedEmail,
      count: group.length,
      accounts: group
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
        .map((doc) => ({
          id: String(doc._id),
          storedEmail: doc.email,
          name: doc.name,
          role: doc.role,
          status: doc.status,
          provider: doc.provider,
          hasGoogleId: Boolean(doc.googleId),
          plan: doc.plan,
          subscriptionType: doc.subscriptionType,
          subscriptionStatus: doc.subscriptionStatus,
          isUnlimited: Boolean(doc.isUnlimited),
          createdAt: doc.createdAt,
          lastActiveAt: doc.lastActiveAt,
          lastLoginAt: doc.lastLoginAt,
          totalUsageMinutes: doc.totalUsageMinutes || 0,
          sessionCount: doc.sessionCount || 0
        }))
    }));
};

export const findDuplicateUserEmails = async () => {
  const users = await User.find({}).select(
    "email name role status provider googleId plan subscriptionType subscriptionStatus isUnlimited createdAt lastActiveAt lastLoginAt totalUsageMinutes sessionCount"
  ).lean();

  return groupUsersByNormalizedEmail(users);
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await connectDatabase(env);
  const duplicates = await findDuplicateUserEmails();
  if (duplicates.length === 0) {
    console.info("No duplicate-email User accounts found.");
  } else {
    console.warn(`Found ${duplicates.length} email(s) with multiple User accounts:`);
    console.warn(JSON.stringify(duplicates, null, 2));
    console.warn(
      "This report is read-only. Review each group manually — preserve history, payments, and " +
      "sessions — before merging or deactivating any account. No records were changed."
    );
  }
  process.exit(0);
}
