import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema({
  adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  action: { type: String, required: true, trim: true, maxlength: 100, index: true },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  reason: { type: String, default: "", trim: true, maxlength: 500 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  ipHash: { type: String, default: "", select: false }
}, { timestamps: true, versionKey: false });

/** @type {mongoose.Model<any>} */
const AuditLog = mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);

export default AuditLog;
