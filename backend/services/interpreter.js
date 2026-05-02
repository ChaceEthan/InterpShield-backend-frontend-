import { createDeepgramSession } from "./deepgram.js";
import { translateWithGemini } from "./gemini.js";

const DEMO_TRANSCRIPTS = ["Hello", "Welcome to InterpShield", "This is a real-time interpreter demo"];
const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|hmm+|you know|i mean)\b[,\s]*/gi;

const cleanTranscriptText = (text = "") => {
  return text
    .replace(FILLER_PATTERN, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?]){2,}/g, "$1")
    .trim();
};

const prepareTextForTranslation = (text = "") => {
  const cleanText = cleanTranscriptText(text);
  if (!cleanText) return "";
  return /[.!?]$/.test(cleanText) ? cleanText : `${cleanText}.`;
};

const normalizeTranscript = (text = "") => cleanTranscriptText(text).toLowerCase();

const resolveDirection = ({ sourceLang, targetLang, detectedLanguage, twoWay }) => {
  if (!twoWay || !detectedLanguage || sourceLang === "auto") {
    return { source: detectedLanguage || sourceLang, target: targetLang };
  }

  if (detectedLanguage === targetLang) {
    return { source: targetLang, target: sourceLang };
  }

  return { source: detectedLanguage || sourceLang, target: targetLang };
};

const createDemoInterpreter = ({ sourceLang, targetLang, shouldTranslate, twoWay, onReady, onWarning, onResult }) => {
  let chunkCount = 0;
  let phraseIndex = 0;

  onReady?.();
  onWarning?.("Deepgram key is missing. Demo mode is enabled.");

  return {
    sendAudio: () => {
      chunkCount += 1;

      if (chunkCount === 1) {
        onResult?.({
          originalText: "Hello...",
          translatedText: "",
          isFinal: false,
          sourceLang,
          targetLang,
          mode: "demo"
        });
        return;
      }

      const originalText = DEMO_TRANSCRIPTS[phraseIndex % DEMO_TRANSCRIPTS.length];
      phraseIndex += 1;
      const direction = resolveDirection({ sourceLang, targetLang, detectedLanguage: sourceLang, twoWay });

      onResult?.({
        originalText,
        translatedText: "",
        isFinal: true,
        sourceLang: direction.source,
        targetLang: direction.target,
        latencyMs: 80,
        mode: "demo"
      });
    },
    stop: () => undefined
  };
};

export const createInterpreterSession = async ({
  env,
  sourceLang,
  targetLang,
  shouldTranslate,
  twoWay,
  onReady,
  onWarning,
  onError,
  onResult,
  onClosed
}) => {
  let lastFinalTranscript = "";
  let lastInterimTranscript = "";

  if (!env.deepgramApiKey) {
    return createDemoInterpreter({ sourceLang, targetLang, shouldTranslate, twoWay, onReady, onWarning, onResult });
  }

  const session = createDeepgramSession({
    sourceLang,
    onOpen: onReady,
    onError: (message) => {
      if (/reconnecting/i.test(message || "")) {
        onWarning?.(message);
        return;
      }
      onError?.(message || "Deepgram streaming error.");
      onWarning?.("Deepgram streaming failed.");
    },
    onClose: onClosed,
    onTranscript: async ({ text, isFinal, detectedLanguage }) => {
      const direction = resolveDirection({ sourceLang, targetLang, detectedLanguage, twoWay });
      const displayText = cleanTranscriptText(text);
      const normalized = normalizeTranscript(displayText);

      if (!normalized) {
        return;
      }

      if (!isFinal) {
        if (normalized === lastInterimTranscript || normalized === lastFinalTranscript) {
          return;
        }

        lastInterimTranscript = normalized;
        onResult?.({
          originalText: displayText,
          translatedText: "",
          isFinal: false,
          sourceLang: direction.source,
          targetLang: direction.target,
          detectedLanguage
        });
        return;
      }

      if (normalized === lastFinalTranscript) {
        return;
      }
      lastFinalTranscript = normalized;
      lastInterimTranscript = "";

      const startedAt = Date.now();
      const translationInput = prepareTextForTranslation(displayText);
      let translatedText = "";

      if (shouldTranslate) {
        try {
          translatedText = await translateWithGemini({
            text: translationInput,
            sourceLang: direction.source,
            targetLang: direction.target
          });
        } catch (error) {
          console.error("Gemini translation failed:", error?.message || error);
          onError?.("Gemini translation failed. Check GEMINI_API_KEY and Gemini API access.");
        }
      }

      onResult?.({
        originalText: displayText,
        translatedText,
        isFinal: true,
        sourceLang: direction.source,
        targetLang: direction.target,
        detectedLanguage,
        latencyMs: Date.now() - startedAt,
        mode: env.geminiApiKey ? "production" : "demo"
      });
    }
  });

  await session.start();
  return session;
};
