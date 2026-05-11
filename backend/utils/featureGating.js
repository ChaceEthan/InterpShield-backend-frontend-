// Feature gating and access control

import { hasPlanFeature, getDailyMinutesLimit, calculateDailyUsagePercentage, hasEnoughCredits } from "./monetizationUtils.js";

/**
 * Check if user has access to a feature
 */
export const checkFeatureAccess = (user = {}, feature = "") => {
  if (!feature) return true;

  const planId = user.plan || "free";
  const hasFeature = hasPlanFeature(planId, feature);

  if (!hasFeature) {
    return {
      allowed: false,
      reason: "plan_does_not_include_feature",
      feature,
      plan: planId,
      requirementLevel: "subscription"
    };
  }

  return { allowed: true };
};

/**
 * Check if user has sufficient daily minutes
 */
export const checkMinuteAllowance = (user = {}, requestedMinutes = 0) => {
  const planId = user.plan || "free";
  const dailyLimit = getDailyMinutesLimit(planId);

  // Check if daily limit exists (unlimited plans don't have it)
  if (!dailyLimit) {
    return { allowed: true, minutesRemaining: Infinity };
  }

  // Reset daily usage if needed
  const resetTime = new Date(user.dailyUsageResetAt || new Date());
  const now = new Date();
  let dailyUsed = user.dailyUsageMinutes || 0;

  if (now.toDateString() !== resetTime.toDateString()) {
    dailyUsed = 0; // Reset has occurred
  }

  const minutesRemaining = Math.max(0, dailyLimit - dailyUsed);

  if (requestedMinutes > minutesRemaining) {
    return {
      allowed: false,
      reason: "daily_limit_exceeded",
      dailyLimit,
      minutesUsed: dailyUsed,
      minutesRemaining,
      minutesRequested: requestedMinutes,
      plan: planId
    };
  }

  return {
    allowed: true,
    minutesRemaining,
    dailyLimit,
    minutesUsed: dailyUsed
  };
};

/**
 * Check if user can perform an operation
 */
export const checkOperationAccess = (user = {}, operation = {}) => {
  const { type = "translation", feature = "", requestedMinutes = 0, requiredCredits = 0 } = operation;

  // Check feature access
  const featureCheck = checkFeatureAccess(user, feature || type);
  if (!featureCheck.allowed) {
    return featureCheck;
  }

  // Check minute allowance
  const minuteCheck = checkMinuteAllowance(user, requestedMinutes);
  if (!minuteCheck.allowed) {
    return minuteCheck;
  }

  // Check credits if required
  if (requiredCredits > 0) {
    const creditsCheck = checkCreditsAvailability(user, requiredCredits);
    if (!creditsCheck.allowed) {
      return creditsCheck;
    }
  }

  return { allowed: true };
};

/**
 * Check if user has enough credits
 */
export const checkCreditsAvailability = (user = {}, requiredCredits = 0) => {
  const userCredits = user.credits || 0;

  if (userCredits < requiredCredits) {
    return {
      allowed: false,
      reason: "insufficient_credits",
      required: requiredCredits,
      available: userCredits,
      shortfall: requiredCredits - userCredits
    };
  }

  return { allowed: true, creditsAvailable: userCredits };
};

/**
 * Deduct credits safely (transaction-like)
 */
export const deductCredits = (user = {}, amountToDeduct = 0) => {
  const userCredits = user.credits || 0;

  if (userCredits < amountToDeduct) {
    return {
      success: false,
      reason: "insufficient_credits",
      available: userCredits,
      requested: amountToDeduct,
      shortfall: amountToDeduct - userCredits
    };
  }

  const newBalance = userCredits - amountToDeduct;
  const totalSpent = (user.totalCreditsSpent || 0) + amountToDeduct;

  return {
    success: true,
    previousBalance: userCredits,
    amountDeducted: amountToDeduct,
    newBalance,
    totalSpent
  };
};

/**
 * Add credits
 */
export const addCredits = (user = {}, amountToAdd = 0, reason = "manual_addition") => {
  const userCredits = user.credits || 0;
  const newBalance = userCredits + amountToAdd;
  const totalEarned = (user.totalCreditsEarned || 0) + amountToAdd;

  return {
    success: true,
    previousBalance: userCredits,
    amountAdded: amountToAdd,
    newBalance,
    totalEarned,
    reason
  };
};

/**
 * Get user's access level for a feature (simplified)
 */
export const getFeatureAccessLevel = (user = {}, feature = "") => {
  const planId = user.plan || "free";

  if (!hasPlanFeature(planId, feature)) {
    return {
      level: "none",
      requiresUpgrade: true
    };
  }

  // Could be extended to check for priority/premium levels
  return {
    level: planId === "team" || planId === "business" ? "premium" : "standard",
    requiresUpgrade: false
  };
};

/**
 * Validate user can export
 */
export const canExport = (user = {}) => {
  const check = checkFeatureAccess(user, "exports");
  return check.allowed;
};

/**
 * Validate user can use dubbing
 */
export const canUseDubbing = (user = {}) => {
  const check = checkFeatureAccess(user, "dubbing");
  return check.allowed;
};

/**
 * Validate user can use multi-room calls
 */
export const canUseMultiRoomCalls = (user = {}) => {
  const check = checkFeatureAccess(user, "multiRoomCalls");
  return check.allowed;
};

/**
 * Get rate limiting tier for user
 */
export const getRateLimitTier = (user = {}) => {
  const planId = user.plan || "free";

  const tiers = {
    free: { requestsPerMinute: 10, requestsPerHour: 100 },
    pro_lite: { requestsPerMinute: 30, requestsPerHour: 300 },
    creator: { requestsPerMinute: 50, requestsPerHour: 500 },
    business: { requestsPerMinute: 100, requestsPerHour: 1000 },
    team: { requestsPerMinute: 200, requestsPerHour: 2000 }
  };

  return tiers[planId] || tiers.free;
};
