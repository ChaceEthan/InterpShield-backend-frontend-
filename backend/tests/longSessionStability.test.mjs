// @ts-nocheck
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createInterpreterSession } from "../services/interpreter.js";

// Reproduces the reported production symptom via the REAL production pipeline (fake Deepgram
// transport + fake Gemini HTTP responses, but the actual createInterpreterSession job queue,
// per-language dispatch lanes, provider-health tracking, and cleanup code): a short session works
// fine, but a long, continuously-busy session must not progressively accumulate stale translation
// work, must not let one language's exhausted failure for a single utterance poison Gemini health
// or a sibling language's translation, and must recover a language's translations on the very next
// utterance instead of staying stuck. This is the deterministic, fast (seconds, not 90 minutes)
// simulation required for the long-session stabilization fix.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeDeepgramConnection extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sentMedia = [];
    this.closed = false;
  }

  on(event, callback) {
    super.on(event, callback);
    return this;
  }

  connect() {
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.emit("open");
    }, 0);
    return this;
  }

  sendMedia(buffer) {
    this.sentMedia.push(Buffer.from(buffer));
  }

  sendKeepAlive() {}
  sendFinalize() {}
  sendCloseStream() {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  emitTranscript(text, { isFinal = true, speechFinal = isFinal, detectedLanguage = "en" } = {}) {
    this.emit("message", {
      type: "Results",
      is_final: isFinal,
      speech_final: speechFinal,
      detected_language: detectedLanguage,
      channel: { alternatives: [{ transcript: text, languages: [detectedLanguage] }] }
    });
  }
}

const createFakeClientFactory = () => {
  const connections = [];
  const factory = () => ({
    listen: {
      v1: {
        connect: async () => {
          const connection = new FakeDeepgramConnection();
          connections.push(connection);
          return connection;
        }
      }
    }
  });
  factory.connections = connections;
  return factory;
};

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const geminiSuccess = (text) => jsonResponse(200, { candidates: [{ content: { parts: [{ text }] } }] });
const geminiEmpty = () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: "" }] } }] });
const geminiOverloaded = () => jsonResponse(503, { error: { message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } });

const FRENCH_TRANSLATION = "Ceci est une traduction de test pour la stabilite d'une session longue.";
const CHINESE_TRANSLATION = "这是关于长时间会话稳定性的测试翻译内容。";

// Scripted responses are keyed by a marker unique to ONE utterance's own source text (embedded
// in the utterance sentence itself), not by a shared per-language call-order queue. A shared
// queue is not safe here: a final translation job's own request and a same-utterance streaming
// preview's request both exist independently (cancelActivePreviewForLanguage only aborts a
// preview whose AbortController has already been created — a preview still sitting inside its
// own pre-request rate-limit delay has no controller yet to abort, so it can keep running to
// completion, with its own bounded internal retry, fully independently of the final job). Rather
// than fight that inherent raciness, each scripted marker's response applies UNCONDITIONALLY to
// every matching call (preview or final, however many, in whatever order) for a bounded number of
// times, so the FINAL job's own up-to-3 internal attempts are deterministically guaranteed to see
// the scripted behavior regardless of what an incidental preview for the same utterance does.
const scriptedResponsesByMarker = new Map();
const callCounts = { fr: 0, zh: 0 };

const mockFetch = async (url, options = {}) => {
  const body = String(options.body || "");
  const language = body.includes("Translate to French (fr).") ? "fr" : body.includes("Translate to Chinese (zh).") ? "zh" : null;
  if (!language) return geminiSuccess("Fallback translation output for an unscripted target language.");

  callCounts[language] += 1;

  for (const [marker, scriptsByLanguage] of scriptedResponsesByMarker.entries()) {
    if (!body.includes(marker)) continue;
    const script = scriptsByLanguage[language];
    if (script && script.remaining > 0) {
      script.remaining -= 1;
      if (script.kind === "503") return geminiOverloaded();
      if (script.kind === "empty") return geminiEmpty();
    }
    break;
  }

  return geminiSuccess(language === "fr" ? FRENCH_TRANSLATION : CHINESE_TRANSLATION);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = mockFetch;

try {
  const factory = createFakeClientFactory();
  const results = [];
  const session = await createInterpreterSession({
    env: { deepgramApiKey: "test-key", geminiApiKey: "test-gemini-key", openaiApiKey: "" },
    sourceLang: "en",
    targetLanguages: ["fr", "zh"],
    shouldTranslate: true,
    deepgramClientFactory: factory,
    onResult: (result) => {
      if (result.isTranslationComplete) results.push(result);
    }
  });

  await wait(10);

  const N_UTTERANCES = 40;
  const TRANSIENT_RECOVERY_INDEX = 10; // French: one 503, recovered internally, must still succeed
  const HARD_FAIL_INDEX = 20; // French: exhausted (empty responses); Chinese must still succeed

  for (let index = 0; index < N_UTTERANCES; index += 1) {
    const marker = `utt-marker-${index}`;
    if (index === TRANSIENT_RECOVERY_INDEX) {
      scriptedResponsesByMarker.set(marker, { fr: { kind: "503", remaining: 1 } });
    }
    if (index === HARD_FAIL_INDEX) {
      scriptedResponsesByMarker.set(marker, { fr: { kind: "empty", remaining: Infinity } });
    }

    factory.connections[0].emitTranscript(
      `Utterance number ${index} exercising long running live interpretation stability today, marker ${marker}.`,
      { isFinal: true, speechFinal: true }
    );

    if (index === HARD_FAIL_INDEX) {
      // Both the final job's own bounded retries AND an incidental same-utterance preview's
      // bounded retries need to fully exhaust in real time (each up to 3 attempts with real
      // backoff) before this utterance's outcome is settled.
      await wait(12000);
      // The scripted failure is utterance-scoped: stop applying it once this utterance has had
      // its chance to fail, so it can never bleed into a later utterance that happens to share
      // provider capacity or a delayed retry still in flight.
      scriptedResponsesByMarker.delete(marker);
    } else if (index === TRANSIENT_RECOVERY_INDEX) {
      await wait(4000);
    } else {
      await wait(200);
    }
  }

  await wait(500);

  // --- Section 18/19-equivalent regression: the exact reported screenshot shape ---
  assert.equal(results.length, N_UTTERANCES, "every finalized utterance must reach a terminal translation result, none left hanging");

  const transientResult = results[TRANSIENT_RECOVERY_INDEX];
  assert.equal(
    transientResult.translations.fr,
    FRENCH_TRANSLATION,
    "a single transient Gemini 503 must be absorbed by bounded internal retry — French still succeeds for that utterance"
  );
  assert.equal(transientResult.translations.zh, CHINESE_TRANSLATION, "the sibling language is unaffected by the other language's transient retry");

  const hardFailResult = results[HARD_FAIL_INDEX];
  assert.ok(
    !hardFailResult.translations.fr,
    "French must NOT have text once its provider attempts are genuinely exhausted for this utterance"
  );
  assert.ok(
    hardFailResult.failedLanguages.includes("fr") || hardFailResult.translationStatus?.fr === "failed",
    "the exhausted language must be reported as a genuine terminal failure, not silently dropped"
  );
  assert.equal(
    hardFailResult.translations.zh,
    CHINESE_TRANSLATION,
    "Chinese succeeding for the SAME utterance must never be affected by French's exhausted failure — this is the exact 'DONE + Translation unavailable' cross-language contamination the fix targets"
  );

  const recoveryResult = results[HARD_FAIL_INDEX + 1];
  assert.equal(
    recoveryResult.translations.fr,
    FRENCH_TRANSLATION,
    "the VERY NEXT utterance's French translation must succeed again — one utterance's exhausted failure must never permanently poison the following utterance"
  );
  assert.equal(recoveryResult.translations.zh, CHINESE_TRANSLATION);

  // Every other (unscripted) utterance must have succeeded normally in both languages.
  const unaffectedIndexes = Array.from({ length: N_UTTERANCES }, (_, index) => index).filter(
    (index) => ![TRANSIENT_RECOVERY_INDEX, HARD_FAIL_INDEX].includes(index)
  );
  for (const index of unaffectedIndexes) {
    assert.equal(results[index].translations.fr, FRENCH_TRANSLATION, `utterance ${index} French must succeed under normal long-session load`);
    assert.equal(results[index].translations.zh, CHINESE_TRANSLATION, `utterance ${index} Chinese must succeed under normal long-session load`);
  }

  // --- Section 5/8/17-equivalent regression: bounded long-session resource usage ---
  const health = session.getTranslationHealth();
  assert.equal(health.queue.fifoQueuedJobs, 0, "no queued jobs must remain once every utterance has settled");
  assert.equal(health.queue.activeJobId, null, "no job may still be marked active once every utterance has settled");
  assert.ok(
    health.queue.trackedJobs <= 5,
    `translationJobs must be cleaned up as each utterance completes, not accumulate across ${N_UTTERANCES} utterances (was ${health.queue.trackedJobs})`
  );
  assert.ok(
    health.queue.staleJobs <= 5,
    `stale-job bookkeeping must stay near zero for a session where every utterance reached a real terminal outcome, not accumulate across ${N_UTTERANCES} utterances (was ${health.queue.staleJobs})`
  );
  for (const lane of health.lanes) {
    assert.equal(lane.queuedTasks, 0, `translation lane ${lane.id} must have no queued tasks once the session is idle`);
    assert.equal(lane.activeTasks, 0, `translation lane ${lane.id} must have no active tasks once the session is idle`);
  }

  // --- Section 14-equivalent regression: our own retry exhaustion for one utterance must not
  // permanently degrade provider health for the rest of the session.
  assert.equal(
    health.providers.gemini.available,
    true,
    "Gemini must still be available after the session — an exhausted per-utterance failure (providerRetryExhausted) must not be treated as a provider-health-degrading event"
  );

  session.stop();
  console.log(
    `Long-session stability simulation passed: ${N_UTTERANCES} sequential utterances, ${callCounts.fr} French + ${callCounts.zh} Chinese provider calls, trackedJobs=${health.queue.trackedJobs}, staleJobs=${health.queue.staleJobs}.`
  );
} finally {
  globalThis.fetch = originalFetch;
}
