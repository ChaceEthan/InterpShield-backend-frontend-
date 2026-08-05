import assert from "node:assert/strict";
import fs from "node:fs";
import { createDubbingLifecycle } from "../src/audio/dubbingLifecycle.mjs";
import { isAdminRole, normalizeAuthUser, normalizeUserRole } from "../src/auth/roles.mjs";
import { PLAN_CATALOG, YEARLY_DISCOUNT_RATE, yearlyMonthlyPrice } from "../../shared/plans.mjs";
import { PLAN_DEFINITIONS } from "../../backend/utils/monetizationUtils.js";

assert.equal(normalizeUserRole("super_admin"), "super_admin");
assert.equal(normalizeUserRole("super-admin"), "super_admin");
assert.equal(normalizeUserRole("superadmin"), "super_admin");
assert.equal(normalizeAuthUser({ role: "super-admin" }).role, "super_admin");
assert.equal(isAdminRole("admin"), true);
assert.equal(isAdminRole("superadmin"), true);
assert.equal(isAdminRole("user"), false);

const appSource = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const adminDashboardSource = fs.readFileSync(new URL("../src/components/AdminDashboard.tsx", import.meta.url), "utf8");
assert.match(appSource, /requestApi<\{ token\?: string; user: AppUser \}>\("\/api\/auth\/me"/, "login refreshes the backend profile before routing");
assert.match(appSource, /const destination = isAdminRole\(refreshed\.user\.role\) \? "admin" : "dashboard"/, "password login routes using the refreshed profile role");
assert.match(appSource, /isAdminRole\(refreshed\.user\.role\) \? "admin" : "dashboard"\s*\)/, "Google login routes using the refreshed profile role");
assert.match(appSource, /view === "admin" && token && isAdminRole\(user\?\.role\)/, "admin rendering requires a verified admin role");
assert.match(appSource, /isAdminRole\(user\?\.role\)[\s\S]*Admin Dashboard/, "the account panel exposes an admin-only dashboard control");
assert.match(adminDashboardSource, /Loading administration…/, "admin APIs have a visible loading state");
assert.match(adminDashboardSource, /e\.status === 401\) onUnauthorized/, "admin API authentication failures are handled");
assert.match(adminDashboardSource, /e\.status === 403\) onForbidden/, "admin API authorization failures are handled");
assert.match(adminDashboardSource, /Promote to admin/, "super admins receive a clear promotion action");
assert.match(adminDashboardSource, /Remove admin role/, "super admins receive a clear role-removal action");

const plays = [];
const gates = [];
const completions = [];
const lifecycle = createDubbingLifecycle({
  play(job, onEnd, onError) { plays.push({ job, onEnd, onError }); },
  onGateChange(value) { gates.push(value); },
  onIdle() { completions.push("idle"); },
  schedule(callback) { callback(); },
  pauseMs: () => 0
});

assert.equal(lifecycle.enqueue({ translationId: "utterance-1", language: "fr", text: "Bonjour" }), true);
assert.equal(plays.length, 1, "first utterance dubs");
plays.shift().onEnd();
assert.equal(lifecycle.snapshot().gated, false, "microphone gating ends after playback");
assert.equal(completions.length, 1, "listening can resume after dubbing");

assert.equal(lifecycle.enqueue({ translationId: "utterance-2", language: "fr", text: "Bonjour" }), true);
assert.equal(plays.length, 1, "identical text in a second utterance dubs again");
plays.shift().onEnd();
assert.equal(lifecycle.enqueue({ translationId: "utterance-3", language: "fr", text: "Troisième" }), true);
assert.equal(plays.length, 1, "third utterance dubs after earlier completion");
plays.shift().onEnd();
assert.equal(lifecycle.enqueue({ translationId: "utterance-3", language: "fr", text: "Troisième" }), false, "duplicate event for one utterance is suppressed");

lifecycle.enqueue({ translationId: "utterance-4", language: "fr", text: "Français" });
lifecycle.enqueue({ translationId: "utterance-4", language: "ru", text: "Русский" });
assert.equal(plays.length, 2, "target languages maintain independent queues");
plays.find(({ job }) => job.language === "fr").onError();
assert.equal(lifecycle.snapshot().gated, true, "one target failure does not ungate another active target");
plays.find(({ job }) => job.language === "ru").onEnd();
assert.equal(lifecycle.snapshot().gated, false, "all target completion releases gating");
assert.equal(lifecycle.snapshot().queued, 0, "completed jobs leave no stale queue lock");
assert.deepEqual(gates.slice(-2), [true, false]);

plays.length = 0;
for (let sentence = 1; sentence <= 20; sentence += 1) {
  const translationId = `long-run-utterance-${sentence}`;
  const language = ["fr", "ru", "zh"][sentence % 3];
  assert.equal(
    lifecycle.enqueue({ translationId, language, text: `Translated sentence ${sentence}`, createdAt: sentence }),
    true,
    `sentence ${sentence} enters its language queue`
  );
  const playback = plays.shift();
  assert.ok(playback, `sentence ${sentence} starts playback`);
  assert.equal(playback.job.translationId, translationId, `sentence ${sentence} preserves utterance ordering`);
  playback.onEnd();
  assert.equal(lifecycle.snapshot().gated, false, `sentence ${sentence} releases microphone gating`);
  assert.equal(lifecycle.snapshot().queued, 0, `sentence ${sentence} leaves no frozen queue`);
}
assert.equal(plays.length, 0, "all twenty sequential playback callbacks completed");

assert.equal(PLAN_CATALOG.pro_lite.monthlyPrice, 3, "Starter is $3 monthly");
assert.equal(PLAN_CATALOG.creator.monthlyPrice, 7);
assert.equal(PLAN_CATALOG.business.monthlyPrice, 15);
assert.equal(YEARLY_DISCOUNT_RATE, 0.2, "yearly discount is 20%");
assert.equal(yearlyMonthlyPrice(3), 2.4);
for (const [planId, catalogPlan] of Object.entries(PLAN_CATALOG)) {
  assert.equal(PLAN_DEFINITIONS[planId].price, catalogPlan.monthlyPrice, `${planId} backend and frontend prices match`);
  assert.equal(PLAN_DEFINITIONS[planId].captionMinutes, catalogPlan.captionMinutes, `${planId} caption limits match`);
  assert.equal(PLAN_DEFINITIONS[planId].translationMinutes, catalogPlan.translationMinutes, `${planId} translation limits match`);
}

console.log("Admin visibility, repeat dubbing, and pricing regression tests passed.");
