import assert from "node:assert/strict";
import User from "../models/User.js";
import PaymentHistory from "../models/PaymentHistory.js";
import {
  activateSubscription,
  addTrialSeconds,
  calculateDaysRemaining,
  consumeTrialUsage,
  expireTrialNow,
  initializeTrial,
  normalizeSubscription,
  resetTrialUsage,
  subscriptionSnapshot,
  TRIAL_SECONDS
} from "../services/subscriptionService.js";

const now = new Date("2026-01-01T00:00:00.000Z");

// The free trial is exactly 300 seconds (5 minutes) of actual interpreter usage, not a
// calendar window: a brand-new normal user starts fully allotted and can use it immediately.
assert.equal(TRIAL_SECONDS, 300, "the trial is exactly 5 minutes of usage");
const newUser = initializeTrial({ role: "user", status: "active", plan: "free" }, now);
assert.equal(newUser.subscriptionType, "trial", "new registration creates a trial");
assert.equal(newUser.trialSecondsRemaining, 300, "a brand-new trial starts with the full 300 seconds");
assert.equal(newUser.trialSecondsUsed, 0, "a brand-new trial has used none of its seconds yet");
assert.equal(newUser.trialEndsAt, null, "the trial has no calendar expiry; only usage matters");
assert.equal(subscriptionSnapshot(newUser, now).canUseInterpreter, true, "a fresh 300-second trial can use the interpreter");

// Using the interpreter for ~60 seconds leaves ~240 remaining, and this is computed purely
// from server-tracked state (previous remaining/used), never from anything client-supplied.
consumeTrialUsage(newUser, 60);
assert.equal(newUser.trialSecondsRemaining, 240, "60 seconds of usage leaves 240 seconds remaining");
assert.equal(newUser.trialSecondsUsed, 60, "60 seconds of usage is recorded as used");
assert.equal(subscriptionSnapshot(newUser, now).canUseInterpreter, true, "240 remaining seconds still allow interpreter access");

// A client cannot spoof extra remaining time: consumeTrialUsage only ever reads/writes the
// authoritative fields already on the user document, ignoring any other property that might
// be set on the object (simulating a manipulated payload merged onto it).
const tamperedUser = { ...newUser, trialSecondsRemaining: 99999, __clientSuppliedRemaining: 99999 };
consumeTrialUsage(tamperedUser, 30);
assert.equal(tamperedUser.trialSecondsRemaining, 99969, "consumeTrialUsage always subtracts from whatever remaining value the server actually has, not a fabricated one");

// Exhausting the 300 seconds blocks interpreter access and marks the account expired,
// exactly like the old date-based expiry did, just driven by usage instead of a clock.
consumeTrialUsage(newUser, 240);
assert.equal(newUser.trialSecondsRemaining, 0, "the trial reaches exactly zero once fully used");
assert.equal(newUser.status, "expired", "a fully used trial expires automatically");
assert.equal(subscriptionSnapshot(newUser, now).canUseInterpreter, false, "0 remaining seconds blocks the interpreter");

// Using time beyond what remains clamps at zero rather than going negative.
const overUsedUser = initializeTrial({ role: "user", status: "active" }, now);
consumeTrialUsage(overUsedUser, 500);
assert.equal(overUsedUser.trialSecondsRemaining, 0, "usage beyond the remaining balance clamps to zero, never negative");
assert.equal(overUsedUser.trialSecondsUsed, 300, "used seconds clamp at the 300-second total");

for (const role of ["admin", "super_admin"]) {
  const unlimited = { role, status: "expired", trialSecondsRemaining: 0 };
  normalizeSubscription(unlimited, now);
  const snapshot = subscriptionSnapshot(unlimited, now);
  assert.equal(snapshot.isUnlimited, true, `${role} is unlimited`);
  assert.equal(snapshot.daysRemaining, null);
  assert.equal(snapshot.trialSecondsRemaining, null, `${role} has no trial countdown at all`);
  assert.equal(snapshot.canUseInterpreter, true);
  const stillUnlimited = { role, status: "active", trialSecondsRemaining: 300 };
  consumeTrialUsage(stillUnlimited, 999);
  assert.equal(stillUnlimited.trialSecondsRemaining, 300, `${role} usage is never charged against a trial balance`);
}

// A paid subscriber is never restricted by the 300-second trial, and using the interpreter
// does not touch their trial fields at all.
const subscriber = initializeTrial({ role: "user", status: "expired" }, now);
activateSubscription(subscriber, { type: "monthly", startsAt: now, provider: "manual", reference: "future-ref" });
assert.equal(subscriptionSnapshot(subscriber, now).planLabel, "Premium Monthly", "subscription activation updates access");
assert.equal(calculateDaysRemaining(subscriber.subscriptionEndsAt, now), 30, "remaining days are calculated inclusively");
assert.equal(subscriptionSnapshot(subscriber, now).trialSecondsRemaining, null, "a paid subscriber has no trial countdown shown");
const subscriberTrialSecondsBefore = subscriber.trialSecondsRemaining;
consumeTrialUsage(subscriber, 120, now);
assert.equal(subscriber.trialSecondsRemaining, subscriberTrialSecondsBefore, "a paid subscriber's interpreter usage never consumes trial seconds");

// Deterministic backward-compatible migration from the old 7-day calendar trial: a legacy
// user who is mid-way through an unexpired old trial converts to a fresh 300-second usage
// allotment (no one loses access mid-trial); a legacy user whose old trial had already lapsed
// gets 0 seconds (no trial is silently re-granted to an already-expired account).
const legacyActiveTrial = { role: "user", status: "active", plan: "free", subscriptionType: "trial", subscriptionStatus: "active", isTrial: true, trialStartAt: now, trialEndsAt: new Date("2026-01-05T00:00:00.000Z"), createdAt: now };
normalizeSubscription(legacyActiveTrial, now);
assert.equal(legacyActiveTrial.trialSecondsRemaining, 300, "a legacy trial that had not yet expired converts to a fresh 300-second allotment");
assert.equal(legacyActiveTrial.trialEndsAt, null, "the migrated trial no longer carries a calendar expiry");

const legacyExpiredTrial = { role: "user", status: "active", plan: "free", subscriptionType: "trial", subscriptionStatus: "active", isTrial: true, trialStartAt: new Date("2025-12-01T00:00:00.000Z"), trialEndsAt: new Date("2025-12-08T00:00:00.000Z"), createdAt: now };
normalizeSubscription(legacyExpiredTrial, now);
assert.equal(legacyExpiredTrial.trialSecondsRemaining, 0, "a legacy trial that had already expired migrates to 0 seconds, not a new grant");
assert.equal(legacyExpiredTrial.status, "expired", "an already-expired legacy account remains expired after migration");

const legacyNoTrialDates = { role: "user", status: "active", plan: "free", createdAt: now };
normalizeSubscription(legacyNoTrialDates, now);
assert.equal(legacyNoTrialDates.subscriptionType, "trial", "legacy users without prior subscription data migrate into a trial");
assert.equal(legacyNoTrialDates.trialSecondsRemaining, 300, "a legacy account with no prior trial dates gets a full 300-second trial");
assert.equal(legacyNoTrialDates.plan, "free");

// Migration is idempotent: re-normalizing an already-migrated user must not re-grant seconds.
normalizeSubscription(legacyExpiredTrial, now);
assert.equal(legacyExpiredTrial.trialSecondsRemaining, 0, "migration only happens once; re-normalizing an already-migrated user is a no-op");

// Admin trial-override helpers used by the dashboard's "Reset 5-min trial" / "Add 5 min" /
// "Expire trial now" actions.
const adminManagedUser = initializeTrial({ role: "user", status: "active" }, now);
consumeTrialUsage(adminManagedUser, 300);
assert.equal(adminManagedUser.status, "expired");
resetTrialUsage(adminManagedUser, now);
assert.equal(adminManagedUser.trialSecondsRemaining, 300, "reset_trial restores the full 300 seconds");
assert.equal(adminManagedUser.status, "active", "reset_trial reactivates a previously expired account");
addTrialSeconds(adminManagedUser, 120);
assert.equal(adminManagedUser.trialSecondsRemaining, 420, "add_trial_minutes adds on top of whatever remains");
expireTrialNow(adminManagedUser);
assert.equal(adminManagedUser.trialSecondsRemaining, 0, "expire_trial zeroes the balance immediately");
assert.equal(adminManagedUser.status, "expired");

for (const field of ["trialStartAt", "trialEndsAt", "trialSecondsRemaining", "trialSecondsUsed", "trialActiveSessionKey", "subscriptionStatus", "subscriptionType", "subscriptionStartsAt", "subscriptionEndsAt", "isTrial", "isUnlimited", "paymentProvider", "paymentReference", "lastPaymentAt", "nextRenewalAt"]) assert.ok(User.schema.path(field), `User schema includes ${field}`);
for (const field of ["reference", "transactionId", "bankReference", "accountReference", "providerResponse"]) assert.ok(PaymentHistory.schema.path(field), `Payment history is ready for ${field}`);
console.log("Subscription foundation regression tests passed.");
