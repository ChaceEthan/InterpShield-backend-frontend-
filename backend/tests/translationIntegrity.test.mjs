import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isTranslationDisplayable } from "../services/interpreter.js";
import { resolveLocalTranslation } from "../utils/translationEnhancer.js";
import { createAudioPipelineSession, upsertCallRoomParticipant, removeCallRoomParticipant } from "../services/audioPipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interpreterSource = readFileSync(resolve(__dirname, "../services/interpreter.js"), "utf8");
const socketSource = readFileSync(resolve(__dirname, "../sockets/interpreterSocket.js"), "utf8");
const frontendSource = readFileSync(resolve(__dirname, "../../frontend/src/App.tsx"), "utf8");

const source = "Can you please give me your book?";

const rejectedTranslations = [
  ["source echo", source, "es"],
  ["source tag", "[EN] Can you please give me your book?", "es"],
  ["provider failure", "Translation unavailable", "es"],
  ["kinyarwanda target", "Urashobora kumpa igitabo cyawe?", "rw"],
  ["kirundi target", "Urashobora kumpa igitabu cawe?", "rn"],
  ["luganda target", "Osobola okumpa ekitabo kyo?", "luganda"]
];

const acceptedTranslations = [
  ["english paraphrase from provider", "Please give me your book.", "es"],
  ["spanish", "Me puedes dar tu libro?", "es"],
  ["short spanish", "Claro.", "es"],
  ["chinese", "请把你的书给我。", "zh"],
  ["japanese", "こんにちは", "ja"],
  ["swahili", "Unaweza kunipa kitabu chako?", "sw"],
  ["long swahili", "Ninahitaji msaada wako sasa kwa sababu kazi hii ni muhimu.", "sw"]
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

assert.match(interpreterSource, /SUPPORTED_LANGUAGE_CODES\s*=\s*new Set\(\["en",\s*"fr",\s*"es",\s*"de",\s*"it",\s*"pt",\s*"nl",\s*"ar",\s*"zh",\s*"ja",\s*"ko",\s*"hi",\s*"tr",\s*"pl",\s*"ru",\s*"sw"\]\)/);
assert.match(interpreterSource, /FORBIDDEN_LANGUAGE_CODES\s*=\s*new Set\(\["rw",\s*"rn",\s*"lg",\s*"lug",\s*"luganda",\s*"ug",\s*"lg-ug"\]\)/);
assert.match(interpreterSource, /FAST_LOCAL_LANGUAGE_CODES\s*=\s*new Set\(\["sw"\]\)/);
assert.match(interpreterSource, /sessionTranslationQueue\s*=\s*{\s*queue:\s*\[\],\s*processing:\s*false,\s*activeJob:\s*null,\s*currentAbortController:\s*null,\s*sequence:\s*0\s*}/s);
assert.match(interpreterSource, /translationMutex\.acquire\(sessionId\)/);
assert.match(interpreterSource, /QUEUE_ADD/);
assert.match(interpreterSource, /QUEUE_CLEAR/);
assert.match(interpreterSource, /JOB_CANCEL/);
assert.match(interpreterSource, /JOB_START/);
assert.match(interpreterSource, /LANGUAGE_START/);
assert.match(interpreterSource, /LANGUAGE_SUCCESS/);
assert.match(interpreterSource, /LANGUAGE_FAILED/);
assert.match(interpreterSource, /LANGUAGE_EMIT/);
assert.match(interpreterSource, /QUEUE_NEXT/);
assert.match(interpreterSource, /createTranslationPayloadMetadata/);
assert.match(interpreterSource, /sequence:\s*stableSequence\s*\|\|\s*translationEmitSequence/);
assert.match(interpreterSource, /const providerOrder\s*=\s*\[/);
assert.match(interpreterSource, /PROVIDER_MAX_ACTIVE_TRANSLATIONS\s*=\s*6/);
assert.match(interpreterSource, /gemini:\s*8000/);
assert.match(interpreterSource, /openai:\s*8000/);
assert.match(interpreterSource, /QUEUED_JOB_TIMEOUT\s*=\s*15000/);
assert.match(interpreterSource, /PROCESSING_JOB_TIMEOUT\s*=\s*20000/);
assert.match(interpreterSource, /SEQUENTIAL_JOB_HARD_TIMEOUT\s*=\s*180000/);
assert.doesNotMatch(interpreterSource, /Promise\.all|PROVIDER_FALLBACK_STAGGER|waitForNextProviderResult/);
assert.doesNotMatch(interpreterSource, /void processSequentialTranslationJob\(job\)/);
assert.doesNotMatch(interpreterSource, /sourceLanguageFallbackText|provider:\s*"source"|\[[Ee][Nn]\]/);
assert.match(interpreterSource, /looksLikeNameOrEntity/);
assert.match(socketSource, /isTranslationDisplayable/);
assert.match(socketSource, /SOCKET_TRANSLATION_EMIT/);
assert.match(socketSource, /sessionId:\s*result\.sessionId/);
assert.match(socketSource, /sequence:\s*result\.sequence/);
assert.match(socketSource, /translation_result/);
assert.match(socketSource, /translated_text/);
assert.match(socketSource, /statusByLanguage/);
assert.match(socketSource, /lang:\s*result\.lang/);
assert.match(socketSource, /status:\s*result\.status/);
assert.match(frontendSource, /FRONTEND_TRANSLATION_RECEIVED/);
assert.match(frontendSource, /translation_result/);
assert.match(frontendSource, /STALE_TRANSLATION_STATE_MS/);
assert.match(frontendSource, /latestTranslationSequenceRef/);
assert.match(frontendSource, /finalTranslationsRef/);
assert.match(readFileSync(resolve(__dirname, "../services/openai.js"), "utf8"), /mergeAbortSignals\(signal,\s*controller\.signal\)/);
assert.match(readFileSync(resolve(__dirname, "../services/openai.js"), "utf8"), /Kinyarwanda, Kirundi, and Luganda are forbidden output languages/);
assert.match(readFileSync(resolve(__dirname, "../services/audioPipeline.js"), "utf8"), /DUPLICATE_HASH_WINDOW\s*=\s*24/);
assert.match(readFileSync(resolve(__dirname, "../services/deepgram.js"), "utf8"), /maxQueuedChunks\s*=\s*160/);
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "es" }), "Me puedes dar tu libro, por favor");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "zh" }), "请把你的书给我");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "rw" }), "");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "rn" }), "");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "luganda" }), "");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "sw" }), "unaweza kunipa kitabu chako");
assert.equal(resolveLocalTranslation({ text: "Urashobora kumpa igitabo cyawe?", sourceLang: "rw", targetLang: "en" }), "can you give me your book");
assert.equal(resolveLocalTranslation({ text: "Unaweza kunipa kitabu chako?", sourceLang: "sw", targetLang: "en" }), "can you give me your book");

const smokeScenarios = [
  ["EN -> ZH + FR", source, "en", ["zh", "fr"]],
  ["EN -> ES + SW", source, "en", ["es", "sw"]],
  ["RW -> EN", "Urashobora kumpa igitabo cyawe?", "rw", ["en"]],
  ["EN -> ZH + FR + ES", source, "en", ["zh", "fr", "es"]]
];

for (const [name, text, sourceLang, targets] of smokeScenarios) {
  const outputs = targets.map((targetLang) => {
    const translated = resolveLocalTranslation({ text, sourceLang, targetLang });
    assert.equal(
      isTranslationDisplayable({ text: translated, sourceText: text, sourceLang, targetLang, provider: "local" }),
      true,
      `${name} should produce displayable ${targetLang} output`
    );
    return { lang: targetLang, text: translated };
  });
  assert.equal(outputs.length, targets.length, `${name} should keep every requested target language isolated`);
}

const audioPipeline = createAudioPipelineSession({
  sessionId: "test-session",
  roomId: "test-room",
  participantId: "participant-1",
  sourceLang: "en",
  targetLanguages: ["es", "sw"]
});
const acceptedAudio = audioPipeline.preprocessAudioChunk(Buffer.alloc(512, 7), { sequence: 1, audioLevel: 0.02 });
assert.equal(acceptedAudio.accepted, true);
const droppedAudio = audioPipeline.preprocessAudioChunk(Buffer.alloc(8), { sequence: 2, audioLevel: 0 });
assert.equal(droppedAudio.accepted, false);
const speechRoutes = audioPipeline.queueTranslatedSpeech({
  original: source,
  sourceLang: "en",
  targetLanguages: ["es"],
  translations: { es: "Me puedes dar tu libro, por favor" }
});
assert.equal(speechRoutes.length, 1);
assert.equal(speechRoutes[0].targetLang, "es");

const rooms = new Map();
const room = upsertCallRoomParticipant(rooms, {
  roomId: "call-1",
  participantId: "participant-1",
  socketId: "socket-1",
  sourceLang: "en",
  targetLanguages: ["sw"]
});
assert.equal(room.participants.size, 1);
removeCallRoomParticipant(rooms, "call-1", "participant-1");
assert.equal(rooms.size, 0);
