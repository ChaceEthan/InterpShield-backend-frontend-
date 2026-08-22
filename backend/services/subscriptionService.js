// The free trial is usage-based, not calendar-based: every normal new user starts with
// TRIAL_SECONDS of actual interpreter usage (180s = 3 minutes), tracked server-side in
// trialSecondsRemaining/trialSecondsUsed. TRIAL_DAYS/addDays remain for paid-subscription
// durations only (monthly/quarterly/yearly), which are unaffected by this trial model.
export const TRIAL_SECONDS = 180;
export const TRIAL_DAYS = 7;
export const UNLIMITED_ROLES = new Set(["admin", "super_admin"]);
export const SUBSCRIPTION_TYPES = new Set(["none", "trial", "monthly", "quarterly", "yearly", "enterprise", "unlimited"]);
export const PAYMENT_PROVIDERS = new Set(["none", "mtn_momo", "airtel_money", "stripe", "equity_bank", "flutterwave", "paypal", "manual"]);
export const EXPIRED_ACCESS_MESSAGE = "Your 3-minute free trial has ended. Choose a plan to continue using InterpShield.";

const dateValue = (value) => value ? new Date(value) : null;
export const addDays = (date, days) => new Date(new Date(date).getTime() + days * 86400000);
export const calculateDaysRemaining = (endsAt, now = new Date()) => endsAt ? Math.max(0, Math.ceil((new Date(endsAt).getTime() - new Date(now).getTime()) / 86400000)) : null;
export const hasActiveSubscription = (user, now = new Date()) => Boolean(user.subscriptionStatus === "active" && user.subscriptionType && !["none", "trial"].includes(user.subscriptionType) && (!user.subscriptionEndsAt || dateValue(user.subscriptionEndsAt) > now));
export const isUnlimitedUser = (user) => UNLIMITED_ROLES.has(user?.role) || user?.subscriptionType === "unlimited" || user?.isUnlimited === true;
export const clampTrialSeconds = (value) => Math.min(TRIAL_SECONDS, Math.max(0, Math.round(Number(value) || 0)));

export const initializeTrial = (user, now = new Date()) => {
  if (isUnlimitedUser(user)) return applyUnlimited(user);
  user.trialStartAt = dateValue(user.trialStartAt) || now;
  user.trialEndsAt = null;
  if (!Number.isFinite(user.trialSecondsRemaining)) {
    user.trialSecondsRemaining = TRIAL_SECONDS;
    user.trialSecondsUsed = 0;
  }
  user.subscriptionStatus = "active";
  user.subscriptionType = "trial";
  user.isTrial = true;
  user.isUnlimited = false;
  user.paymentProvider ||= "none";
  user.subscriptionNotifications ||= [];
  if (!user.subscriptionNotifications.some((item) => item.type === "welcome")) user.subscriptionNotifications.push({ type: "welcome", sentAt: now });
  return user;
};

export const applyUnlimited = (user) => {
  user.status = "active";
  user.subscriptionStatus = "unlimited";
  user.subscriptionType = "unlimited";
  user.isTrial = false;
  user.isUnlimited = true;
  user.trialStartAt = null;
  user.trialEndsAt = null;
  user.subscriptionEndsAt = null;
  user.nextRenewalAt = null;
  return user;
};

export const normalizeSubscription = (user, now = new Date()) => {
  if (isUnlimitedUser(user)) return applyUnlimited(user);
  if (!user.subscriptionType || user.subscriptionType === "none") {
    if (user.subscriptionEndsAt && dateValue(user.subscriptionEndsAt) > now) {
      user.subscriptionType = "monthly";
      user.subscriptionStatus = "active";
      user.isTrial = false;
    } else initializeTrial(user, now);
  }
  // One-time deterministic migration from the old 7-day calendar trial: an account whose
  // legacy trial had not yet expired carries over into the new model with a fresh 3-minute
  // usage allotment; an account whose legacy trial had already expired gets 0 seconds (no
  // trial is silently re-granted to an already-expired account).
  if (user.subscriptionType === "trial" && !Number.isFinite(user.trialSecondsRemaining)) {
    const legacyTrialWasActive = !user.trialEndsAt || dateValue(user.trialEndsAt) > now;
    user.trialSecondsRemaining = legacyTrialWasActive ? TRIAL_SECONDS : 0;
    user.trialSecondsUsed = 0;
  }
  if (user.subscriptionType === "trial") user.trialEndsAt = null;
  if (hasActiveSubscription(user, now)) {
    user.status = "active";
    user.isTrial = false;
  } else if (user.isTrial && Number.isFinite(user.trialSecondsRemaining) && user.trialSecondsRemaining <= 0) {
    user.status = "expired";
    user.subscriptionStatus = "expired";
    user.isTrial = false;
  }
  user.isUnlimited = false;
  return user;
};

export const subscriptionSnapshot = (user, now = new Date()) => {
  normalizeSubscription(user, now);
  const unlimited = isUnlimitedUser(user);
  const activeSubscription = hasActiveSubscription(user, now);
  const expired = !unlimited && !activeSubscription && user.status === "expired";
  const type = unlimited ? "unlimited" : activeSubscription ? user.subscriptionType : expired ? "none" : "trial";
  const labels = { trial: "Free Trial", monthly: "Premium Monthly", quarterly: "Premium Quarterly", yearly: "Premium Yearly", enterprise: "Enterprise", unlimited: "Unlimited", none: "Expired" };
  const trialSecondsRemaining = unlimited || activeSubscription ? null : clampTrialSeconds(user.trialSecondsRemaining);
  return {
    planLabel: labels[type] || "Expired",
    subscriptionStatus: unlimited ? "unlimited" : user.subscriptionStatus || (expired ? "expired" : "active"),
    subscriptionType: type,
    trialStartAt: user.trialStartAt || null,
    trialSecondsRemaining,
    trialSecondsUsed: unlimited || activeSubscription ? null : clampTrialSeconds(user.trialSecondsUsed),
    trialSecondsTotal: TRIAL_SECONDS,
    subscriptionStartsAt: user.subscriptionStartsAt || user.subscriptionStartedAt || null,
    subscriptionEndsAt: user.subscriptionEndsAt || null,
    daysRemaining: unlimited || !activeSubscription ? null : calculateDaysRemaining(user.subscriptionEndsAt, now),
    isTrial: !unlimited && type === "trial",
    isUnlimited: unlimited,
    canUseInterpreter: unlimited || activeSubscription || (!expired && trialSecondsRemaining > 0),
    paymentProvider: user.paymentProvider || "none",
    paymentReference: user.paymentReference || "",
    lastPaymentAt: user.lastPaymentAt || null,
    nextRenewalAt: user.nextRenewalAt || null
  };
};

// Authoritative server-side trial metering: called by the interpreter socket while a normal
// user's live session is actually active. Never trusts a frontend-supplied remaining value.
export const consumeTrialUsage = (user, seconds = 0, now = new Date()) => {
  if (isUnlimitedUser(user) || hasActiveSubscription(user, now)) return user;
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  if (safeSeconds <= 0) return user;
  const remaining = Number.isFinite(user.trialSecondsRemaining) ? user.trialSecondsRemaining : TRIAL_SECONDS;
  const used = Number.isFinite(user.trialSecondsUsed) ? user.trialSecondsUsed : 0;
  user.trialSecondsRemaining = Math.max(0, remaining - safeSeconds);
  user.trialSecondsUsed = Math.min(TRIAL_SECONDS, used + safeSeconds);
  if (user.trialSecondsRemaining <= 0 && user.isTrial) {
    user.status = "expired";
    user.subscriptionStatus = "expired";
    user.isTrial = false;
  }
  return user;
};

export const activateSubscription = (user, { type = "monthly", startsAt = new Date(), endsAt, provider = "manual", reference = "" } = {}) => {
  if (!SUBSCRIPTION_TYPES.has(type) || ["none", "trial", "unlimited"].includes(type)) throw new Error("Invalid subscription type.");
  if (!PAYMENT_PROVIDERS.has(provider)) throw new Error("Invalid payment provider.");
  const duration = { monthly: 30, quarterly: 90, yearly: 365, enterprise: 365 }[type];
  const renewed = user.subscriptionStatus === "active" && !["none", "trial"].includes(user.subscriptionType);
  user.status = "active"; user.subscriptionStatus = "active"; user.subscriptionType = type;
  user.subscriptionStartsAt = startsAt; user.subscriptionStartedAt = startsAt;
  user.subscriptionEndsAt = endsAt || addDays(startsAt, duration); user.nextRenewalAt = user.subscriptionEndsAt;
  user.isTrial = false; user.isUnlimited = false; user.paymentProvider = provider; user.paymentReference = reference;
  user.lastPaymentAt = startsAt;
  user.subscriptionNotifications ||= []; user.subscriptionNotifications.push({ type: renewed ? "subscription_renewed" : "subscription_activated", sentAt: startsAt });
  return user;
};

export const expireSubscription = (user) => { if (!isUnlimitedUser(user)) { user.status = "expired"; user.subscriptionStatus = "expired"; user.isTrial = false; } return user; };

// Admin-only trial overrides (see routes/admin.js): resetting or adding minutes is intentional
// usage-model administration, not a re-implementation of the old calendar-based trial grants.
export const resetTrialUsage = (user, now = new Date()) => {
  user.role = user.role === "admin" || user.role === "super_admin" ? user.role : "user";
  user.trialStartAt = now;
  user.trialEndsAt = null;
  user.trialSecondsRemaining = TRIAL_SECONDS;
  user.trialSecondsUsed = 0;
  user.subscriptionType = "trial";
  user.subscriptionStatus = "active";
  user.status = "active";
  user.isTrial = true;
  user.isUnlimited = false;
  return user;
};

export const addTrialSeconds = (user, seconds = TRIAL_SECONDS) => {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const remaining = Number.isFinite(user.trialSecondsRemaining) ? user.trialSecondsRemaining : 0;
  user.trialSecondsRemaining = remaining + safeSeconds;
  user.trialEndsAt = null;
  if (user.trialSecondsRemaining > 0 && user.subscriptionType === "trial") {
    user.status = "active";
    user.subscriptionStatus = "active";
    user.isTrial = true;
  }
  return user;
};

export const expireTrialNow = (user) => {
  user.trialSecondsRemaining = 0;
  if (user.subscriptionType === "trial") {
    user.status = "expired";
    user.subscriptionStatus = "expired";
    user.isTrial = false;
  }
  return user;
};

export class PaymentProvider { async createPayment() { throw new Error("Payment provider is not configured."); } async verifyPayment() { throw new Error("Payment provider is not configured."); } }
export class SubscriptionRepository { constructor(UserModel) { this.User = UserModel; } findById(id) { return this.User.findById(id); } save(user) { return user.save(); } }
