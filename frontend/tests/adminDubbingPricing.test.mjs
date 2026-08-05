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
const transcriptAreaSource = fs.readFileSync(new URL("../src/components/TranscriptArea.tsx", import.meta.url), "utf8");
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
assert.match(appSource, /socket\.on\("disconnect",[\s\S]*?stopDubbingPlayback\(true\)/, "socket reconnect cleanup clears queued dubbing");
assert.match(appSource, /dubbingLanguageSignature[\s\S]*?stopDubbingPlayback\(true\)/, "language changes clear queued dubbing");
assert.match(appSource, /void loadSpeechVoices\(\)\.then/, "voices are requested before dubbing jobs are queued");
assert.match(appSource, /speechSynthesis\.speak\(utterance\)/, "completed translations invoke browser speech playback");
assert.match(appSource, /Dubbing is unavailable: \$\{unavailableReason\}/, "unsupported automatic dubbing reports an exact reason");
assert.match(appSource, /EXPECTED_SPEECH_CANCELLATIONS = new Set\(\["interrupted", "canceled", "cancelled"\]\)/, "intentional browser speech cancellations are classified as expected");
assert.match(appSource, /if \(isExpectedSpeechCancellation\(reason\)\)[\s\S]*?onError\(\)/, "expected cancellation settles the queue without displaying a new failure");
assert.match(appSource, /const createdAt = Date\.now\(\)/, "completed translations are fresh when submitted to speech synthesis");
assert.doesNotMatch(appSource, /recordingRef\.current = isRecording/, "dubbing UI status cannot reactivate a stopped microphone");
assert.match(appSource, /recordingRef\.current = true;\s*recorder\.start/, "actual MediaRecorder startup activates the microphone ref");
assert.match(appSource, /completeListeningSession\(modeRef\.current !== "transcribe"\)/, "a finalized utterance automatically releases microphone capture while preserving pending translation");
assert.match(appSource, /const speakTranslatedCaption[\s\S]*?stopDubbingPlayback\(true\)/, "manual translated-card replay stops current speech first");
assert.match(transcriptAreaSource, /onSpeakTranslation\?\.\(entry\.language, entry\.text\)/, "translated cards replay their own language and text");
assert.match(transcriptAreaSource, /Speak \$\{entry\.label\} translation/, "translated cards expose an accessible speaker action");

const plays = [];
const prepared = [];
const gates = [];
const completions = [];
let cancels = 0;
let testNow = 1000;
const lifecycle = createDubbingLifecycle({
  prepare(job) { prepared.push(job.translationId); return { job }; },
  play(preparedSpeech, job, onStart, onEnd, onError) { plays.push({ preparedSpeech, job, onStart, onEnd, onError }); },
  cancel() { cancels += 1; },
  onGateChange(value) { gates.push(value); },
  onIdle() { completions.push("idle"); },
  now: () => testNow,
  maxAgeMs: 500
});

assert.equal(lifecycle.enqueue({ translationId: "utterance-1", language: "fr", text: "Bonjour" }), true);
assert.equal(plays.length, 1, "first utterance dubs");
assert.equal(lifecycle.enqueue({ translationId: "utterance-2", language: "fr", text: "Bonjour" }), true);
assert.equal(plays.length, 2, "second TTS is prepared and submitted while the first is playing");
assert.deepEqual(prepared.slice(0, 2), ["utterance-1", "utterance-2"], "TTS preparation preserves translation order");
assert.equal(lifecycle.enqueue({ translationId: "utterance-2", language: "fr", text: "Bonjour" }), false, "duplicate socket aliases do not submit TTS twice");
plays.shift().onEnd();
assert.equal(lifecycle.snapshot().gated, true, "microphone remains gated while prepared speech is queued");
plays.shift().onEnd();
assert.equal(lifecycle.snapshot().gated, false, "microphone gating ends after all playback");
assert.equal(completions.length, 1, "listening can resume after dubbing");

assert.equal(lifecycle.enqueue({ translationId: "utterance-3", language: "fr", text: "Troisième" }), true);
assert.equal(plays.length, 1, "third utterance dubs after earlier completion");
plays.shift().onEnd();
assert.equal(lifecycle.enqueue({ translationId: "utterance-3", language: "fr", text: "Troisième" }), false, "duplicate event for one utterance is suppressed");
assert.equal(lifecycle.enqueue({ translationId: "stale", language: "fr", text: "Trop tard", createdAt: 1 }), false, "stale translated speech is discarded");

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
    lifecycle.enqueue({ translationId, language, text: `Translated sentence ${sentence}`, createdAt: 1000 }),
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

lifecycle.enqueue({ translationId: "queued-before-stop", language: "zh", text: "排队", createdAt: 1000 });
lifecycle.stop();
assert.equal(cancels, 1, "session or language cleanup cancels browser speech and clears its queue");
assert.equal(lifecycle.snapshot().queued, 0);
assert.equal(lifecycle.snapshot().gated, false);
plays.length = 0;

lifecycle.enqueue({ translationId: "fresh-then-delayed", language: "zh", text: "延迟", createdAt: 1000 });
testNow = 1600;
plays.shift().onStart();
assert.equal(cancels, 2, "speech that became stale in the browser queue is cancelled before playback");
assert.equal(lifecycle.snapshot().gated, false, "stale queue cancellation releases microphone gating");

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
