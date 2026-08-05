// Monetization and plan utilities

// Plan definitions with feature limits
export const PLAN_DEFINITIONS = {
  free: {
    name: "Free",
    price: 0,
    dailyMinutesLimit: 15,
    maxTargetLanguages: 2,
    features: {
      captions: true,
      basicTranslation: true,
      dubbing: false,
      exports: false,
      advancedTranslation: false,
      multiRoomCalls: false,
      savedHistory: false
    }
  },
  pro_lite: {
    name: "Pro Lite",
    price: 5,
    dailyMinutesLimit: 120,
    maxTargetLanguages: 3,
    features: {
      captions: true,
      basicTranslation: true,
      dubbing: false,
      exports: false,
      advancedTranslation: true,
      multiRoomCalls: false,
      savedHistory: true,
      priorityTranslation: true
    }
  },
  creator: {
    name: "Creator",
    price: 10,
    dailyMinutesLimit: 480,
    maxTargetLanguages: 3,
    features: {
      captions: true,
      basicTranslation: true,
      dubbing: true,
      exports: true,
      advancedTranslation: true,
      multiRoomCalls: false,
      savedHistory: true,
      priorityTranslation: true,
      premiumVoices: true
    }
  },
  business: {
    name: "Business",
    price: 20,
    dailyMinutesLimit: 1440,
    maxTargetLanguages: 3,
    features: {
      captions: true,
      basicTranslation: true,
      dubbing: true,
      exports: true,
      advancedTranslation: true,
      multiRoomCalls: true,
      savedHistory: true,
      priorityTranslation: true,
      premiumVoices: true,
      dedicatedSupport: true
    }
  },
  team: {
    name: "Team",
    price: 50,
    dailyMinutesLimit: null,
    maxTargetLanguages: 3,
    features: {
      captions: true,
      basicTranslation: true,
      dubbing: true,
      exports: true,
      advancedTranslation: true,
      multiRoomCalls: true,
      savedHistory: true,
      priorityTranslation: true,
      premiumVoices: true,
      dedicatedSupport: true,
      conferenceMode: true,
      adminTools: true,
      teamManagement: true
    }
  }
};

/**
 * Get plan definition by plan ID
 */
export const getPlanDefinition = (planId = "free") => {
  return PLAN_DEFINITIONS[planId] || PLAN_DEFINITIONS.free;
};

/**
 * Get daily minutes limit for a plan
 */
export const getDailyMinutesLimit = (planId = "free") => {
  const plan = getPlanDefinition(planId);
  return plan.dailyMinutesLimit || 15; // Default to 15 if not specified
};

/**
 * Get max target languages for a plan
 */
export const getMaxTargetLanguages = (planId = "free") => {
  const plan = getPlanDefinition(planId);
  return plan.maxTargetLanguages || 2;
};

/**
 * Check if plan has feature
 */
export const hasPlanFeature = (planId = "free", feature = "") => {
  const plan = getPlanDefinition(planId);
  return Boolean(plan.features?.[feature]);
};

/**
 * Calculate usage percentage for daily limit
 */
export const calculateDailyUsagePercentage = (minutesUsed = 0, planId = "free") => {
  const limit = getDailyMinutesLimit(planId);
  if (!limit) return 0; // Unlimited plan
  return Math.round((minutesUsed / limit) * 100);
};

/**
 * Check if user can make a translation request
 */
export const canMakeTranslationRequest = (user = {}) => {
  if (["admin", "super_admin"].includes(user.role) || (user.planOverride === "unlimited" && (!user.accessOverrideEndsAt || new Date(user.accessOverrideEndsAt) > new Date()))) return true;
  const planId = user.plan || "free";
  const plan = getPlanDefinition(planId);
  const dailyLimit = getDailyMinutesLimit(planId);

  // Unlimited plan
  if (!dailyLimit) return true;

  // Check daily usage
  const resetTime = new Date(user.dailyUsageResetAt || new Date());
  const now = new Date();
  
  // Reset daily usage if a day has passed
  if (now.toDateString() !== resetTime.toDateString()) {
    return true; // Will be reset on next usage
  }

  return (user.dailyUsageMinutes || 0) < dailyLimit;
};

/**
 * Calculate credit cost for a feature
 */
export const calculateFeatureCost = (feature = "translation", durationMinutes = 0) => {
  const costs = {
    translation: 0.5, // 0.5 credits per minute
    dubbing: 1.5, // 1.5 credits per minute
    export: 2, // 2 credits per export
    advancedTranslation: 1 // 1 credit per advanced request
  };

  const baseCost = costs[feature] || 0;
  if (feature === "translation" || feature === "dubbing") {
    return baseCost * durationMinutes;
  }

  return baseCost;
};

/**
 * Check if user has enough credits for operation
 */
export const hasEnoughCredits = (user = {}, requiredCredits = 0) => {
  return (user.credits || 0) >= requiredCredits;
};

/**
 * Format plan name for display
 */
export const formatPlanName = (planId = "free") => {
  const plan = getPlanDefinition(planId);
  return plan.name;
};

/**
 * Get all available plans sorted by price
 */
export const getAllPlans = () => {
  return Object.entries(PLAN_DEFINITIONS)
    .map(([id, definition]) => ({ id, ...definition }))
    .sort((a, b) => a.price - b.price);
};

/**
 * Validate plan transition (some plans might have restrictions)
 */
export const canUpgradeToPlan = (currentPlan = "free", targetPlan = "pro_lite") => {
  const planHierarchy = ["free", "pro_lite", "creator", "business", "team"];
  const currentIndex = planHierarchy.indexOf(currentPlan);
  const targetIndex = planHierarchy.indexOf(targetPlan);

  return targetIndex > currentIndex; // Can only upgrade to higher tier
};

/**
 * Get recommendations for user based on usage
 */
export const getUpgradeRecommendation = (user = {}) => {
  const planId = user.plan || "free";
  const dailyUsed = user.dailyUsageMinutes || 0;
  const dailyLimit = getDailyMinutesLimit(planId);

  if (!dailyLimit) return null; // Already unlimited

  const usagePercentage = calculateDailyUsagePercentage(dailyUsed, planId);

  if (usagePercentage >= 80) {
    // Find next plan with higher limit
    const planHierarchy = ["free", "pro_lite", "creator", "business", "team"];
    const currentIndex = planHierarchy.indexOf(planId);
    if (currentIndex < planHierarchy.length - 1) {
      const nextPlanId = planHierarchy[currentIndex + 1];
      const nextPlan = getPlanDefinition(nextPlanId);
      return {
        reason: "exceeding_daily_limit",
        currentPlan: planId,
        recommendedPlan: nextPlanId,
        additionalMinutes: nextPlan.dailyMinutesLimit - dailyLimit
      };
    }
  }

  return null;
};
