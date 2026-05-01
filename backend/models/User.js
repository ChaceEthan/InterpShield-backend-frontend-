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
    plan: {
      type: String,
      enum: ["free", "pro"],
      default: "free"
    },
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ ...defaultSettings })
    },
    upgradedAt: Date
  },
  {
    timestamps: true
  }
);

const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;
