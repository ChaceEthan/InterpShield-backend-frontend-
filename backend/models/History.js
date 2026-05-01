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
    originalText: {
      type: String,
      default: ""
    },
    translatedText: {
      type: String,
      default: ""
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
