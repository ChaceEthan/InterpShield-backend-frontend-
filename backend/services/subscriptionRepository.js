import PaymentHistory from "../models/PaymentHistory.js";
import User from "../models/User.js";
export class SubscriptionRepository {
  findUser(id) { return User.findById(id); }
  saveUser(user) { return user.save(); }
  listPaymentHistory(userId) { return PaymentHistory.find({ userId }).sort({ createdAt: -1 }).lean(); }
  createPaymentHistory(entry) { return PaymentHistory.create(entry); }
}
export default new SubscriptionRepository();
