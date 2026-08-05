export const TRIAL_DAYS = 7;
export const UNLIMITED_ROLES = new Set(["admin", "super_admin"]);
export const SUBSCRIPTION_TYPES = new Set(["none", "trial", "monthly", "quarterly", "yearly", "enterprise", "unlimited"]);
export const PAYMENT_PROVIDERS = new Set(["none", "mtn_momo", "airtel_money", "stripe", "equity_bank", "flutterwave", "paypal", "manual"]);
export const EXPIRED_ACCESS_MESSAGE = "Your free trial has expired. Please purchase a subscription to continue using InterpShield.";

const dateValue = (value) => value ? new Date(value) : null;
export const addDays = (date, days) => new Date(new Date(date).getTime() + days * 86400000);
export const calculateDaysRemaining = (endsAt, now = new Date()) => endsAt ? Math.max(0, Math.ceil((new Date(endsAt).getTime() - new Date(now).getTime()) / 86400000)) : null;
export const hasActiveSubscription = (user, now = new Date()) => Boolean(user.subscriptionStatus === "active" && user.subscriptionType && !["none", "trial"].includes(user.subscriptionType) && (!user.subscriptionEndsAt || dateValue(user.subscriptionEndsAt) > now));
export const isUnlimitedUser = (user) => UNLIMITED_ROLES.has(user?.role) || user?.subscriptionType === "unlimited" || user?.isUnlimited === true;

export const initializeTrial = (user, now = new Date()) => {
  if (isUnlimitedUser(user)) return applyUnlimited(user);
  user.trialStartAt = dateValue(user.trialStartAt) || now;
  user.trialEndsAt = dateValue(user.trialEndsAt) || addDays(user.trialStartAt, TRIAL_DAYS);
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
  if (hasActiveSubscription(user, now)) {
    user.status = "active";
    user.isTrial = false;
  } else if (user.isTrial && dateValue(user.trialEndsAt) <= now) {
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
  const endsAt = unlimited ? null : activeSubscription ? user.subscriptionEndsAt : user.trialEndsAt;
  const expired = !unlimited && !activeSubscription && user.status === "expired";
  const type = unlimited ? "unlimited" : activeSubscription ? user.subscriptionType : expired ? "none" : "trial";
  const labels = { trial: "Free Trial", monthly: "Premium Monthly", quarterly: "Premium Quarterly", yearly: "Premium Yearly", enterprise: "Enterprise", unlimited: "Unlimited", none: "Expired" };
  return {
    planLabel: labels[type] || "Expired",
    subscriptionStatus: unlimited ? "unlimited" : user.subscriptionStatus || (expired ? "expired" : "active"),
    subscriptionType: type,
    trialStartAt: user.trialStartAt || null,
    trialEndsAt: user.trialEndsAt || null,
    subscriptionStartsAt: user.subscriptionStartsAt || user.subscriptionStartedAt || null,
    subscriptionEndsAt: user.subscriptionEndsAt || null,
    daysRemaining: unlimited ? null : calculateDaysRemaining(endsAt, now),
    isTrial: !unlimited && type === "trial",
    isUnlimited: unlimited,
    canUseInterpreter: unlimited || activeSubscription || (!expired && dateValue(user.trialEndsAt) > now),
    paymentProvider: user.paymentProvider || "none",
    paymentReference: user.paymentReference || "",
    lastPaymentAt: user.lastPaymentAt || null,
    nextRenewalAt: user.nextRenewalAt || null
  };
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

export class PaymentProvider { async createPayment() { throw new Error("Payment provider is not configured."); } async verifyPayment() { throw new Error("Payment provider is not configured."); } }
export class SubscriptionRepository { constructor(UserModel) { this.User = UserModel; } findById(id) { return this.User.findById(id); } save(user) { return user.save(); } }
