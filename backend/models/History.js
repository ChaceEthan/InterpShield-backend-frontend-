import mongoose from "mongoose";

const historySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    title: {
      type: String,
      default: "Live interpreter session",
      trim: true
    },
    sourceLang: {
      type: String,
      default: "en"
    },
    targetLang: {
      type: String,
      default: "es"
    },
    targetLanguages: {
      type: [String],
      default: undefined
    },
    originalText: {
      type: String,
      default: ""
    },
    translatedText: {
      type: String,
      default: ""
    },
    translations: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined
    },
    durationSeconds: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

const History = mongoose.models.History || mongoose.model("History", historySchema);

export default History;
