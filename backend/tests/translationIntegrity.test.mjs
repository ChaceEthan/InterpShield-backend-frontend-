import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildProviderExecutionOrder, createPerLanguageDispatchQueue, isTranslationDisplayable, runSequentialTasks, shouldDegradeProviderHealth } from "../services/interpreter.js";
import { resolveLocalTranslation } from "../utils/translationEnhancer.js";
import { createAudioPipelineSession, upsertCallRoomParticipant, removeCallRoomParticipant } from "../services/audioPipeline.js";
import {
  LANGUAGE_CATALOG,
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode
} from "../../shared/languages.mjs";
import { isNonRetryableProviderError, mergeAbortSignals, normalizeProviderText } from "../services/providerUtils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interpreterSource = readFileSync(resolve(__dirname, "../services/interpreter.js"), "utf8");
const socketSource = readFileSync(resolve(__dirname, "../sockets/interpreterSocket.js"), "utf8");
const frontendSource = readFileSync(resolve(__dirname, "../../frontend/src/App.tsx"), "utf8");

const source = "Can you please give me your book?";

const rejectedTranslations = [
  ["source echo", source, "es"],
  ["source tag", "[EN] Can you please give me your book?", "es"],
  ["provider failure", "Translation unavailable", "es"]
];

const acceptedTranslations = [
  ["english paraphrase from provider", "Please give me your book.", "es"],
  ["spanish", "Me puedes dar tu libro?", "es"],
  ["short spanish", "Claro.", "es"],
  ["chinese", "请把你的书给我。", "zh"],
  ["japanese", "こんにちは", "ja"],
  ["swahili", "Unaweza kunipa kitabu chako?", "sw"],
  ["long swahili", "Ninahitaji msaada wako sasa kwa sababu kazi hii ni muhimu.", "sw"],
  ["kinyarwanda", "urashobora kumpa igitabo cyawe", "rw"],
  ["kirundi", "urashobora kumpa igitabu cawe", "rn"],
  ["luganda", "osobola okumpa ekitabo kyo", "lg"]
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

const catalogCodes = LANGUAGE_CATALOG.map((language) => language.code);
for (const requiredLanguage of ["en", "es", "fr", "de", "it", "pt", "nl", "ar", "zh", "ja", "ko", "hi", "tr", "ru", "pl", "sw", "rw", "rn", "lg"]) {
  assert.ok(catalogCodes.includes(requiredLanguage), `${requiredLanguage} should be in the shared catalog`);
  assert.ok(SUPPORTED_LANGUAGE_CODES.has(requiredLanguage), `${requiredLanguage} should be supported everywhere`);
}
assert.equal(catalogCodes.length, new Set(catalogCodes).size, "language catalog codes should be unique");
assert.equal(normalizeLanguageCode("luganda"), "lg");
assert.equal(normalizeProviderText('  "Hola mundo"  '), "Hola mundo");
assert.equal(isNonRetryableProviderError({ status: 401, message: "unauthorized" }), true);
assert.equal(isNonRetryableProviderError({ message: "temporary network issue" }), false);
assert.equal(shouldDegradeProviderHealth({ result: { provider: "gemini", translatedText: "Please give me your book." }, sourceText: source, sourceLang: "en", targetLang: "es", provider: "gemini" }), false);
assert.equal(shouldDegradeProviderHealth({ result: { provider: "gemini", error: new Error("temporary network issue") }, sourceText: source, sourceLang: "en", targetLang: "es", provider: "gemini" }), true);
assert.equal(shouldDegradeProviderHealth({ result: { provider: "openai", error: new Error("OpenAI 401 unauthorized") }, sourceText: source, sourceLang: "en", targetLang: "es", provider: "openai" }), true);
const now = Date.now();
assert.deepEqual(
  buildProviderExecutionOrder({
    providerHealth: {
      gemini: { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 1000 },
      openai: { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 500 }
    },
    env: { geminiApiKey: "key", openaiApiKey: "key" },
    preferredProvider: "gemini",
    userPlan: "free",
    rotationOffset: 0
  }),
  ["gemini", "openai"]
);
assert.deepEqual(
  buildProviderExecutionOrder({
    providerHealth: {
      gemini: { failures: 5, cooldownUntil: now + 30000, lastSuccessAt: now - 5000 },
      openai: { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 1000 }
    },
    env: { geminiApiKey: "key", openaiApiKey: "key" },
    preferredProvider: "gemini",
    userPlan: "free",
    rotationOffset: 0
  }),
  ["openai", "gemini"]
);
assert.deepEqual(
  buildProviderExecutionOrder({
    providerHealth: {
      gemini: { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 1000 },
      openai: { failures: 0, cooldownUntil: 0, lastSuccessAt: now - 500 }
    },
    env: { geminiApiKey: "key", openaiApiKey: "key" },
    preferredProvider: "gemini",
    userPlan: "free",
    rotationOffset: 1
  }),
  ["openai", "gemini"]
);

let concurrentRuns = 0;
let maxConcurrentRuns = 0;
const sequentialResults = await runSequentialTasks(["es", "fr", "de"], async (language) => {
  concurrentRuns += 1;
  maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
  await Promise.resolve();
  concurrentRuns -= 1;
  return language.toUpperCase();
}, 3);
assert.deepEqual(sequentialResults, ["ES", "FR", "DE"]);
assert.equal(maxConcurrentRuns, 3, "target languages should be processed concurrently up to the configured limit");

const dispatchQueue = createPerLanguageDispatchQueue({
  languages: ["es", "fr", "de"],
  concurrency: 2,
  requestDelayMs: 0,
  worker: async (language) => {
    await Promise.resolve();
    return language.toUpperCase();
  }
});
const dispatchedResults = await dispatchQueue.run();
assert.deepEqual(dispatchedResults, ["ES", "FR", "DE"], "each target language should receive its own independent dispatch queue");

const controller = new AbortController();
const mergedSignal = mergeAbortSignals(controller.signal);
controller.abort();
assert.equal(mergedSignal.signal.aborted, true);
assert.match(interpreterSource, /shared\/languages\.mjs/);
assert.match(socketSource, /shared\/languages\.mjs/);
assert.match(frontendSource, /LANGUAGE_CATALOG/);
assert.match(interpreterSource, /FAST_LOCAL_LANGUAGE_CODES\s*=\s*new Set\(\["sw",\s*"rw",\s*"rn",\s*"lg"\]\)/);
assert.doesNotMatch(interpreterSource, /FORBIDDEN_LANGUAGE_CODES/);
assert.match(interpreterSource, /sessionTranslationQueue\s*=\s*{\s*queue:\s*\[\],\s*processing:\s*false,\s*activeJob:\s*null,\s*currentAbortController:\s*null,\s*sequence:\s*0\s*}/s);
assert.match(interpreterSource, /createPerLanguageDispatchQueue\(/);
assert.match(interpreterSource, /QUEUE_ADD/);
assert.match(interpreterSource, /QUEUE_CLEAR/);
assert.match(interpreterSource, /JOB_CANCEL/);
assert.match(interpreterSource, /JOB_START/);
assert.match(interpreterSource, /LANGUAGE_START/);
assert.match(interpreterSource, /LANGUAGE_SUCCESS/);
assert.match(interpreterSource, /LANGUAGE_FAILED/);
assert.match(interpreterSource, /LANGUAGE_EMIT/);
assert.match(interpreterSource, /QUEUE_NEXT/);
assert.match(interpreterSource, /PROVIDER_SELECTION/);
assert.match(interpreterSource, /TRANSLATION_REQUEST/);
assert.match(interpreterSource, /TRANSLATION_COMPLETE/);
assert.match(interpreterSource, /STREAMING_PREVIEW_REQUEST/);
assert.match(interpreterSource, /createTranslationPayloadMetadata/);
assert.match(interpreterSource, /sequence:\s*stableSequence\s*\|\|\s*translationEmitSequence/);
assert.match(interpreterSource, /const providerOrder\s*=\s*\[/);
assert.match(interpreterSource, /PROVIDER_MAX_ACTIVE_TRANSLATIONS\s*=\s*6/);
assert.match(interpreterSource, /gemini:\s*25000/);
assert.match(interpreterSource, /openai:\s*22000/);
assert.match(interpreterSource, /QUEUED_JOB_TIMEOUT\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
assert.match(interpreterSource, /PROCESSING_JOB_TIMEOUT\s*=\s*3\s*\*\s*60\s*\*\s*1000/);
assert.match(interpreterSource, /SEQUENTIAL_JOB_HARD_TIMEOUT\s*=\s*8\s*\*\s*60\s*\*\s*1000/);
assert.match(interpreterSource, /MAX_SESSION_TRANSLATION_QUEUE_SIZE\s*=\s*96/);
assert.doesNotMatch(interpreterSource, /clearPendingTranslationQueue\("newer_final_transcript",\s*job\)/);
assert.match(interpreterSource, /PROVIDER_HARD_FAILURE_COOLDOWN_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
assert.match(interpreterSource, /isProviderNonRetryableFailure/);
assert.match(interpreterSource, /isWaitingBehindActiveFifoJob/);
assert.doesNotMatch(interpreterSource, /PROVIDER_FALLBACK_STAGGER|waitForNextProviderResult/);
assert.doesNotMatch(interpreterSource, /void processSequentialTranslationJob\(job\)/);
assert.doesNotMatch(interpreterSource, /sourceLanguageFallbackText|provider:\s*"source"|\[[Ee][Nn]\]/);
assert.match(interpreterSource, /looksLikeNameOrEntity/);
assert.match(socketSource, /isTranslationDisplayable/);
assert.match(socketSource, /normalizeSharedLanguageCode/);
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
assert.match(frontendSource, /streamingPreview/);
assert.match(frontendSource, /latestTranslationSequenceRef\.current\s*=\s*transcriptSequence/);
assert.match(frontendSource, /finalTranslationsRef/);
assert.match(frontendSource, /pendingFinalTranscriptsRef/);
assert.match(frontendSource, /completedTranslationSignaturesRef/);
assert.match(frontendSource, /staleUpdates\[language\]\s*=\s*"stale"/);
assert.match(readFileSync(resolve(__dirname, "../services/openai.js"), "utf8"), /mergeAbortSignals\(signal,\s*controller\.signal\)/);
assert.doesNotMatch(readFileSync(resolve(__dirname, "../services/openai.js"), "utf8"), /forbidden output languages/);
assert.match(readFileSync(resolve(__dirname, "../services/gemini.js"), "utf8"), /createAbortPromise/);
assert.match(readFileSync(resolve(__dirname, "../services/gemini.js"), "utf8"), /clearTimeout\(timeout\)/);
assert.match(readFileSync(resolve(__dirname, "../services/audioPipeline.js"), "utf8"), /DUPLICATE_HASH_WINDOW\s*=\s*24/);
assert.match(readFileSync(resolve(__dirname, "../services/deepgram.js"), "utf8"), /MAX_QUEUED_CHUNKS\s*=\s*2400/);
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "es" }), "Me puedes dar tu libro, por favor");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "zh" }), "请把你的书给我");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "rw" }), "urashobora kumpa igitabo cyawe");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "rn" }), "urashobora kumpa igitabu cawe");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "lg" }), "osobola okumpa ekitabo kyo");
assert.equal(resolveLocalTranslation({ text: source, sourceLang: "en", targetLang: "sw" }), "unaweza kunipa kitabu chako");
assert.equal(resolveLocalTranslation({ text: "Urashobora kumpa igitabo cyawe?", sourceLang: "rw", targetLang: "en" }), "can you give me your book");
assert.equal(resolveLocalTranslation({ text: "Unaweza kunipa kitabu chako?", sourceLang: "sw", targetLang: "en" }), "can you give me your book");
assert.equal(resolveLocalTranslation({ text: "Hello everyone", sourceLang: "en", targetLang: "zh" }), "大家好");
assert.equal(resolveLocalTranslation({ text: "Hello everyone", sourceLang: "en", targetLang: "fr" }), "bonjour a tous");

const smokeScenarios = [
  ["EN -> ZH + FR", source, "en", ["zh", "fr"]],
  ["EN -> ES + SW", source, "en", ["es", "sw"]],
  ["RW -> EN", "Urashobora kumpa igitabo cyawe?", "rw", ["en"]],
  ["EN -> ZH + FR + ES", source, "en", ["zh", "fr", "es"]],
  ["EN -> RW + RN + LG", source, "en", ["rw", "rn", "lg"]]
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
