import assert from "node:assert/strict";
import fs from "node:fs";
import bcrypt from "bcrypt";
import User from "../models/User.js";
import { canChangeUserRole, canManageUser, isAccountActive, requireAdmin, requireSuperAdmin } from "../middleware/authorization.js";
import { hashPassword, safeUser, verifyPassword } from "../services/authService.js";
import { canUseDubbing, checkFeatureAccess, checkMinuteAllowance, hasUnlimitedAccess } from "../utils/featureGating.js";
import { canMakeTranslationRequest } from "../utils/monetizationUtils.js";
import { seedAdmin } from "../scripts/seedAdmin.mjs";
import { runStartupAdminBootstrap } from "../services/adminBootstrap.js";
import { groupUsersByNormalizedEmail, normalizeEmail } from "../scripts/auditDuplicateUsers.mjs";
import { subscriptionSnapshot } from "../services/subscriptionService.js";

const runMiddleware = (middleware, user) => { let next = false; let status = 200; let body; middleware({ user }, { status(code) { status = code; return this; }, json(value) { body = value; } }, () => { next = true; }); return { next, status, body }; };
assert.equal(runMiddleware(requireAdmin, null).status, 403, "unauthenticated requests cannot access admin APIs");
assert.equal(runMiddleware(requireAdmin, { role: "user" }).status, 403, "normal users cannot access admin APIs");
assert.equal(runMiddleware(requireAdmin, { role: "admin" }).next, true, "admins can access permitted APIs");
assert.equal(runMiddleware(requireSuperAdmin, { role: "admin" }).status, 403, "normal admins cannot use super-admin endpoints");
assert.equal(runMiddleware(requireSuperAdmin, { role: "super_admin" }).next, true, "super admins can manage roles");
assert.equal(canManageUser({ role: "admin" }, { role: "super_admin" }), false, "admins cannot modify super admins");
assert.equal(canManageUser({ role: "super_admin" }, { role: "admin" }), true);
assert.equal(canChangeUserRole({ role: "super_admin" }, { role: "user" }, "admin"), true, "super admins can promote users to admin");
assert.equal(canChangeUserRole({ role: "super_admin" }, { role: "admin" }, "user"), true, "super admins can remove an admin role");
assert.equal(canChangeUserRole({ role: "admin" }, { role: "user" }, "admin"), false, "normal admins cannot change roles");
assert.equal(canChangeUserRole({ role: "super_admin" }, { role: "super_admin" }, "user"), false, "the super-admin account cannot be demoted");
assert.equal(canChangeUserRole({ role: "super_admin" }, { role: "user" }, "super_admin"), false, "dashboard role changes cannot create extra super admins");

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
assert.equal(safe.role, "super_admin", "login-safe users retain the database role");
assert.equal(safe.status, "active", "login-safe users retain the database status");
assert.equal(User.schema.path("password").options.select, false, "password remains excluded by default");

const app = fs.readFileSync(new URL("../../frontend/src/App.tsx", import.meta.url), "utf8");
assert.match(app, /view === "admin" && token && isAdminRole\(user\?\.role\)/, "direct admin rendering requires an authenticated admin role");
assert.match(app, /isAdminRole\(user\?\.role\)[\s\S]*Admin Dashboard/, "admin control is conditionally exposed only to admins");
const authRoutes = fs.readFileSync(new URL("../routes/auth.js", import.meta.url), "utf8");
assert.match(authRoutes, /router\.get\("\/me", requireAuth\(env\), \(req, res\) => \{\s*res\.json\(\{ user: req\.user/, "profile reload returns the authenticated database user");
const adminService = fs.readFileSync(new URL("../services/adminService.js", import.meta.url), "utf8");
assert.match(adminService, /action: status === "active" \? "user_reactivated" : `user_\$\{status\}`/, "suspension and reactivation create audit logs");
assert.match(adminService, /action: "plan_changed"/, "plan changes create audit logs");

const seedPassword = `seed-test-${Date.now()}`;
const replacementPassword = `${seedPassword}-replacement`;
const seedHash = await hashPassword(seedPassword);
const replacementHash = await hashPassword(replacementPassword);
const makeUserModel = (initialUser = null) => {
  const state = { user: initialUser, createCalls: 0 };
  return {
    state,
    findOne(filter) {
      return {
        async select() {
          return state.user?.email === filter.email ? state.user : null;
        }
      };
    },
    async create(values) {
      state.createCalls += 1;
      state.user = { ...values, history: [], async save() {} };
      return state.user;
    }
  };
};
const seedConfig = { adminEmail: "OWNER@EXAMPLE.TEST", adminPasswordHash: seedHash, adminResetPasswordOnSeed: false };
const newModel = makeUserModel();
const createdSeed = await seedAdmin({ config: seedConfig, UserModel: newModel });
assert.equal(createdSeed.created, true, "new admin is created");
assert.equal(newModel.state.user.email, "owner@example.test", "seed email is normalized");
assert.equal(await bcrypt.compare(seedPassword, newModel.state.user.password), true, "new admin stores the supplied bcrypt hash");
assert.notEqual(newModel.state.user.password, seedPassword, "seed never stores plaintext credentials");
assert.equal(newModel.state.user.role, "super_admin");
assert.equal(newModel.state.user.status, "active");
assert.equal(newModel.state.user.planOverride, "unlimited");
assert.equal(newModel.state.user.mustChangePassword, true);

const history = [{ sessionId: "preserved" }];
const existing = { email: "owner@example.test", password: seedHash, history, role: "user", status: "active", async save() {} };
const existingModel = makeUserModel(existing);
await seedAdmin({ config: { ...seedConfig, adminPasswordHash: replacementHash }, UserModel: existingModel });
assert.equal(existing.password, seedHash, "existing password is preserved when reset is false");
assert.equal(existing.history, history, "existing history is preserved");
await seedAdmin({ config: { ...seedConfig, adminPasswordHash: replacementHash, adminResetPasswordOnSeed: true }, UserModel: existingModel });
assert.equal(existing.password, replacementHash, "existing password is replaced only when reset is true");
await seedAdmin({ config: { ...seedConfig, adminPasswordHash: replacementHash }, UserModel: existingModel });
assert.equal(existingModel.state.createCalls, 0, "repeated seeds do not create duplicate users");
await assert.rejects(() => seedAdmin({ config: { ...seedConfig, adminPasswordHash: "" }, UserModel: newModel }), /valid bcrypt/);
await assert.rejects(() => seedAdmin({ config: { ...seedConfig, adminPasswordHash: "not-a-bcrypt-hash" }, UserModel: newModel }), /valid bcrypt/);

const bootstrapMessages = { info: [], error: [] };
const bootstrapLogger = {
  info(message) { bootstrapMessages.info.push(message); },
  error(message) { bootstrapMessages.error.push(message); }
};
let bootstrapCalls = 0;
const bootstrapSeed = async ({ config }) => {
  bootstrapCalls += 1;
  assert.equal(config.adminResetPasswordOnSeed, true);
};
const enabledBootstrap = await runStartupAdminBootstrap({
  config: { ...seedConfig, adminResetPasswordOnSeed: true },
  seed: bootstrapSeed,
  logger: bootstrapLogger
});
assert.equal(enabledBootstrap, true, "startup bootstrap runs when all values are present and reset is enabled");
assert.equal(bootstrapCalls, 1);
assert.deepEqual(bootstrapMessages.info, ["Super admin account initialized securely."]);

await runStartupAdminBootstrap({ config: seedConfig, seed: bootstrapSeed, logger: bootstrapLogger });
await runStartupAdminBootstrap({ config: { ...seedConfig, adminEmail: "", adminResetPasswordOnSeed: true }, seed: bootstrapSeed, logger: bootstrapLogger });
await runStartupAdminBootstrap({ config: { ...seedConfig, adminPasswordHash: "", adminResetPasswordOnSeed: true }, seed: bootstrapSeed, logger: bootstrapLogger });
assert.equal(bootstrapCalls, 1, "disabled or incomplete bootstrap configuration never invokes the seed");

const safeErrors = [];
const sensitiveValues = [seedConfig.adminEmail, seedConfig.adminPasswordHash];
const failedBootstrap = await runStartupAdminBootstrap({
  config: { ...seedConfig, adminResetPasswordOnSeed: true },
  seed: async () => { throw new Error(`unsafe details ${sensitiveValues.join(" ")}`); },
  logger: { info() {}, error(message) { safeErrors.push(message); } }
});
assert.equal(failedBootstrap, false, "bootstrap failure does not escape and block startup");
assert.deepEqual(safeErrors, ["Super admin initialization failed securely."]);
assert.equal(sensitiveValues.some((value) => safeErrors[0].includes(value)), false, "bootstrap errors do not expose configuration values");
// ROOT CAUSE (production entitlement contradiction): access must be derived from a single
// authoritative role/subscription calculation (subscriptionSnapshot + hasUnlimitedAccess), not
// re-derived per-page. These two named production accounts are the exact ones the owner
// reported seeing "Unlimited" in the Admin Dashboard but redirected to /subscription from Live
// Translate — proving the authoritative calculation grants both real interpreter access
// regardless of a stale/expired subscriptionEndsAt is the regression that must never break.
const superAdminAccount = {
  email: "niyongabojosue11@gmail.com",
  role: "super_admin",
  status: "active",
  subscriptionEndsAt: new Date("2020-01-01T00:00:00.000Z"), // deliberately stale/expired
  subscriptionType: "trial",
  trialSecondsRemaining: 0
};
const adminAccount = {
  email: "ndayisabadavid830@gmail.com",
  role: "admin",
  status: "active",
  subscriptionEndsAt: new Date("2020-01-01T00:00:00.000Z"), // deliberately stale/expired
  subscriptionType: "trial",
  trialSecondsRemaining: 0
};
for (const account of [superAdminAccount, adminAccount]) {
  assert.equal(hasUnlimitedAccess(account), true, `${account.email} bypasses gating via role`);
  const snapshot = subscriptionSnapshot({ ...account });
  assert.equal(snapshot.isUnlimited, true, `${account.email} is unlimited regardless of a stale subscriptionEndsAt`);
  assert.equal(snapshot.canUseInterpreter, true, `${account.email} can use the interpreter (no /subscription redirect)`);
  assert.equal(snapshot.subscriptionEndsAt, null, `${account.email} never displays a stale expiration date once unlimited`);
  assert.notEqual(snapshot.planLabel, "Expired", `${account.email} is never labeled Expired while unlimited (the exact contradiction reported: Unlimited in Admin Dashboard, Expired on the Subscription page)`);
}
assert.equal(superAdminAccount.role, "super_admin");
assert.equal(adminAccount.role, "admin", "the second privileged account is admin, never promoted to super_admin by this regression");

// An admin's stale subscription record must not be silently "fixed" by promoting it — the
// bypass must come from role alone, matching the desired policy: super_admin/admin always
// unlimited; ordinary users evaluated on real trial/subscription state.
const expiredOrdinaryUser = { role: "user", status: "expired", subscriptionType: "trial", trialSecondsRemaining: 0 };
assert.equal(subscriptionSnapshot(expiredOrdinaryUser).canUseInterpreter, false, "an ordinary expired user remains correctly blocked");
const activeOrdinaryTrialUser = { role: "user", status: "active", subscriptionType: "trial", trialSecondsRemaining: 120 };
assert.equal(subscriptionSnapshot(activeOrdinaryTrialUser).canUseInterpreter, true, "an ordinary user with remaining trial seconds is allowed");
const exhaustedOrdinaryTrialUser = { role: "user", status: "active", subscriptionType: "trial", trialSecondsRemaining: 0 };
assert.equal(subscriptionSnapshot(exhaustedOrdinaryTrialUser).canUseInterpreter, false, "an ordinary user with an exhausted trial is correctly blocked");

// ROOT CAUSE (possible duplicate accounts): email identity must be normalized (trim + lowercase)
// so "Test@Example.com", "test@example.com", and "TEST@example.com" are recognized as the same
// logical account by any duplicate-detection tooling, even if legacy/pre-normalization records
// in the database still differ by case.
assert.equal(normalizeEmail(" Test@Example.com "), "test@example.com");
assert.equal(normalizeEmail("TEST@EXAMPLE.COM"), "test@example.com");
const caseVariantDocs = [
  { _id: "a", email: "Test@Example.com", createdAt: new Date("2025-01-01") },
  { _id: "b", email: "test@example.com", createdAt: new Date("2025-06-01") },
  { _id: "c", email: "TEST@example.com", createdAt: new Date("2025-09-01") },
  { _id: "d", email: "unrelated@example.com", createdAt: new Date("2025-09-01") }
];
const duplicateGroups = groupUsersByNormalizedEmail(caseVariantDocs);
assert.equal(duplicateGroups.length, 1, "case-variant emails are detected as a single duplicate group");
assert.equal(duplicateGroups[0].normalizedEmail, "test@example.com");
assert.equal(duplicateGroups[0].count, 3, "all three case variants are grouped together");
assert.deepEqual(duplicateGroups[0].accounts.map((/** @type {{id: string}} */ a) => a.id), ["a", "b", "c"], "duplicate accounts are reported oldest-first so a human can identify the original record");
assert.equal(User.schema.indexes().some((/** @type {[Record<string, any>, Record<string, any>]} */ [keys, options]) => keys.email === 1 && options?.unique && options?.collation?.strength === 2), true, "a case-insensitive unique index guards against future duplicate emails at the database layer");

console.log("Admin security regression tests passed.");
