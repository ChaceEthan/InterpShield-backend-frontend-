import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isTranslationDisplayable } from "../services/interpreter.js";
import { resolveLocalTranslation } from "../utils/translationEnhancer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interpreterSource = readFileSync(resolve(__dirname, "../services/interpreter.js"), "utf8");
const socketSource = readFileSync(resolve(__dirname, "../sockets/interpreterSocket.js"), "utf8");
const frontendSource = readFileSync(resolve(__dirname, "../../frontend/src/App.tsx"), "utf8");

const source = "Can you please give me your book?";

const rejectedTranslations = [
  ["source echo", source, "es"],
  ["source tag", "[EN] Can you please give me your book?", "es"],
  ["provider failure", "Translation unavailable", "es"],
  ["english paraphrase for spanish", "Please give me your book.", "es"],
  ["english sentence for chinese", "Can you give me your book?", "zh"],
  ["english sentence for kinyarwanda", "Can you give me your book?", "rw"],
  ["english sentence for kirundi", "Can you give me your book?", "rn"],
  ["english sentence for swahili", "Can you give me your book?", "sw"],
  ["english sentence for luganda", "Can you give me your book?", "luganda"]
];

const acceptedTranslations = [
  ["spanish", "Me puedes dar tu libro?", "es"],
  ["short spanish", "Claro.", "es"],
  ["chinese", "请把你的书给我。", "zh"],
  ["kinyarwanda", "Urashobora kumpa igitabo cyawe?", "rw"],
  ["kirundi", "Urashobora kumpa igitabu cawe?", "rn"],
  ["swahili", "Unaweza kunipa kitabu chako?", "sw"],
  ["luganda", "Osobola okumpa ekitabo kyo?", "luganda"],
  ["long swahili", "Ninahitaji msaada wako sasa kwa sababu kazi hii ni muhimu.", "sw"],
  ["long kinyarwanda", "Ndashobora kugufasha ubu kuko iki gikorwa ni ingenzi.", "rw"],
  ["long kirundi", "Ndashobora kugufasha ubu kuko iki gikorwa ni ngirakamaro.", "rn"],
  ["long luganda", "Nsobola okukuyamba kati kubanga omulimu guno mukulu.", "luganda"]
];

for (const [name, text, targetLang] of rejectedTranslations) {
  assert.equal(
    isTranslationDisplayable({ text, sourceText: source, sourceLang: "en", targetLang, provider: "test" }),
    false,
    `${name} should be rejected for ${targetLang}`
  );
}

for (const [name, text, targetLang] of acceptedTranslations) {
  assert.equal(
    isTranslationDisplayable({ text, sourceText: source, sourceLang: "en", targetLang, provider: "test" }),
    true,
    `${name} should be accepted for ${targetLang}`
  );
}

assert.match(interpreterSource, /FAST_LOCAL_LANGUAGE_CODES\s*=\s*new Set\(\["rw",\s*"rn",\s*"sw",\s*"luganda"\]\)/);
assert.match(interpreterSource, /normalized === "lg".*return "luganda"/s);
assert.match(interpreterSource, /TRANSLATION_STARTED/);
assert.match(interpreterSource, /TRANSLATION_PROVIDER/);
assert.match(interpreterSource, /TRANSLATION_SUCCESS/);
assert.match(interpreterSource, /TRANSLATION_FAILED/);
assert.doesNotMatch(interpreterSource, /sourceLanguageFallbackText|provider:\s*"source"|\[[Ee][Nn]\]/);
assert.match(socketSource, /isTranslationDisplayable/);
assert.match(socketSource, /SOCKET_TRANSLATION_EMIT/);
assert.match(socketSource, /translation_result/);
assert.match(socketSource, /translated_text/);
assert.match(frontendSource, /FRONTEND_TRANSLATION_RECEIVED/);
assert.match(frontendSource, /translation_result/);
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "es" }), "Me puedes dar tu libro, por favor");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "zh" }), "请把你的书给我");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "rw" }), "urashobora kumpa igitabo cyawe");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "rn" }), "urashobora kumpa igitabu cawe");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "sw" }), "unaweza kunipa kitabu chako");
assert.equal(resolveLocalTranslation({ text: "Urashobora kumpa igitabo cyawe?", sourceLang: "rw", targetLang: "en" }), "can you give me your book");
assert.equal(resolveLocalTranslation({ text: "Unaweza kunipa kitabu chako?", sourceLang: "sw", targetLang: "en" }), "can you give me your book");
