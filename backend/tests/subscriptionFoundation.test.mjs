import assert from "node:assert/strict";
import User from "../models/User.js";
import PaymentHistory from "../models/PaymentHistory.js";
import { activateSubscription, calculateDaysRemaining, initializeTrial, normalizeSubscription, subscriptionSnapshot } from "../services/subscriptionService.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const newUser = initializeTrial({ role: "user", status: "active", plan: "free" }, now);
assert.equal(newUser.subscriptionType, "trial", "new registration creates a trial");
assert.equal(newUser.trialEndsAt.toISOString(), "2026-01-08T00:00:00.000Z", "trial lasts seven days");
assert.equal(subscriptionSnapshot(newUser, now).canUseInterpreter, true);

normalizeSubscription(newUser, new Date("2026-01-09T00:00:00.000Z"));
assert.equal(newUser.status, "expired", "trial expires automatically");
assert.equal(subscriptionSnapshot(newUser, new Date("2026-01-09T00:00:00.000Z")).canUseInterpreter, false, "expired interpreter access is blocked");

for (const role of ["admin", "super_admin"]) {
  const unlimited = { role, status: "expired", trialEndsAt: new Date(0) };
  normalizeSubscription(unlimited, now);
  const snapshot = subscriptionSnapshot(unlimited, now);
  assert.equal(snapshot.isUnlimited, true, `${role} is unlimited`);
  assert.equal(snapshot.daysRemaining, null);
  assert.equal(snapshot.canUseInterpreter, true);
}

const subscriber = initializeTrial({ role: "user", status: "expired" }, now);
activateSubscription(subscriber, { type: "monthly", startsAt: now, provider: "manual", reference: "future-ref" });
assert.equal(subscriptionSnapshot(subscriber, now).planLabel, "Premium Monthly", "subscription activation updates access");
assert.equal(calculateDaysRemaining(subscriber.subscriptionEndsAt, now), 30, "remaining days are calculated inclusively");

const legacy = { role: "user", status: "active", plan: "free", createdAt: now };
normalizeSubscription(legacy, now);
assert.equal(legacy.subscriptionType, "trial", "legacy users migrate without changing legacy plan");
assert.equal(legacy.plan, "free");

for (const field of ["trialStartAt", "trialEndsAt", "subscriptionStatus", "subscriptionType", "subscriptionStartsAt", "subscriptionEndsAt", "isTrial", "isUnlimited", "paymentProvider", "paymentReference", "lastPaymentAt", "nextRenewalAt"]) assert.ok(User.schema.path(field), `User schema includes ${field}`);
for (const field of ["reference", "transactionId", "bankReference", "accountReference", "providerResponse"]) assert.ok(PaymentHistory.schema.path(field), `Payment history is ready for ${field}`);
console.log("Subscription foundation regression tests passed.");
