import assert from "node:assert/strict";
import fs from "node:fs";
import bcrypt from "bcrypt";
import User from "../models/User.js";
import { canManageUser, isAccountActive, requireAdmin, requireSuperAdmin } from "../middleware/authorization.js";
import { hashPassword, safeUser, verifyPassword } from "../services/authService.js";
import { canUseDubbing, checkFeatureAccess, checkMinuteAllowance, hasUnlimitedAccess } from "../utils/featureGating.js";
import { canMakeTranslationRequest } from "../utils/monetizationUtils.js";

const runMiddleware = (middleware, user) => { let next = false; let status = 200; let body; middleware({ user }, { status(code) { status = code; return this; }, json(value) { body = value; } }, () => { next = true; }); return { next, status, body }; };
assert.equal(runMiddleware(requireAdmin, null).status, 403, "unauthenticated requests cannot access admin APIs");
assert.equal(runMiddleware(requireAdmin, { role: "user" }).status, 403, "normal users cannot access admin APIs");
assert.equal(runMiddleware(requireAdmin, { role: "admin" }).next, true, "admins can access permitted APIs");
assert.equal(runMiddleware(requireSuperAdmin, { role: "admin" }).status, 403, "normal admins cannot use super-admin endpoints");
assert.equal(runMiddleware(requireSuperAdmin, { role: "super_admin" }).next, true, "super admins can manage roles");
assert.equal(canManageUser({ role: "admin" }, { role: "super_admin" }), false, "admins cannot modify super admins");
assert.equal(canManageUser({ role: "super_admin" }, { role: "admin" }), true);

for (const role of ["admin", "super_admin"]) {
  const user = { role, plan: "free", dailyUsageMinutes: 999999, credits: 0 };
  assert.equal(hasUnlimitedAccess(user), true);
  assert.equal(checkFeatureAccess(user, "captions").allowed, true, "admins bypass caption restrictions");
  assert.equal(checkMinuteAllowance(user, 999999).allowed, true, "admins bypass minute restrictions");
  assert.equal(canMakeTranslationRequest(user), true, "admins bypass translation restrictions");
  assert.equal(canUseDubbing(user), true, "admins bypass dubbing restrictions");
}
assert.equal(canUseDubbing({ role: "user", plan: "free" }), false, "normal free users retain dubbing restrictions");
assert.equal(checkMinuteAllowance({ role: "user", plan: "free", dailyUsageMinutes: 15 }, 1).allowed, false, "normal users retain limits");
assert.equal(isAccountActive({ status: "suspended" }), false, "suspended users cannot start interpreter sessions");
assert.equal(isAccountActive({ status: "active" }), true, "reactivated users can use the app");
assert.equal(hasUnlimitedAccess({ role: "user", planOverride: "unlimited", accessOverrideEndsAt: new Date(Date.now() - 1000) }), false, "expired temporary access is not unlimited");

const plaintext = `temporary-test-${Date.now()}`;
const hash = await hashPassword(plaintext);
assert.notEqual(hash, plaintext); assert.equal(await bcrypt.compare(plaintext, hash), true); assert.equal(await verifyPassword(plaintext, hash), true);
const safe = safeUser({ _id: "1", name: "Admin", email: "admin@example.test", password: hash, role: "super_admin", status: "active", plan: "free" });
assert.equal(Object.hasOwn(safe, "password"), false, "passwords are never returned by APIs");
assert.equal(User.schema.path("password").options.select, false, "password remains excluded by default");

const navbar = fs.readFileSync(new URL("../../frontend/src/components/Navbar.tsx", import.meta.url), "utf8");
assert.match(navbar, /user\?\.role === "admin" \|\| user\?\.role === "super_admin"/, "admin route is conditionally exposed only to admins");
const app = fs.readFileSync(new URL("../../frontend/src/App.tsx", import.meta.url), "utf8");
assert.match(app, /view === "admin" && token && \(user\?\.role === "admin" \|\| user\?\.role === "super_admin"\)/, "direct admin rendering requires an authenticated admin role");
const adminService = fs.readFileSync(new URL("../services/adminService.js", import.meta.url), "utf8");
assert.match(adminService, /action: status === "active" \? "user_reactivated" : `user_\$\{status\}`/, "suspension and reactivation create audit logs");
assert.match(adminService, /action: "plan_changed"/, "plan changes create audit logs");
console.log("Admin security regression tests passed.");
