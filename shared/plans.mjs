export const YEARLY_DISCOUNT_RATE = 0.2;

export const PLAN_CATALOG = Object.freeze({
  free: Object.freeze({
    id: "free", name: "Free", monthlyPrice: 0, captionMinutes: 10, translationMinutes: 3,
    dubbing: "none", features: ["10 caption minutes", "3 translation minutes", "No dubbing", "Session history", "Watermarked output", "AI summary off"]
  }),
  pro_lite: Object.freeze({
    id: "pro_lite", name: "Starter", monthlyPrice: 3, captionMinutes: 120, translationMinutes: 30,
    dubbing: "limited", features: ["120 caption minutes", "30 translation minutes", "Limited dubbing", "Transcript export", "Session history"]
  }),
  creator: Object.freeze({
    id: "creator", name: "Pro", monthlyPrice: 7, captionMinutes: 600, translationMinutes: 180,
    dubbing: "standard", features: ["600 caption minutes", "180 translation minutes", "Dubbing", "AI summary", "Transcript export", "Priority translation"]
  }),
  business: Object.freeze({
    id: "business", name: "Business", monthlyPrice: 15, captionMinutes: 1800, translationMinutes: 600,
    dubbing: "advanced", features: ["1800 caption minutes", "600 translation minutes", "Advanced dubbing", "AI summary", "Team or business usage", "Priority support"]
  })
});

export const PRICING_PLAN_IDS = Object.freeze(["free", "pro_lite", "creator", "business"]);
export const yearlyMonthlyPrice = (monthlyPrice) => Number((monthlyPrice * (1 - YEARLY_DISCOUNT_RATE)).toFixed(2));
