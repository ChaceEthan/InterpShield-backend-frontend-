import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The free trial moved from a 7-day calendar window to 300 seconds (5 minutes) of actual,
// server-metered interpreter usage. These are source-pattern regression guards (this
// codebase's established convention for App.tsx/AdminDashboard.tsx, since they aren't
// imported/executed directly by the plain-node test runner) proving the frontend no longer
// carries the old day-based trial concepts and is wired to the new usage model end to end.
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const adminSource = readFileSync(new URL("../src/components/AdminDashboard.tsx", import.meta.url), "utf8");

assert.doesNotMatch(appSource, /trialEndsAt/, "the frontend no longer references the retired calendar-based trialEndsAt field");
assert.doesNotMatch(adminSource, /trialEndsAt|Days Remaining|Grant 7-day trial|Extend trial/, "the admin dashboard no longer shows obsolete 7-day trial wording or actions");
assert.match(appSource, /trialSecondsRemaining\?: number \| null; trialSecondsUsed\?: number \| null; trialSecondsTotal\?: number;/, "the frontend subscription type carries the server-authoritative trial-seconds fields");
assert.match(appSource, /Your 5-minute free trial has ended\. Choose a plan to continue using InterpShield\./, "trial exhaustion shows the exact required message, not the old free-form 7-day wording");

// A server-pushed trial_expired event (fired the moment the backend meter reaches zero mid
// session) must stop the local capture, not just show a toast the user could miss.
assert.match(appSource, /socket\.on\("trial_expired", \(\{ message \}[\s\S]{0,150}if \(recordingRef\.current\) stopSession\(\);/, "trial expiry mid-session stops the live capture, it doesn't just alert while leaving the mic open");

// The trial countdown shown to the user is re-fetched from the server after every session
// end and periodically during long desktop sessions, never trusted from stale client state.
assert.equal((appSource.match(/void refreshMe\(\);\s*\}, \[cleanupMedia,[^\]]*refreshMe[^\]]*\]\);/g) || []).length, 2, "both explicit Stop and finishDrain refresh the server-authoritative trial balance after a session ends");
assert.match(appSource, /window\.setInterval\(\(\) => \{ void refreshMe\(\); \}, 15000\);/, "a live session periodically re-syncs the trial countdown from the server instead of only showing a client-side guess");

// Admin dashboard: usage-based labels, mm:ss countdown formatting, and the new intentional
// admin actions (reset/add/expire) replacing the old day-based grant/extend actions.
assert.match(adminSource, /trialSecondsRemaining\?: number \| null; trialSecondsUsed\?: number \| null; trialSecondsTotal\?: number;/, "the admin user type carries the new trial-seconds fields");
assert.match(adminSource, /const formatTrialRemaining = \(user: AdminUser\) => \{/, "trial remaining renders as a countdown clock, not a day count");
// Subscription actions (reset/add/expire trial, and the rest) are driven by a compact
// dropdown + Apply button (SUBSCRIPTION_ACTIONS) instead of a wall of individual buttons per
// row, but each action still carries the exact same reason string sent to the audit log.
assert.match(adminSource, /value: "reset_trial", label: "Reset 5-min trial", payload: \{ action: "reset_trial" \}, reason: "reset 5-minute trial"/, "admin can reset a user's 5-minute trial");
assert.match(adminSource, /value: "add_trial_minutes", label: "Add 5 min", payload: \{ action: "add_trial_minutes", days: 5 \}, reason: "add 5 trial minutes"/, "admin can add trial minutes instead of extending a calendar date");
assert.match(adminSource, /value: "expire_trial", label: "Expire trial now", payload: \{ action: "expire_trial" \}, reason: "expire trial now"/, "admin can expire a trial immediately");
assert.match(adminSource, /Free trial = 5 minutes \(300 seconds\) of actual interpreter usage, tracked server-side\. Not a calendar window\./, "the subscription management panel explicitly documents the new model so it can't be mistaken for the old one");

console.log("Trial usage-model frontend regression tests passed.");
