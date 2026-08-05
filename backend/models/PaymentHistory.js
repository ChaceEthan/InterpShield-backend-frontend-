import mongoose from "mongoose";
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  subscriptionType: { type: String, default: "none" }, provider: { type: String, default: "none" },
  status: { type: String, enum: ["pending", "completed", "failed", "cancelled", "refunded"], default: "pending" },
  amount: { type: Number, default: 0 }, currency: { type: String, default: "USD" },
  reference: String, transactionId: String, bankReference: String, accountReference: String,
  providerResponse: { type: mongoose.Schema.Types.Mixed, default: null }, paidAt: Date
}, { timestamps: true });
export default mongoose.models.PaymentHistory || mongoose.model("PaymentHistory", schema);
