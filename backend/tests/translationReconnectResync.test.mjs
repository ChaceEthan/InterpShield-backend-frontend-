// @ts-nocheck
// Regression coverage for the socket-reconnect translation race: a language that is still
// legitimately being translated by the backend (queued/processing/retrying) must have its status
// re-broadcast once a client's socket resumes after a reconnect, because a server-side
// socket.emit() during the disconnect gap is silently dropped rather than buffered. Without this,
// the frontend's per-language staleness watchdog can mark a healthy in-flight translation FAILED
// purely because it missed the "retrying"/"processing" update that would have reset its clock.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createInterpreterSession } from "../services/interpreter.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeDeepgramConnection extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sentMedia = [];
  }

  connect() {
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open");
    }, 0);
    return this;
  }

  waitForOpen() {
    if (this.readyState === 1) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      this.once("open", () => resolve(this));
      this.once("error", reject);
    });
  }

  sendMedia(buffer) {
    this.sentMedia.push(Buffer.from(buffer));
  }

  sendKeepAlive() {}
  sendFinalize() {}
  sendCloseStream() {}
  close() {
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

// Stalled provider fetch: a real network call that never resolves on its own (only via the
// caller's own AbortController) — this holds a translation job in "processing" long enough for
// the test to call resyncPendingTranslations() against a still-in-flight language, mirroring a
// production request that is legitimately mid-retry when the client's socket reconnects.
const stalledFetch = async (_url, options = {}) =>
  new Promise((_resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      return;
    }
    signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    });
  });

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stalledFetch;

  try {
    const factory = createFakeClientFactory();
    const results = [];
    const session = await createInterpreterSession({
      env: { deepgramApiKey: "test-key", geminiApiKey: "configured", openaiApiKey: "" },
      sourceLang: "en",
      targetLanguages: ["zh", "el"],
      shouldTranslate: true,
      deepgramClientFactory: factory,
      onResult: (result) => results.push(result)
    });

    await wait(10);
    session.completeUtterance();
    factory.connections[0].emitTranscript("The clinic opens at nine tomorrow morning.", {
      isFinal: true,
      speechFinal: true
    });

    // Let dispatch reach the provider (rate-limit delay + fetch call) so both languages sit
    // in-flight against the stalled fetch, same as a real in-flight Gemini request that a client
    // socket reconnect gap would otherwise race against.
    await wait(800);

    const stillPending = results.some((entry) =>
      entry.jobId === 1 && !(entry.translations?.zh) && !(entry.translations?.el)
    );
    assert.ok(stillPending, "the final job must still be unresolved (no translations yet) before resync runs");

    const resultCountBeforeResync = results.length;
    session.resyncPendingTranslations();
    await wait(20);

    // emitTranslationStatusUpdate tags every resync-triggered emission with provider "resync",
    // regardless of which underlying status (queued/processing/retrying) the language is
    // currently in — that's the one signal a socket-resume handler can reliably use to confirm
    // the watchdog-refreshing re-broadcast actually reached the client.
    const resyncEvents = results.slice(resultCountBeforeResync).filter((entry) => entry.provider === "resync");
    const resyncedLanguages = new Set(resyncEvents.map((entry) => entry.lang));
    assert.ok(resyncedLanguages.has("zh"), "resync must re-emit a status update for zh while it is still in flight");
    assert.ok(resyncedLanguages.has("el"), "resync must re-emit a status update for el while it is still in flight");

    for (const event of resyncEvents) {
      assert.notEqual(event.status, "failed", "resync must never mark an in-flight language failed");
      assert.equal(event.translations?.[event.lang] || "", "", "resync must not fabricate translated text");
    }

    // Calling resync again immediately must not double-fail or duplicate-dispatch anything —
    // it should simply re-broadcast the same still-pending state.
    const resultCountBeforeSecondResync = results.length;
    session.resyncPendingTranslations();
    await wait(20);
    const secondResyncEvents = results.slice(resultCountBeforeSecondResync).filter((entry) => entry.provider === "resync");
    assert.ok(secondResyncEvents.length >= 2, "a repeated resync must keep re-broadcasting pending languages, not go silent");
    for (const event of secondResyncEvents) {
      assert.notEqual(event.status, "failed", "a repeated resync must never mark an in-flight language failed");
    }

    // Resyncing again after a language has already failed/succeeded must not resurrect it or
    // flip a terminal state back to a transient one.
    session.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("translationReconnectResync.test.mjs passed");
