import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDeepgramSession } from "../services/deepgram.js";
import { buildProviderExecutionOrder, createInterpreterSession } from "../services/interpreter.js";
import { createAudioPipelineSession } from "../services/audioPipeline.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeDeepgramConnection extends EventEmitter {
  constructor({ failFirstSend = false } = {}) {
    super();
    this.readyState = 0;
    this.sentMedia = [];
    this.closed = false;
    this.connected = false;
    this.failFirstSend = failFirstSend;
  }

  on(event, callback) {
    super.on(event, callback);
    return this;
  }

  connect() {
    this.connected = true;
    setTimeout(() => {
      if (this.closed) return;
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
    if (this.readyState !== 1) throw new Error("Socket is not open.");
    if (this.failFirstSend) {
      this.failFirstSend = false;
      throw new Error("synthetic send failure");
    }
    this.sentMedia.push(Buffer.from(buffer));
  }

  sendKeepAlive() {}
  sendCloseStream() {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  emitTranscript(text, { isFinal = true, detectedLanguage = "en" } = {}) {
    this.emit("message", {
      type: "Results",
      is_final: isFinal,
      detected_language: detectedLanguage,
      channel: { alternatives: [{ transcript: text, languages: [detectedLanguage] }] }
    });
  }
}

const createFakeClientFactory = (options = {}) => {
  const connections = [];
  const factory = () => ({
    listen: {
      v1: {
        connect: async () => {
          const connection = new FakeDeepgramConnection(options.connectionOptions?.(connections.length) || {});
          connections.push(connection);
          return connection;
        }
      }
    }
  });
  factory.connections = connections;
  return factory;
};

{
  const pipeline = createAudioPipelineSession({ sessionId: "vad-silence-test" });
  const speech = pipeline.preprocessAudioChunk(Buffer.alloc(256, 23), { sequence: 1, audioLevel: 0.08, receivedAt: 1000 });
  assert.equal(speech.accepted, true, "spoken audio must be accepted even after client-side gating");
  pipeline.preprocessAudioChunk(Buffer.alloc(256, 0), { sequence: 2, audioLevel: 0.001, receivedAt: 1700 });
  pipeline.preprocessAudioChunk(Buffer.alloc(256, 0), { sequence: 3, audioLevel: 0.001, receivedAt: 2400 });
  const silentRun = pipeline.preprocessAudioChunk(Buffer.alloc(256, 0), { sequence: 4, audioLevel: 0.001, receivedAt: 3100 });
  assert.equal(silentRun.accepted, false, "long runs of silence must be rejected server-side");
  const resumedSpeech = pipeline.preprocessAudioChunk(Buffer.alloc(256, 41), { sequence: 5, audioLevel: 0.09, receivedAt: 3800 });
  assert.equal(resumedSpeech.accepted, true, "speech after silence must reset the gate and be accepted");
}

{
  const factory = createFakeClientFactory();
  const session = createDeepgramSession({ apiKey: "test-key", sourceLang: "en", clientFactory: factory });
  await session.start();
  await wait(10);
  session.sendAudio(Buffer.alloc(128, 31));
  session.completeUtterance();
  factory.connections[0].close();
  session.sendAudio(Buffer.alloc(128, 32));
  assert.equal(session.getHealth().queuedChunks, 1, "completed utterance overlap must not be queued for reconnect replay");
  await wait(650);
  assert.equal(factory.connections[1].sentMedia.length, 1, "only current-utterance audio should recover after reconnect");
  session.stop();
}

{
  const factory = createFakeClientFactory();
  const errors = [];
  const session = createDeepgramSession({
    apiKey: "test-key",
    sourceLang: "en",
    clientFactory: factory,
    onError: (message) => errors.push(message)
  });

  await session.start();
  await wait(10);
  session.sendAudio(Buffer.alloc(128, 1));
  assert.equal(factory.connections[0].sentMedia.length, 1, "first open stream should accept audio");

  await session.start({ reconnect: true });
  await wait(10);
  assert.equal(factory.connections.length, 2, "manual reconnect should create a replacement connection");
  assert.equal(session.getHealth().reconnects, 0, "closing the stale socket during start must not schedule another reconnect");
  assert.equal(errors.filter((message) => /stream_closed/.test(message)).length, 0, "stale close should not surface stream_closed warnings");
  session.stop();
}

{
  const factory = createFakeClientFactory();
  const session = createDeepgramSession({ apiKey: "test-key", sourceLang: "en", clientFactory: factory });
  await session.start();
  await wait(10);

  session.sendAudio(Buffer.alloc(128, 2));
  session.sendAudio(Buffer.alloc(128, 3));
  assert.equal(factory.connections[0].sentMedia.length, 2);

  factory.connections[0].close();
  session.sendAudio(Buffer.alloc(128, 4));
  session.sendAudio(Buffer.alloc(128, 5));
  assert.ok(session.getHealth().queuedChunks >= 4, "recent and new audio should be preserved while reconnecting");

  await wait(650);
  assert.equal(factory.connections.length, 2, "unexpected close should reconnect once");
  assert.equal(session.getHealth().queuedChunks, 0, "queued audio should flush after reconnect opens");
  assert.equal(factory.connections[1].sentMedia.length, 4, "recent audio plus queued audio should be replayed exactly once each");
  session.stop();
}

{
  const factory = createFakeClientFactory({
    connectionOptions: (index) => ({ failFirstSend: index === 1 })
  });
  const session = createDeepgramSession({ apiKey: "test-key", sourceLang: "en", clientFactory: factory });
  await session.start();
  await wait(10);
  session.sendAudio(Buffer.alloc(128, 6));
  factory.connections[0].close();
  await wait(650);
  assert.ok(session.getHealth().queuedChunks >= 1, "failed flush should roll the audio chunk back into the queue");
  await wait(650);
  assert.equal(session.getHealth().queuedChunks, 0, "rolled-back queued audio should flush on the next reconnect");
  session.stop();
}

{
  const factory = createFakeClientFactory();
  const session = createDeepgramSession({ apiKey: "test-key", sourceLang: "en", clientFactory: factory });
  await session.start();
  await wait(10);
  session.sendAudio(Buffer.alloc(128, 21));
  session.sendAudio(Buffer.alloc(128, 22));
  session.completeUtterance();
  factory.connections[0].close();
  await wait(650);
  assert.equal(factory.connections[1].sentMedia.length, 0, "completed utterance audio must not be replayed after reconnect");
  session.sendAudio(Buffer.alloc(128, 23));
  assert.equal(factory.connections[1].sentMedia.length, 1, "spoken audio after a completed utterance must still be accepted");
  session.stop();
}

{
  const now = Date.now();
  const order = buildProviderExecutionOrder({
    providerHealth: {
      gemini: { failures: 1, cooldownUntil: 0, lastSuccessAt: now - 1000 },
      openai: { failures: 0, cooldownUntil: now - 1, lastSuccessAt: now - 500 }
    },
    env: { geminiApiKey: "key", openaiApiKey: "key" },
    preferredProvider: "gemini",
    rotationOffset: 0
  });
  assert.deepEqual(order, ["gemini", "openai"], "providers whose cooldown elapsed should recover behind the preferred healthy provider");
}

{
  const factory = createFakeClientFactory();
  const results = [];
  const session = await createInterpreterSession({
    env: { deepgramApiKey: "test-key", geminiApiKey: "", openaiApiKey: "" },
    sourceLang: "en",
    targetLang: "es",
    targetLanguages: ["es"],
    shouldTranslate: true,
    deepgramClientFactory: factory,
    onResult: (result) => results.push(result)
  });
  await wait(10);

  const connection = factory.connections[0];
  const phrases = [
    "Can you please give me your book?",
    "Hello everyone.",
    "Can you please give me your book?",
    "Hello everyone."
  ];

  for (const phrase of phrases) {
    connection.emitTranscript(phrase, { isFinal: false });
    connection.emitTranscript(phrase, { isFinal: true });
    await wait(850);
  }

  const completed = results.filter((result) => result.isTranslationComplete && result.translations?.es);
  assert.equal(completed.length, 4, "repeated final transcripts outside the duplicate window should each complete exactly once");
  assert.equal(new Set(completed.map((result) => result.sequence)).size, 4, "completed translations should have unique stable sequences");
  session.stop();
}

{
  const factory = createFakeClientFactory();
  const partials = [];
  const completions = [];
  const session = await createInterpreterSession({
    env: { deepgramApiKey: "test-key", geminiApiKey: "", openaiApiKey: "" },
    sourceLang: "en",
    targetLanguages: ["es"],
    shouldTranslate: true,
    deepgramClientFactory: factory,
    onResult: (result) => {
      if (!result.isFinal) partials.push(result);
      if (result.isTranslationComplete && result.translations?.es) completions.push(result);
    }
  });
  await wait(10);

  const connection = factory.connections[0];
  for (let index = 0; index < 30; index += 1) {
    connection.emitTranscript(`Hello everyone ${index}`, { isFinal: false });
  }
  connection.emitTranscript("Can you please give me your book?", { isFinal: true });
  await wait(900);

  assert.ok(partials.length > 0, "long-running streaming should preserve partial transcripts");
  assert.equal(completions.length, 1, "long-running streaming final transcript should translate once");
  session.stop();
}
