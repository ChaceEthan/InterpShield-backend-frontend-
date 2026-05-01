// @ts-nocheck
import { GoogleGenAI } from "@google/genai";

let client = null;
let activeKey = null;

const placeholderApiKeys = new Set(["", "null", "undefined", "your_gemini_api_key", "YOUR_GEMINI_API_KEY_HERE"]);

const readGeminiKey = (value) => {
  const trimmed = value?.trim() || "";
  const unquoted = trimmed.match(/^(['"])(.*)\1$/)?.[2] || trimmed;
  return placeholderApiKeys.has(unquoted) ? "" : unquoted;
};

export const demoTranslate = (text, targetLang = "es") => {
  const cleanText = text?.trim() || "Hello";

  if (cleanText.toLowerCase() === "hello" && targetLang === "es") {
    return "Hola (demo)";
  }

  return `${cleanText} (${targetLang} demo)`;
};

export const translateWithGemini = async ({ text, sourceLang, targetLang }) => {
  const cleanText = text?.trim();
  const apiKey = readGeminiKey(process.env.GEMINI_API_KEY);

  if (!cleanText) {
    return "";
  }

  if (!apiKey) {
    return demoTranslate(cleanText, targetLang);
  }

  if (!client || activeKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    activeKey = apiKey;
  }

  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "You are a professional real-time interpreter.",
                `Translate from ${sourceLang || "auto"} to ${targetLang}.`,
                "Preserve tone, intent, names, and numbers.",
                "Return only the translated text. No commentary.",
                "",
                cleanText
              ].join("\n")
            }
          ]
        }
      ],
      config: {
        temperature: 0.2,
        maxOutputTokens: 512
      }
    });

    return response.text?.trim() || demoTranslate(cleanText, targetLang);
  } catch {
    return demoTranslate(cleanText, targetLang);
  }
};
