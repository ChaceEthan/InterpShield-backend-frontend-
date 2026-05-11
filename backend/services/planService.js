// Plan management service

import User from "../models/User.js";
import { getPlanDefinition, getDailyMinutesLimit, canUpgradeToPlan } from "../utils/monetizationUtils.js";

/**
 * Get user's current plan with full details
 */
export const getUserPlanDetails = async (userId) => {
  try {
    const user = await User.findById(userId).lean();
    if (!user) {
      throw new Error("User not found");
    }

    const planId = user.plan || "free";
    const planDef = getPlanDefinition(planId);

    return {
      planId,
      planName: planDef.name,
      price: planDef.price,
      dailyMinutesLimit: getDailyMinutesLimit(planId),
      features: planDef.features,
      currentUsage: {
        dailyMinutes: user.dailyUsageMinutes || 0,
        totalMinutes: user.totalUsageMinutes || 0,
        translationRequests: user.translationRequestsThisMonth || 0,
        credits: user.credits || 0
      },
      subscription: {
        startedAt: user.subscriptionStartedAt,
        endsAt: user.subscriptionEndsAt,
        isActive: isSubscriptionActive(user)
      }
    };
  } catch (error) {
    console.error("Error getting user plan details:", error);
    throw error;
  }
};

/**
 * Check if user's subscription is active
 */
export const isSubscriptionActive = (user = {}) => {
  if (user.plan === "free") return true; // Free tier always active

  if (!user.subscriptionEndsAt) return false;

  const endDate = new Date(user.subscriptionEndsAt);
  return endDate > new Date();
};

/**
 * Track session usage
 */
export const trackSessionUsage = async (userId, durationMinutes = 0) => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const now = new Date();
    const resetTime = new Date(user.dailyUsageResetAt || new Date());

    // Check if we need to reset daily usage
    if (now.toDateString() !== resetTime.toDateString()) {
      user.dailyUsageMinutes = 0;
      user.dailyUsageResetAt = now;
    }

    // Update usage
    user.dailyUsageMinutes = (user.dailyUsageMinutes || 0) + durationMinutes;
    user.totalUsageMinutes = (user.totalUsageMinutes || 0) + durationMinutes;
    user.lastSessionLanguages = []; // Will be set elsewhere

    await user.save();

    return {
      dailyUsageMinutes: user.dailyUsageMinutes,
      totalUsageMinutes: user.totalUsageMinutes
    };
  } catch (error) {
    console.error("Error tracking session usage:", error);
    throw error;
  }
};

/**
 * Track translation request
 */
export const trackTranslationRequest = async (userId) => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    user.translationRequestsThisMonth = (user.translationRequestsThisMonth || 0) + 1;

    // Reset monthly counter at start of new month
    const lastUpdate = user.updatedAt;
    const now = new Date();

    if (lastUpdate && lastUpdate.getMonth() !== now.getMonth()) {
      user.translationRequestsThisMonth = 1;
    }

    await user.save();

    return {
      translationRequestsThisMonth: user.translationRequestsThisMonth
    };
  } catch (error) {
    console.error("Error tracking translation request:", error);
    throw error;
  }
};

/**
 * Upgrade user to a new plan
 */
export const upgradeToPlan = async (userId, newPlanId = "pro_lite") => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const currentPlan = user.plan || "free";

    // Validate upgrade path
    if (!canUpgradeToPlan(currentPlan, newPlanId)) {
      throw new Error(`Cannot upgrade from ${currentPlan} to ${newPlanId}`);
    }

    const now = new Date();
    const oneMonthLater = new Date(now.setMonth(now.getMonth() + 1));

    user.plan = newPlanId;
    user.upgradedAt = new Date();
    user.subscriptionStartedAt = new Date();
    user.subscriptionEndsAt = oneMonthLater;

    // Grant credits on upgrade
    const creditBonus = getCreditBonusForPlan(newPlanId);
    if (creditBonus > 0) {
      user.credits = (user.credits || 0) + creditBonus;
      user.totalCreditsEarned = (user.totalCreditsEarned || 0) + creditBonus;
    }

    await user.save();

    return {
      success: true,
      previousPlan: currentPlan,
      newPlan: newPlanId,
      creditsGranted: creditBonus,
      subscriptionEndsAt: oneMonthLater
    };
  } catch (error) {
    console.error("Error upgrading plan:", error);
    throw error;
  }
};

/**
 * Downgrade or switch plan
 */
export const changePlan = async (userId, newPlanId = "free") => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const currentPlan = user.plan || "free";
    const oldPlan = currentPlan;

    if (newPlanId === currentPlan) {
      return {
        success: false,
        reason: "same_plan",
        currentPlan
      };
    }

    user.plan = newPlanId;

    // If downgrading to free, clear subscription dates
    if (newPlanId === "free") {
      user.subscriptionEndsAt = null;
    } else {
      const now = new Date();
      const oneMonthLater = new Date(now.setMonth(now.getMonth() + 1));
      user.subscriptionEndsAt = oneMonthLater;
    }

    await user.save();

    return {
      success: true,
      previousPlan: oldPlan,
      newPlan: newPlanId
    };
  } catch (error) {
    console.error("Error changing plan:", error);
    throw error;
  }
};

/**
 * Add credits to user account
 */
export const addUserCredits = async (userId, amount = 0, reason = "manual_addition") => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    if (amount <= 0) {
      throw new Error("Amount must be positive");
    }

    user.credits = (user.credits || 0) + amount;
    user.totalCreditsEarned = (user.totalCreditsEarned || 0) + amount;

    await user.save();

    return {
      success: true,
      newBalance: user.credits,
      amountAdded: amount,
      reason
    };
  } catch (error) {
    console.error("Error adding credits:", error);
    throw error;
  }
};

/**
 * Deduct credits from user account
 */
export const deductUserCredits = async (userId, amount = 0, reason = "feature_usage") => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    if (amount <= 0) {
      throw new Error("Amount must be positive");
    }

    const currentBalance = user.credits || 0;
    if (currentBalance < amount) {
      return {
        success: false,
        reason: "insufficient_credits",
        currentBalance,
        amountRequested: amount,
        shortfall: amount - currentBalance
      };
    }

    user.credits = currentBalance - amount;
    user.totalCreditsSpent = (user.totalCreditsSpent || 0) + amount;

    await user.save();

    return {
      success: true,
      previousBalance: currentBalance,
      newBalance: user.credits,
      amountDeducted: amount,
      reason
    };
  } catch (error) {
    console.error("Error deducting credits:", error);
    throw error;
  }
};

/**
 * Get credit bonus for upgrading to a plan
 */
const getCreditBonusForPlan = (planId = "free") => {
  const bonuses = {
    free: 0,
    pro_lite: 50,
    creator: 150,
    business: 500,
    team: 1000
  };

  return bonuses[planId] || 0;
};

/**
 * Reset daily usage stats
 */
export const resetDailyUsageStats = async (userId) => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    user.dailyUsageMinutes = 0;
    user.dailyUsageResetAt = new Date();

    await user.save();

    return {
      success: true,
      resetAt: user.dailyUsageResetAt
    };
  } catch (error) {
    console.error("Error resetting daily usage:", error);
    throw error;
  }
};

/**
 * Check and auto-reset daily stats if needed
 */
export const ensureDailyStatsValid = async (userId) => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const now = new Date();
    const resetTime = new Date(user.dailyUsageResetAt || new Date());

    if (now.toDateString() !== resetTime.toDateString()) {
      user.dailyUsageMinutes = 0;
      user.dailyUsageResetAt = now;
      await user.save();
    }

    return { valid: true, resetOccurred: now.toDateString() !== resetTime.toDateString() };
  } catch (error) {
    console.error("Error ensuring daily stats valid:", error);
    throw error;
  }
};
