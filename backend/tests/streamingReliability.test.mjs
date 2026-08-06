import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDeepgramSession } from "../services/deepgram.js";
import { buildProviderExecutionOrder, createInterpreterSession } from "../services/interpreter.js";
import { createAudioPipelineSession } from "../services/audioPipeline.js";
import { normalizeLanguageCode } from "../../shared/languages.mjs";

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
  sendFinalize() { this.finalizeRequests = (this.finalizeRequests || 0) + 1; }
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

const createFakeClientFactory = (options = {}) => {
  const connections = [];
  const connectOptions = [];
  const factory = () => ({
    listen: {
      v1: {
        connect: async (deepgramOptions) => {
          connectOptions.push(deepgramOptions);
          const connection = new FakeDeepgramConnection(options.connectionOptions?.(connections.length) || {});
          connections.push(connection);
          return connection;
        }
      }
    }
  });
  factory.connections = connections;
  factory.connectOptions = connectOptions;
  return factory;
};

{
  const factory = createFakeClientFactory();
  const generations = [];
  const transcripts = [];
  const session = createDeepgramSession({
    apiKey: "test-key",
    sourceLang: "en",
    mimeType: "audio/webm;codecs=opus",
    clientFactory: factory,
    onGenerationChange: (event) => generations.push(event.generation),
    onTranscript: (event) => transcripts.push(event.text)
  });
  const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array(124).fill(1)]);
  const webmCluster = Buffer.from([0x1f, 0x43, 0xb6, 0x75, ...new Array(124).fill(2)]);

  await session.start();
  await wait(10);
  session.sendAudio(webmHeader, { streamGeneration: 1, containerHeader: true });
  session.sendAudio(webmCluster, { streamGeneration: 1 });
  assert.equal(factory.connections[0].sentMedia.length, 2);
  assert.equal(factory.connectOptions[0].encoding, undefined, "container audio must not force a raw encoding");
  assert.equal(factory.connectOptions[0].sample_rate, undefined, "container audio must supply its own sample rate");
  assert.equal(factory.connectOptions[0].channels, undefined, "container audio must supply its own channel count");
  assert.equal(factory.connectOptions[0].model, "nova-3");

  factory.connections[0].close();
  for (let index = 0; index < 180; index += 1) {
    session.sendAudio(Buffer.from([0x1f, 0x43, 0xb6, index & 0xff, ...new Array(124).fill(index & 0xff)]), { streamGeneration: 1 });
  }
  assert.ok(session.getHealth().queuedChunks <= session.getHealth().maxQueuedChunks, "container backlog must remain bounded");
  await wait(650);
  assert.equal(factory.connections.length, 2, "one close callback must create one replacement socket");
  assert.deepEqual(generations, [2]);
  assert.equal(factory.connections[1].sentMedia.length, 0, "old-generation WebM clusters must not be replayed into a fresh socket");
  session.sendAudio(webmCluster, { streamGeneration: 1 });
  session.sendAudio(webmCluster, { streamGeneration: 2 });
  assert.equal(factory.connections[1].sentMedia.length, 0, "a fresh generation must reject stale chunks and middle-container chunks");
  session.sendAudio(webmHeader, { streamGeneration: 2, containerHeader: true });
  session.sendAudio(webmCluster, { streamGeneration: 2 });
  assert.equal(factory.connections[1].sentMedia.length, 2);
  assert.deepEqual(factory.connections[1].sentMedia[0].subarray(0, 4), webmHeader.subarray(0, 4));
  factory.connections[1].emitTranscript("desktop stream healthy", { isFinal: false, speechFinal: false });
  assert.deepEqual(transcripts, ["desktop stream healthy"]);
  assert.equal(session.getHealth().reconnectAttempt, 0, "transcript activity must clear the stalled reconnect condition");
  session.stop();
}

{
  const pipeline = createAudioPipelineSession({ sessionId: "vad-silence-test", mimeType: "audio/pcm" });
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
  const pipeline = createAudioPipelineSession({ sessionId: "desktop-low-volume", mimeType: "audio/webm;codecs=opus" });
  for (let sequence = 1; sequence <= 12; sequence += 1) {
    const result = pipeline.preprocessAudioChunk(Buffer.alloc(256, sequence), { sequence, audioLevel: 0.0025, receivedAt: sequence * 700 });
    assert.equal(result.accepted, true, `desktop container chunk ${sequence} must not be dropped because browser RMS is low`);
  }
  assert.equal(pipeline.getSnapshot().acceptedChunks, 12, "multiple low-volume desktop chunks must remain continuous");
}

{
  const factory = createFakeClientFactory();
  const session = createDeepgramSession({ apiKey: "test-key", sourceLang: "en", clientFactory: factory });
  await session.start();
  await wait(10);
  session.sendAudio(Buffer.alloc(128, 31));
  session.completeUtterance();
  assert.equal(factory.connections[0].finalizeRequests, 1, "sustained silence must explicitly request Deepgram utterance finalization");
  factory.connections[0].close();
  session.sendAudio(Buffer.alloc(128, 32));
  assert.equal(session.getHealth().queuedChunks, 1, "completed utterance overlap must not be queued for reconnect replay");
  await wait(650);
  assert.equal(factory.connections[1].sentMedia.length, 1, "only current-utterance audio should recover after reconnect");
  session.stop();
}

{
  assert.equal(normalizeLanguageCode("ZH"), "zh");
  assert.equal(normalizeLanguageCode("zh-CN"), "zh");
  assert.equal(normalizeLanguageCode("FR"), "fr");
  assert.equal(normalizeLanguageCode("fr-FR"), "fr");
  assert.equal(normalizeLanguageCode("RU"), "ru");
  assert.equal(normalizeLanguageCode("ru-RU"), "ru");
}

{
  const factory = createFakeClientFactory();
  const finals = [];
  const translations = [];
  const session = await createInterpreterSession({
    env: { deepgramApiKey: "test-key", geminiApiKey: "", openaiApiKey: "" },
    sourceLang: "en",
    targetLanguages: ["fr-FR", "ru-RU", "zh-CN"],
    shouldTranslate: true,
    deepgramClientFactory: factory,
    onResult: (result) => {
      if (result.isTranscriptOnly) finals.push(result);
      if (result.isTranslationComplete) translations.push(result);
    }
  });
  await wait(10);
  session.completeUtterance();
  factory.connections[0].emitTranscript("Thank you.", { isFinal: true, speechFinal: true });
  await wait(1000);
  assert.equal(finals.length, 1, "an early mobile utterance boundary must finalize the later Deepgram segment exactly once");
  assert.equal(translations.length, 1, "the retained boundary must dispatch one final translation job");
  assert.deepEqual(finals[0].targetLanguages, ["fr", "ru", "zh"], "regional and uppercase target codes must normalize consistently");
  assert.equal(factory.connections.length, 1, "the early-boundary recovery must retain the Deepgram connection");
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
  await wait(1150);
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
    const sentBefore = connection.sentMedia.length;
    session.sendAudio(Buffer.alloc(128, phrases.indexOf(phrase) + 40));
    assert.equal(connection.sentMedia.length, sentBefore + 1, "audio after a finalized utterance must reach the same Deepgram session");
    connection.emitTranscript(phrase, { isFinal: false });
    connection.emitTranscript(phrase, { isFinal: true });
    session.completeUtterance();
    await wait(850);
  }

  const completed = results.filter((result) => result.isTranslationComplete && result.translations?.es);
  assert.equal(completed.length, 4, "repeated final transcripts outside the duplicate window should each complete exactly once");
  assert.equal(new Set(completed.map((result) => result.sequence)).size, 4, "completed translations should have unique stable sequences");
  assert.equal(factory.connections.length, 1, "two or more utterances must keep one Deepgram session open");
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
  assert.equal(completions.length, 0, "a Deepgram provider-final segment must not finalize the utterance by itself");
  session.completeUtterance();
  session.completeUtterance();
  await wait(900);

  assert.ok(partials.length > 0, "long-running streaming should preserve partial transcripts");
  assert.equal(completions.length, 1, "long-running streaming final transcript should translate once");
  assert.equal(factory.connections.length, 1, "utterance boundaries must keep the same Deepgram connection open");
  session.stop();
}

{
  const factory = createFakeClientFactory();
  const completions = [];
  const session = await createInterpreterSession({
    env: { deepgramApiKey: "test-key", geminiApiKey: "", openaiApiKey: "" },
    sourceLang: "en",
    targetLanguages: ["es"],
    shouldTranslate: true,
    deepgramClientFactory: factory,
    onResult: (result) => {
      if (result.isTranslationComplete && result.translations?.es) completions.push(result);
    }
  });
  await wait(10);

  const connection = factory.connections[0];
  connection.emitTranscript("Can you please give me your book?", { isFinal: true, speechFinal: true });
  await wait(900);

  assert.equal(completions.length, 1, "a speech-final transcript should trigger exactly one translation dispatch");
  session.stop();
}

{
  const factory = createFakeClientFactory();
  const partials = [];
  const finals = [];
  const translations = [];
  const previews = [];
  const session = await createInterpreterSession({
    env: { deepgramApiKey: "test-key", geminiApiKey: "", openaiApiKey: "" },
    sourceLang: "en",
    targetLanguages: ["es"],
    shouldTranslate: true,
    deepgramClientFactory: factory,
    onResult: (result) => {
      if (!result.isFinal) partials.push(result.originalText);
      if (result.isTranscriptOnly) finals.push(result.originalText);
      if (result.isTranslationComplete) translations.push(result);
      if (result.isStreamingPreview) previews.push(result);
    }
  });
  await wait(10);
  const connection = factory.connections[0];
  connection.emitTranscript("Can you please", { isFinal: false });
  connection.emitTranscript("Can you please", { isFinal: false });
  connection.emitTranscript("Can you please give me your book?", { isFinal: true, speechFinal: true });
  await wait(550);
  assert.equal(finals.length, 1, "a speech-final transcript should finalize once without waiting for an additional boundary");
  assert.equal(translations.length, 1, "a speech-final transcript should dispatch one final translation immediately");
  assert.equal(partials.at(-1), "Can you please give me your book?", "the same live source caption should advance to the provider-final text");
  assert.equal(partials.length, 2, "duplicate partial captions must be suppressed while the live line updates");
  assert.ok(previews.length <= 2, "translation previews must be throttled instead of emitted per token");
  session.completeUtterance();
  await wait(900);
  assert.equal(finals.length, 1, "the full source caption must finalize once");
  assert.equal(translations.length, 1, "the final translation should not be duplicated after a later boundary");
  assert.ok(translations[0].translations?.es, "the final translation must contain the completed utterance output");
  assert.equal(factory.connections.length, 1, "finalization must not replace the Deepgram stream");
  session.stop();
}
