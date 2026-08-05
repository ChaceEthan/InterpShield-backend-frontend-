import mongoose from "mongoose";

const defaultSettings = {
  privateMode: true,
  shareableMode: false,
  preferredSourceLang: "en",
  preferredTargetLang: "es",
  saveTranscript: true,
  saveAudio: false,
  speakerDetection: true,
  autoStopOnSilence: true,
  silenceDuration: 30,
  censorProfanity: false,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  microphoneId: "default",
  summaryLength: "standard",
  summaryLanguage: "en",
  sceneDetection: false,
  actionItemExtraction: true,
  perSpeakerSummary: false,
  sentimentTracking: false,
  keywordsExtraction: true
};

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    password: {
      type: String,
      default: "",
      select: false
    },
    googleId: {
      type: String,
      index: true,
      sparse: true
    },
    avatar: {
      type: String,
      default: ""
    },
    picture: {
      type: String,
      default: ""
    },
    provider: {
      type: String,
      default: "password"
    },
    role: {
      type: String,
      enum: ["user", "admin", "super_admin"],
      default: "user",
      index: true
    },
    status: {
      type: String,
      enum: ["active", "suspended", "deactivated"],
      default: "active",
      index: true
    },
    planOverride: {
      type: String,
      enum: ["free", "starter", "pro", "unlimited"],
      default: undefined
    },
    accessOverrideEndsAt: Date,
    suspendedAt: Date,
    suspendedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    suspensionReason: { type: String, default: "", maxlength: 500 },
    deactivatedAt: Date,
    lastActiveAt: Date,
    lastLoginAt: Date,
    mustChangePassword: { type: Boolean, default: false },
    plan: {
      type: String,
      enum: ["free", "pro_lite", "creator", "business", "team"],
      default: "free"
    },
    credits: {
      type: Number,
      default: 0,
      min: 0
    },
    totalCreditsEarned: {
      type: Number,
      default: 0,
      min: 0
    },
    totalCreditsSpent: {
      type: Number,
      default: 0,
      min: 0
    },
    dailyUsageMinutes: {
      type: Number,
      default: 0,
      min: 0
    },
    dailyUsageResetAt: {
      type: Date,
      default: () => new Date()
    },
    totalUsageMinutes: {
      type: Number,
      default: 0,
      min: 0
    },
    totalCaptionMinutes: { type: Number, default: 0, min: 0 },
    totalTranslationMinutes: { type: Number, default: 0, min: 0 },
    totalDubbingJobs: { type: Number, default: 0, min: 0 },
    sessionCount: { type: Number, default: 0, min: 0 },
    translationRequestsThisMonth: {
      type: Number,
      default: 0,
      min: 0
    },
    lastSessionLanguages: [String],
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ ...defaultSettings })
    },
    upgradedAt: Date,
    subscriptionStartedAt: Date,
    subscriptionEndsAt: Date
  },
  {
    timestamps: true
  }
);

const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;
