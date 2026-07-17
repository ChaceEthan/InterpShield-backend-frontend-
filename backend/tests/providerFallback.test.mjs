import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGeminiGenerateContentUrl,
  getGeminiModelOrder,
  normalizeGeminiModel,
  translateWithGemini
} from "../services/gemini.js";
import { translateWithOpenAI } from "../services/openai.js";
import { createPerLanguageDispatchQueue, isRetryableProviderError } from "../services/interpreter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interpreterSource = readFileSync(resolve(__dirname, "../services/interpreter.js"), "utf8");
const frontendSource = readFileSync(resolve(__dirname, "../../frontend/src/App.tsx"), "utf8");
const sourceText = "Please confirm that the conference room will remain open until six o'clock.";

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });

const geminiSuccessResponse = (text) =>
  jsonResponse(200, { candidates: [{ content: { parts: [{ text }] } }] });

const openAISuccessResponse = (text) =>
  jsonResponse(200, { choices: [{ message: { content: text } }] });

const translations = {
  es: "Confirme que la sala de conferencias permanecerá abierta hasta las seis.",
  ja: "会議室が6時まで開いていることを確認してください。",
  zh: "请确认会议室将开放到六点。"
};

assert.equal(normalizeGeminiModel("models/gemini-flash-latest"), "gemini-flash-latest");
assert.equal(normalizeGeminiModel("models/models/example-model"), "example-model");
assert.deepEqual(
  getGeminiModelOrder("models/gemini-flash-latest"),
  ["gemini-flash-latest", "gemini-3.1-flash-lite"],
  "normalized duplicate model names should be attempted once"
);
assert.equal(
  buildGeminiGenerateContentUrl("models/example-model"),
  "https://generativelanguage.googleapis.com/v1beta/models/example-model:generateContent"
);
assert.doesNotMatch(buildGeminiGenerateContentUrl("models/example-model"), /\/models\/models\//);

{
  const calls = [];
  const result = await translateWithGemini({
    apiKey: "test-only",
    model: "models/unavailable-model",
    text: sourceText,
    sourceLang: "en",
    targetLang: "es",
    includeMetadata: true,
    request: async (url) => {
      calls.push(url);
      return url.includes("unavailable-model")
        ? jsonResponse(404, { error: { message: "Configured model is unavailable" } })
        : geminiSuccessResponse(translations.es);
    },
    sleep: async () => undefined
  });

  assert.equal(result.text, translations.es);
  assert.equal(result.providerModel, "gemini-flash-latest");
  assert.equal(result.retryCount, 1, "a model switch must be reported as a retry");
  assert.equal(calls.length, 2, "404 should advance immediately to the next unique model");
  assert.ok(calls.every((url) => !url.includes("/models/models/")));
}

{
  let calls = 0;
  const sleeps = [];
  let failure;

  try {
    await translateWithGemini({
      apiKey: "test-only",
      text: sourceText,
      sourceLang: "en",
      targetLang: "ja",
      request: async () => {
        calls += 1;
        return jsonResponse(
          503,
          { error: { message: "Service temporarily unavailable" } },
          { "Retry-After": "3600" }
        );
      },
      sleep: async (ms) => sleeps.push(ms)
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, "persistent Gemini 503 should be surfaced to the provider fallback");
  assert.equal(failure.httpStatus, 503);
  assert.equal(failure.reason, "Service temporarily unavailable");
  assert.equal(failure.providerModel, "gemini-flash-latest");
  assert.equal(failure.retryCount, 2);
  assert.equal(failure.providerRetryExhausted, true);
  assert.equal(calls, 3, "503 must be limited to the initial request plus two retries");
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 4200), "503 backoff must remain bounded despite Retry-After");
}

{
  let calls = 0;
  const sleeps = [];
  const result = await translateWithGemini({
    apiKey: "test-only",
    text: sourceText,
    sourceLang: "en",
    targetLang: "ja",
    includeMetadata: true,
    request: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(503, { error: { message: "Temporary Gemini demand" } })
        : geminiSuccessResponse(translations.ja);
    },
    sleep: async (ms) => sleeps.push(ms)
  });

  assert.equal(result.text, translations.ja);
  assert.equal(result.retryCount, 1);
  assert.equal(calls, 2, "Gemini must recover after one bounded 503 retry");
  assert.equal(sleeps.length, 1);
}

{
  const exhausted = Object.assign(new Error("Temporary Gemini demand"), {
    httpStatus: 503,
    providerRetryExhausted: true
  });
  assert.equal(isRetryableProviderError(exhausted), false, "the dispatcher must not retry exhausted Gemini work");
}

{
  let calls = 0;
  let sleepCalls = 0;
  let failure;

  try {
    await translateWithGemini({
      apiKey: "test-only",
      text: sourceText,
      sourceLang: "en",
      targetLang: "zh",
      request: async () => {
        calls += 1;
        return jsonResponse(429, { error: { message: "Rate limit reached" } }, { "Retry-After": "2" });
      },
      sleep: async () => {
        sleepCalls += 1;
      }
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.equal(failure.httpStatus, 429);
  assert.equal(failure.retryAfterMs, 2000);
  assert.equal(failure.reason, "Rate limit reached");
  assert.equal(calls, 1, "429 should hand off to OpenAI instead of fanning out across Gemini models");
  assert.equal(sleepCalls, 0, "Retry-After is enforced as provider cooldown, not a blocked language worker");
}

for (const status of [401, 403]) {
  let calls = 0;
  await assert.rejects(
    translateWithGemini({
      apiKey: "test-only",
      model: "custom-model",
      text: sourceText,
      sourceLang: "en",
      targetLang: "es",
      request: async () => {
        calls += 1;
        return jsonResponse(status, { error: { message: "Authentication rejected" } });
      },
      sleep: async () => undefined
    }),
    (error) => error.httpStatus === status && error.providerModel === "custom-model"
  );
  assert.equal(calls, 1, `${status} must not retry with other Gemini models`);
}

const translateWithBackendProviderFallback = async ({ language, geminiRequest, openAIRequest }) => {
  let geminiFailure;

  try {
    return await translateWithGemini({
      apiKey: "test-only",
      text: sourceText,
      sourceLang: "en",
      targetLang: language,
      includeMetadata: true,
      request: geminiRequest,
      sleep: async () => undefined
    });
  } catch (error) {
    geminiFailure = error;
  }

  const result = await translateWithOpenAI({
    apiKey: "test-only",
    text: sourceText,
    sourceLang: "en",
    targetLang: language,
    includeMetadata: true,
    request: openAIRequest
  });

  return {
    ...result,
    fallbackFrom: {
      provider: geminiFailure.provider,
      providerModel: geminiFailure.providerModel,
      httpStatus: geminiFailure.httpStatus,
      reason: geminiFailure.reason,
      retryCount: geminiFailure.retryCount,
      retryAfterMs: geminiFailure.retryAfterMs
    }
  };
};

{
  const result = await translateWithBackendProviderFallback({
    language: "es",
    geminiRequest: async () =>
      jsonResponse(429, { error: { message: "Rate limit reached" } }, { "Retry-After": "2" }),
    openAIRequest: async () => openAISuccessResponse(translations.es)
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.text, translations.es);
  assert.equal(result.fallbackFrom.httpStatus, 429);
  assert.equal(result.fallbackFrom.retryAfterMs, 2000);
}

{
  const events = [];
  const queue = createPerLanguageDispatchQueue({
    languages: ["es", "ja", "zh"],
    concurrency: 3,
    requestDelayMs: 100,
    maxRetries: 0,
    onEvent: (event) => events.push(event),
    worker: async (language) =>
      translateWithBackendProviderFallback({
        language,
        geminiRequest: async () =>
          jsonResponse(503, { error: { message: "Temporary Gemini demand" } }),
        openAIRequest: async () => openAISuccessResponse(translations[language])
      })
  });

  const results = await queue.run();
  assert.equal(results.length, 3);
  for (const [index, language] of ["es", "ja", "zh"].entries()) {
    assert.equal(results[index].text, translations[language]);
    assert.equal(results[index].provider, "openai");
    assert.equal(results[index].providerModel, "gpt-4o-mini");
    assert.equal(results[index].fallbackFrom.httpStatus, 503);
    assert.notEqual(results[index].text, sourceText);
  }
  assert.ok(events.some((event) => event.type === "dispatch_start" && event.activeWorkers > 1));
  assert.equal(events.filter((event) => event.type === "dispatch_complete").length, 3);
}

{
  const queue = createPerLanguageDispatchQueue({
    languages: ["es", "ja", "zh"],
    concurrency: 3,
    requestDelayMs: 100,
    maxRetries: 0,
    worker: async (language, context) => {
      try {
        const result = await translateWithBackendProviderFallback({
          language,
          geminiRequest: async () =>
            jsonResponse(404, { error: { message: "Model unavailable" } }),
          openAIRequest: async () =>
            language === "es"
              ? jsonResponse(401, { error: { message: "OpenAI authentication rejected" } })
              : openAISuccessResponse(translations[language])
        });
        return { language, status: "translated", result };
      } catch (error) {
        return {
          language,
          status: "failed",
          diagnostic: {
            provider: error.provider || "OpenAI",
            providerModel: error.providerModel,
            httpStatus: error.httpStatus,
            reason: error.message,
            latencyMs: 1,
            retryCount: error.retryCount || 0,
            queueLength: context.queueLength,
            activeWorkers: context.activeWorkers,
            requestId: context.requestId
          }
        };
      }
    }
  });

  const results = await queue.run();
  assert.equal(results.find((result) => result.language === "es").status, "failed");
  assert.equal(results.find((result) => result.language === "ja").status, "translated");
  assert.equal(results.find((result) => result.language === "zh").status, "translated");
  const diagnostic = results.find((result) => result.language === "es").diagnostic;
  for (const field of ["provider", "providerModel", "httpStatus", "reason", "latencyMs", "retryCount", "queueLength", "activeWorkers", "requestId"]) {
    assert.ok(Object.hasOwn(diagnostic, field), `failure diagnostic must include ${field}`);
  }
}

assert.match(interpreterSource, /`Provider Model: \$\{providerModel \|\| "unknown"\}`/);
assert.match(interpreterSource, /`HTTP Status: \$\{statusCode \|\| "unknown"\}`/);
assert.match(interpreterSource, /`Failure Reason: \$\{summaryReason\}`/);
assert.match(interpreterSource, /`Queue Length: \$\{Number\.isFinite\(queueLength\)/);
assert.match(interpreterSource, /`Active Workers: \$\{Number\.isFinite\(activeWorkers\)/);
assert.doesNotMatch(interpreterSource, /message:\s*["']FAILED["']/);
assert.match(interpreterSource, /statusCode === 429 && Number\.isFinite\(retryAfterMs\)/);
assert.match(frontendSource, /Provider Model:/);
assert.match(frontendSource, /diagnosticUpdates\[language\]\s*=\s*""/);
assert.match(frontendSource, /hasSuccessfulTranslation/);
assert.doesNotMatch(frontendSource, /if\s*\(diagnostic\.message\)\s*return/);
assert.doesNotMatch(frontendSource, /coerceTranslationState\(diagnostic\.status\s*\|\|\s*nextStatusUpdates\[language\]\s*\|\|\s*status\)/);
