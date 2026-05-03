import { createDeepgramSession } from "./deepgram.js";
import { translateWithGemini } from "./gemini.js";

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
  void twoWay;
  return { source: detectedLanguage || sourceLang, target: targetLang };
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

  const session = createDeepgramSession({
    apiKey: env.deepgramApiKey,
    sourceLang,
    onOpen: onReady,
    onError: (message) => {
      if (/closed unexpectedly/i.test(message || "")) {
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
      const translatedText = shouldTranslate
        ? await translateWithGemini({
            apiKey: env.geminiApiKey,
            text: translationInput,
            sourceLang: direction.source,
            targetLang: direction.target
          })
        : "";

      onResult?.({
        originalText: displayText,
        translatedText,
        isFinal: true,
        sourceLang: direction.source,
        targetLang: direction.target,
        detectedLanguage,
        latencyMs: Date.now() - startedAt,
        mode: "production"
      });
    }
  });

  await session.start();
  return session;
};
