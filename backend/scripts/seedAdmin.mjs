import { connectDatabase } from "../config/database.js";
import { env } from "../config/env.js";
import User from "../models/User.js";
import { pathToFileURL } from "node:url";

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * @param {{
 *   config: {adminEmail?: string, adminPasswordHash?: string, adminResetPasswordOnSeed?: boolean},
 *   UserModel?: import("mongoose").Model<any>
 * }} options
 */
export const seedAdmin = async ({ config, UserModel = User }) => {
  const normalizedEmail = String(config.adminEmail || "").trim().toLowerCase();
  const passwordHash = String(config.adminPasswordHash || "");
  if (!normalizedEmail || !BCRYPT_HASH_PATTERN.test(passwordHash)) {
    throw new Error("ADMIN_EMAIL and a valid bcrypt ADMIN_PASSWORD_HASH are required.");
  }

  const existing = await UserModel.findOne({ email: normalizedEmail }).select("+password");
  if (existing) {
    existing.role = "super_admin";
    existing.status = "active";
    existing.planOverride = "unlimited";
    if (!existing.password || config.adminResetPasswordOnSeed === true) existing.password = passwordHash;
    existing.mustChangePassword = true;
    await existing.save();
    return { created: false, user: existing };
  }

  const user = await UserModel.create({
    name: "InterpShield Owner",
    email: normalizedEmail,
    password: passwordHash,
    provider: "password",
    role: "super_admin",
    status: "active",
    planOverride: "unlimited",
    mustChangePassword: true
  });
  return { created: true, user };
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await connectDatabase(env);
  await seedAdmin({ config: env });
  console.info("Super admin account initialized securely.");
  process.exit(0);
}
