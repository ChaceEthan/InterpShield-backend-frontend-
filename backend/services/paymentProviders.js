import { PaymentProvider } from "./subscriptionService.js";
export const FUTURE_PAYMENT_PROVIDERS = Object.freeze(["mtn_momo", "airtel_money", "stripe", "equity_bank", "flutterwave", "paypal"]);
export class UnconfiguredPaymentProvider extends PaymentProvider { constructor(name) { super(); this.name = name; } }
export const paymentProviders = new Map(FUTURE_PAYMENT_PROVIDERS.map((name) => [name, new UnconfiguredPaymentProvider(name)]));
