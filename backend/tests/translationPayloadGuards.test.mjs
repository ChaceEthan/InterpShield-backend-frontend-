// @ts-nocheck
import assert from "node:assert/strict";
import { hasMeaningfulTranslationPayload } from "../sockets/interpreterSocket.js";
import { shouldDegradeProviderHealth } from "../services/interpreter.js";

// Production evidence: [DESKTOP_PIPELINE_TRANSLATION_RESULT] { jobId: "preview-46", sequence: 46,
// status: undefined, languages: [], complete: false } — emitted through translation_update,
// translation_result, and translated_text as if it were a real user-facing translation, even
// though it carries no translated text, no per-language status, and no failure. That is internal
// lifecycle noise from a cancelled/stale preview, not translation output, and must never reach
// the socket.

// TEST 4 — the exact reproduced empty/cancelled preview payload must be suppressed.
{
  const emptyPreviewPayload = {
    sessionId: "session-1",
    jobId: "preview-46",
    sequence: 46,
    status: undefined,
    translations: {},
    statusByLanguage: {},
    failedLanguages: [],
    text: "",
    complete: false
  };
  assert.equal(
    hasMeaningfulTranslationPayload(emptyPreviewPayload),
    false,
    "a payload with no translations, no per-language status, no failures, no text, and no top-level status must be recognized as empty lifecycle noise"
  );
}

// A payload entirely missing the optional fields (undefined rather than empty objects/arrays)
// must be treated identically — the guard must not assume every field is always present.
{
  assert.equal(
    hasMeaningfulTranslationPayload({ sessionId: "session-1", jobId: "preview-47", sequence: 47, complete: false }),
    false,
    "a payload missing translations/statusByLanguage/failedLanguages/text/status entirely must also be recognized as empty"
  );
}

// TEST 4 (negative case) — a genuinely useful "processing" lifecycle signal (no translated text
// yet, but a real per-language status the frontend explicitly understands) must still be allowed
// through. Suppressing this would regress the live "Translating..." feedback shown while a
// provider-backed preview request is in flight.
{
  const processingPayload = {
    sessionId: "session-1",
    jobId: "preview-48",
    sequence: 48,
    translations: {},
    statusByLanguage: { fr: "processing", zh: "processing" },
    failedLanguages: [],
    text: "",
    complete: false
  };
  assert.equal(
    hasMeaningfulTranslationPayload(processingPayload),
    true,
    "a per-language 'processing' status is meaningful lifecycle content the frontend explicitly expects — it must not be suppressed"
  );
}

// A real, successful preview translation (actual translated text, no status map at all) must
// obviously still be emitted.
{
  const successfulPreviewPayload = {
    sessionId: "session-1",
    jobId: "preview-49-fr",
    sequence: 49,
    translations: { fr: "Bonjour tout le monde." },
    text: "Bonjour tout le monde.",
    status: "translated",
    lang: "fr",
    complete: false
  };
  assert.equal(
    hasMeaningfulTranslationPayload(successfulPreviewPayload),
    true,
    "a real translated preview must never be suppressed"
  );
}

// A genuine per-language failure (e.g. a FINAL request that ran out of retries) must still reach
// the frontend so the card can show FAILED — only content-less lifecycle noise is suppressed.
{
  const failedFinalPayload = {
    sessionId: "session-1",
    jobId: 12,
    sequence: 12,
    translations: {},
    statusByLanguage: {},
    failedLanguages: ["fr"],
    text: "",
    complete: true
  };
  assert.equal(
    hasMeaningfulTranslationPayload(failedFinalPayload),
    true,
    "a genuine terminal failure for a language must still be emitted so the UI can show FAILED — only truly empty payloads are suppressed"
  );
}

// TEST 5 — cross-language isolation at the classification layer: a French request that failed
// because it was intentionally aborted (cancelled preview, or a stale/superseded final attempt)
// must never influence whether Chinese's own, independent result is treated as healthy/degrading.
// shouldDegradeProviderHealth is evaluated per language/attempt with its own error, so proving
// French's intentional-abort error never degrades health, while Chinese's own success is
// evaluated completely independently, demonstrates the two can never cross-contaminate — matching
// the exact "Chinese DONE, French cancelled" production scenario end-to-end (interpreter.js
// dispatches each target language as an independent request/result, never a shared one).
{
  const frenchIntentionalAbortError = Object.assign(new Error("Gemini translation aborted"), {
    provider: "Gemini",
    errorCategory: "intentional_abort",
    intentionalAbort: true
  });
  assert.equal(
    shouldDegradeProviderHealth({ error: frenchIntentionalAbortError, provider: "gemini", targetLang: "fr" }),
    false,
    "French's intentionally-aborted preview must not degrade provider health"
  );

  const chineseSuccessResult = {
    provider: "gemini",
    translatedText: "这是一个成功的中文翻译示例。",
    stale: false
  };
  assert.equal(
    shouldDegradeProviderHealth({
      result: chineseSuccessResult,
      sourceText: "This is a successful Chinese translation example.",
      sourceLang: "en",
      targetLang: "zh",
      provider: "gemini"
    }),
    false,
    "Chinese's own successful result is evaluated on its own merits — a displayable translation never degrades health, regardless of what happened to French"
  );
}

console.log("Translation payload guard regression tests passed.");
