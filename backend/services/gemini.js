// @ts-nocheck

const GEMINI_API_VERSION = "v1";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const placeholderApiKeys = new Set([
  "",
  "null",
  "undefined",
  "your_gemini_api_key",
  "demo_gemini_key_replace_me",
  "YOUR_GEMINI_API_KEY_HERE"
]);

const readGeminiKey = (value) => {
  const trimmed = value?.trim() || "";
  const unquoted = trimmed.match(/^(['"])(.*)\1$/)?.[2] || trimmed;
  return placeholderApiKeys.has(unquoted) ? "" : unquoted;
};

const getGeminiEndpoint = () => {
  const configuredModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const model = configuredModel.replace(/^models\//, "");
  return `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent`;
};

export const translateWithGemini = async ({ text, sourceLang, targetLang }) => {
  const cleanText = text?.trim();
  const apiKey = readGeminiKey(process.env.GEMINI_API_KEY);

  console.log("Gemini API key present:", Boolean(apiKey));

  if (!cleanText) {
    return "";
  }

  if (!apiKey) {
    const error = new Error("Missing Gemini API key");
    console.error("Gemini translation error:", error.message);
    throw error;
  }

  try {
    const geminiEndpoint = getGeminiEndpoint();
    console.log("Gemini endpoint:", geminiEndpoint);

    const response = await fetch(geminiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
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
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512
        }
      })
    });

    const rawBody = await response.text();
    let data = {};

    try {
      data = rawBody ? JSON.parse(rawBody) : {};
    } catch (parseError) {
      console.log("Gemini API response:", rawBody);
      throw new Error(`Gemini API returned invalid JSON: ${parseError?.message || parseError}`);
    }

    console.log("Gemini API response:", JSON.stringify(data));

    if (!response.ok) {
      throw new Error(data?.error?.message || `Gemini API request failed with status ${response.status}`);
    }

    const translatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!translatedText) {
      throw new Error("Gemini API response did not include candidates[0].content.parts[0].text");
    }

    return translatedText;
  } catch (error) {
    console.error("Gemini translation error:", error);
    throw error;
  }
};
