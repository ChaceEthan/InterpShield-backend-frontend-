import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isTranslationDisplayable } from "../services/interpreter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interpreterSource = readFileSync(resolve(__dirname, "../services/interpreter.js"), "utf8");
const socketSource = readFileSync(resolve(__dirname, "../sockets/interpreterSocket.js"), "utf8");

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
assert.doesNotMatch(interpreterSource, /sourceLanguageFallbackText|provider:\s*"source"|\[[Ee][Nn]\]/);
assert.match(socketSource, /isTranslationDisplayable/);
