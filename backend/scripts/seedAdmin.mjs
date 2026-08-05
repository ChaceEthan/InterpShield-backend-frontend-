import { connectDatabase } from "../config/database.js";
import { env } from "../config/env.js";
import User from "../models/User.js";

if (!env.adminEmail || !/^\$2[aby]\$\d{2}\$/.test(env.adminPasswordHash || "")) throw new Error("ADMIN_EMAIL and a valid bcrypt ADMIN_PASSWORD_HASH are required.");
await connectDatabase(env);
const existing = await User.findOne({ email: env.adminEmail }).select("+password");
if (existing) { existing.role = "super_admin"; existing.status = "active"; existing.planOverride = "unlimited"; if (!existing.password) existing.password = env.adminPasswordHash; existing.mustChangePassword = true; await existing.save(); }
else await User.create({ name: "InterpShield Owner", email: env.adminEmail, password: env.adminPasswordHash, provider: "password", role: "super_admin", status: "active", planOverride: "unlimited", mustChangePassword: true });
console.info("Super admin account initialized securely.");
process.exit(0);
