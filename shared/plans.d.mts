export type PublicPlanId = "free" | "pro_lite" | "creator" | "business";
export interface PublicPlan {
  id: PublicPlanId;
  name: string;
  monthlyPrice: number;
  captionMinutes: number;
  translationMinutes: number;
  dubbing: "none" | "limited" | "standard" | "advanced";
  features: readonly string[];
}
export const YEARLY_DISCOUNT_RATE: number;
export const PLAN_CATALOG: Readonly<Record<PublicPlanId, PublicPlan>>;
export const PRICING_PLAN_IDS: readonly PublicPlanId[];
export function yearlyMonthlyPrice(monthlyPrice: number): number;
