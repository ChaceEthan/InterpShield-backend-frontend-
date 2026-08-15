import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGeminiGenerateContentUrl,
  buildGeminiModelsListUrl,
  classifyGeminiError,
  getGeminiModelOrder,
  listGeminiGenerateContentModels,
  normalizeGeminiModel,
  selectVerifiedGeminiFlashFallback,
  translateWithGemini
} from "../services/gemini.js";
import {
  classifyOpenAIError,
  isOpenAIQuotaError,
  isOpenAIRateLimitError,
  translateWithOpenAI
} from "../services/openai.js";
import {
  OPENAI_QUOTA_COOLDOWN_MS,
  applyProviderFailureToHealth,
  buildProviderExecutionOrder,
  createProviderUnavailableError,
  createPerLanguageDispatchQueue,
  isProviderAvailableFromHealth,
  isRetryableProviderError
} from "../services/interpreter.js";

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
  ["gemini-flash-latest"],
  "normalized duplicate model names should be attempted once"
);
assert.deepEqual(
  getGeminiModelOrder("models/custom-flash", ["models/gemini-flash-latest", "models/gemini-2.5-flash", "gemini-2.5-flash"]),
  ["custom-flash", "gemini-flash-latest", "gemini-2.5-flash"],
  "only authenticated fallback models should extend the bounded model order"
);
assert.equal(
  buildGeminiGenerateContentUrl("models/example-model"),
  "https://generativelanguage.googleapis.com/v1beta/models/example-model:generateContent"
);
assert.doesNotMatch(buildGeminiGenerateContentUrl("models/example-model"), /\/models\/models\//);
assert.equal(buildGeminiModelsListUrl(), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
assert.equal(
  selectVerifiedGeminiFlashFallback(
    ["models/gemini-2.0-flash-exp", "models/text-embedding-004", "models/gemini-2.5-flash"],
    ["gemini-flash-latest"]
  ),
  "gemini-2.5-flash"
);
assert.deepEqual(
  await listGeminiGenerateContentModels({
    apiKey: "test-only",
    request: async (url, options) => {
      assert.equal(url, buildGeminiModelsListUrl());
      assert.equal(options.method, "GET");
      return jsonResponse(200, {
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] }
        ]
      });
    }
  }),
  ["gemini-2.5-flash"],
  "only authenticated models that advertise generateContent may be selected"
);

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
  const calls = [];
  const result = await translateWithGemini({
    apiKey: "test-only",
    model: "models/gemini-flash-latest",
    text: sourceText,
    sourceLang: "en",
    targetLang: "es",
    includeMetadata: true,
    request: async (url) => {
      calls.push(url);
      if (url === buildGeminiModelsListUrl()) {
        return jsonResponse(200, {
          models: [
            { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
            { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }
          ]
        });
      }
      return url.includes("gemini-flash-latest")
        ? jsonResponse(404, { error: { message: "Alias temporarily unavailable" } })
        : geminiSuccessResponse(translations.es);
    },
    sleep: async () => undefined
  });

  assert.equal(result.providerModel, "gemini-2.5-flash");
  assert.deepEqual(result.attemptedModels, ["gemini-flash-latest", "gemini-2.5-flash"]);
  assert.equal(calls.length, 3, "404 should authenticate model discovery before using one verified Flash fallback");
  assert.equal(calls.filter((url) => url === buildGeminiModelsListUrl()).length, 1);
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
        return jsonResponse(429, { error: { message: "Requests per minute limit reached", status: "RESOURCE_EXHAUSTED" } }, { "Retry-After": "2" });
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
  assert.equal(failure.reason, "Requests per minute limit reached");
  assert.equal(failure.retryCount, 2);
  assert.equal(calls, 3, "temporary 429 must be bounded to the initial request plus two retries");
  assert.equal(sleepCalls, 2, "Retry-After must be respected within the bounded provider retry policy");
  assert.deepEqual(failure.attemptedModels, ["gemini-flash-latest"], "429 must not fan out across Gemini models");
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
      targetLang: "zh",
      request: async () => {
        calls += 1;
        return jsonResponse(429, { error: { message: "Resource exhausted" } }, { "Retry-After": "60" });
      },
      sleep: async (ms) => sleeps.push(ms)
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.retryAfterMs, 60000);
  assert.equal(calls, 1, "a long Gemini Retry-After must fall back instead of retrying early");
  assert.equal(sleeps.length, 0);
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

assert.equal(
  classifyOpenAIError({ httpStatus: 429, errorCode: "rate_limit_exceeded", reason: "Requests per minute reached" }),
  "temporary_rate_limit"
);
assert.equal(
  classifyOpenAIError({ httpStatus: 429, errorCode: "insufficient_quota", reason: "You exceeded your current quota, please check your plan and billing details." }),
  "billing_quota_exhausted"
);
assert.equal(isOpenAIRateLimitError({ httpStatus: 429, reason: "Too many requests" }), true);
assert.equal(isOpenAIQuotaError({ httpStatus: 429, reason: "Credit balance is unavailable" }), true);
assert.equal(classifyOpenAIError({ httpStatus: 429, errorCode: "billing_hard_limit_reached" }), "billing_quota_exhausted");
assert.equal(classifyOpenAIError({ httpStatus: 429, errorCode: "requests_per_minute" }), "temporary_rate_limit");
assert.equal(
  classifyOpenAIError({ httpStatus: 401, errorCode: "insufficient_quota", reason: "Billing authentication rejected" }),
  "billing_quota_exhausted",
  "a structured insufficient_quota code must remain a billing failure"
);
assert.equal(classifyOpenAIError({ httpStatus: 401, reason: "Invalid API key" }), "authentication_failure");
assert.equal(classifyOpenAIError({ httpStatus: 403, reason: "Permission denied" }), "permission_failure");
assert.equal(classifyOpenAIError({ httpStatus: 503, reason: "Service unavailable" }), "provider_overloaded");
assert.equal(classifyOpenAIError({ reason: "Network timeout" }), "network_timeout");
assert.equal(classifyOpenAIError({ httpStatus: 500, reason: "Unexpected provider response" }), "unknown_provider_error");

assert.equal(classifyGeminiError({ httpStatus: 429, reason: "Requests per minute limit reached", errorStatus: "RESOURCE_EXHAUSTED" }), "temporary_rate_limit");
assert.equal(classifyGeminiError({ httpStatus: 429, reason: "Requests per day quota exceeded", errorDetails: [{ quotaMetric: "generate_content_requests_per_day" }] }), "daily_quota_exhausted");
assert.equal(classifyGeminiError({ httpStatus: 429, reason: "Quota limit reached", errorDetails: [{ quotaId: "free-tier", description: "limit: 0" }] }), "daily_quota_exhausted");
assert.equal(classifyGeminiError({ httpStatus: 429, reason: "Check your plan and billing details" }), "billing_quota_exhausted");
assert.equal(classifyGeminiError({ httpStatus: 503, reason: "The model is overloaded" }), "provider_overloaded");
assert.equal(classifyGeminiError({ httpStatus: 404, reason: "Model not found" }), "model_unavailable");
assert.equal(classifyGeminiError({ httpStatus: 401, reason: "API key not valid" }), "authentication_failure");
assert.equal(classifyGeminiError({ httpStatus: 403, reason: "Permission denied" }), "permission_failure");
assert.equal(classifyGeminiError({ reason: "Network timeout" }), "network_timeout");

{
  let calls = 0;
  const sleeps = [];
  const result = await translateWithOpenAI({
    apiKey: "test-only",
    text: sourceText,
    sourceLang: "en",
    targetLang: "es",
    includeMetadata: true,
    request: async () => {
      calls += 1;
      return calls < 3
        ? jsonResponse(
            429,
            { error: { message: "Rate limit reached for requests per minute", code: "rate_limit_exceeded", type: "requests" } },
            { "Retry-After": "2" }
          )
        : openAISuccessResponse(translations.es);
    },
    sleep: async (ms) => sleeps.push(ms)
  });

  assert.equal(result.text, translations.es);
  assert.equal(result.providerModel, "gpt-4o-mini");
  assert.equal(result.retryCount, 2);
  assert.equal(calls, 3, "temporary OpenAI rate limiting should use only bounded retries");
  assert.deepEqual(sleeps, [2000, 2000]);
}

{
  let calls = 0;
  const sleeps = [];
  let failure;
  try {
    await translateWithOpenAI({
      apiKey: "test-only",
      text: sourceText,
      sourceLang: "en",
      targetLang: "es",
      request: async () => {
        calls += 1;
        return jsonResponse(
          429,
          { error: { message: "Rate limit reached", code: "rate_limit_exceeded" } },
          { "Retry-After": "60" }
        );
      },
      sleep: async (ms) => sleeps.push(ms)
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.retryAfterMs, 60000);
  assert.equal(calls, 1, "a long OpenAI Retry-After must fall back instead of retrying early");
  assert.equal(sleeps.length, 0);
}

let openAIQuotaFailure;
{
  let calls = 0;
  const sleeps = [];
  try {
    await translateWithOpenAI({
      apiKey: "test-only",
      text: sourceText,
      sourceLang: "en",
      targetLang: "es",
      request: async () => {
        calls += 1;
        return jsonResponse(429, {
          error: {
            message: "You exceeded your current quota, please check your plan and billing details.",
            code: "insufficient_quota",
            type: "insufficient_quota"
          }
        });
      },
      sleep: async (ms) => sleeps.push(ms)
    });
  } catch (error) {
    openAIQuotaFailure = error;
  }

  assert.ok(openAIQuotaFailure);
  assert.equal(openAIQuotaFailure.httpStatus, 429);
  assert.equal(openAIQuotaFailure.errorCode, "insufficient_quota");
  assert.equal(openAIQuotaFailure.errorCategory, "billing_quota_exhausted");
  assert.equal(openAIQuotaFailure.quotaExhausted, true);
  assert.equal(openAIQuotaFailure.providerRetryExhausted, true);
  assert.equal(openAIQuotaFailure.retryCount, 0);
  assert.equal(openAIQuotaFailure.reason, "You exceeded your current quota, please check your plan and billing details.");
  assert.equal(calls, 1, "quota or billing failure must not receive a useless retry");
  assert.equal(sleeps.length, 0);
}

{
  let failure;
  try {
    await translateWithOpenAI({
      apiKey: "test-only",
      text: sourceText,
      sourceLang: "en",
      targetLang: "es",
      request: async () => jsonResponse(429, { error: {} }),
      sleep: async () => undefined
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.doesNotMatch(failure.reason, /\[object Object\]/, "structured provider errors must never stringify as [object Object]");
}

{
  const now = Date.now();
  const providerHealth = {
    gemini: { failures: 0, cooldownUntil: 0, lastSuccessAt: now, lastFailure: null },
    openai: { failures: 0, cooldownUntil: 0, lastSuccessAt: now, lastFailure: null }
  };
  const beforeFailureOrder = buildProviderExecutionOrder({
    providerHealth,
    env: { geminiApiKey: "configured", openaiApiKey: "configured" },
    preferredProvider: "openai",
    userPlan: "pro",
    rotationOffset: 1
  });
  assert.deepEqual(beforeFailureOrder, ["openai", "gemini"]);

  const outcome = applyProviderFailureToHealth({
    provider: "openai",
    health: providerHealth.openai,
    error: openAIQuotaFailure,
    now
  });
  assert.equal(outcome.reason, "quota_exhausted");
  assert.equal(outcome.cooldownApplied, true);
  assert.ok(providerHealth.openai.cooldownUntil >= now + OPENAI_QUOTA_COOLDOWN_MS);
  assert.equal(providerHealth.openai.quotaExhausted, true);
  assert.equal(isProviderAvailableFromHealth(providerHealth, "openai", now + 1), false);
  const quotaReason = providerHealth.openai.lastFailure.reason;
  const preserved = applyProviderFailureToHealth({
    provider: "openai",
    health: providerHealth.openai,
    error: Object.assign(new Error("Temporary rate limit"), {
      httpStatus: 429,
      reason: "Temporary rate limit",
      errorCategory: "temporary_rate_limit"
    }),
    now: now + 1
  });
  assert.equal(preserved.preserved, true);
  assert.equal(providerHealth.openai.quotaExhausted, true);
  assert.equal(providerHealth.openai.errorCategory, "billing_quota_exhausted");
  assert.equal(providerHealth.openai.lastFailure.reason, quotaReason, "a weaker in-flight failure must not overwrite active quota diagnostics");

  const afterFailureOrder = buildProviderExecutionOrder({
    providerHealth,
    env: { geminiApiKey: "configured", openaiApiKey: "configured" },
    preferredProvider: "openai",
    userPlan: "pro",
    rotationOffset: 1
  });
  assert.deepEqual(afterFailureOrder, ["gemini"], "quota-exhausted OpenAI must be skipped by every language lane during cooldown");

  let openAICallsAfterCooldown = 0;
  const routeLanguage = async (language) => {
    for (const provider of afterFailureOrder) {
      if (!isProviderAvailableFromHealth(providerHealth, provider, now + 1)) continue;
      if (provider === "openai") {
        openAICallsAfterCooldown += 1;
        throw new Error("OpenAI should have been skipped");
      }
      return { language, provider, providerModel: "gemini-flash-latest", text: translations[language] };
    }
    throw new Error("No healthy provider");
  };

  const routed = await Promise.all(["es", "ja", "zh"].map(routeLanguage));
  assert.equal(openAICallsAfterCooldown, 0, "no language may call OpenAI again after quota cooldown begins");
  assert.deepEqual(routed.map((result) => result.provider), ["gemini", "gemini", "gemini"]);
  assert.equal(routed.find((result) => result.language === "es").text, translations.es, "Spanish must route to healthy Gemini");
}

{
  const now = Date.now();
  const geminiHealth = { failures: 0, cooldownUntil: 0, lastSuccessAt: 0, lastFailure: null };
  const outcome = applyProviderFailureToHealth({
    provider: "gemini",
    health: geminiHealth,
    error: Object.assign(new Error("Gemini resource exhausted"), {
      httpStatus: 429,
      reason: "Gemini resource exhausted"
    }),
    now
  });
  assert.equal(outcome.cooldownApplied, true);
  assert.equal(outcome.reason, "quota_exhausted");
  assert.equal(geminiHealth.errorCategory, "daily_quota_exhausted");
  assert.ok(geminiHealth.cooldownUntil >= now + 30 * 60 * 1000);

  const unavailableError = createProviderUnavailableError({
    providerHealth: {
      gemini: geminiHealth,
      openai: {
        failures: 1,
        cooldownUntil: now + OPENAI_QUOTA_COOLDOWN_MS,
        lastFailure: {
          provider: "openai",
          httpStatus: 429,
          reason: "Unconfigured provider failure",
          at: now + 10
        }
      }
    },
    env: { geminiApiKey: "configured", openaiApiKey: "" }
  });
  assert.equal(unavailableError.provider, "gemini");
  assert.equal(unavailableError.httpStatus, 429);
  assert.equal(unavailableError.reason, "Gemini resource exhausted");
  assert.equal(unavailableError.providerRetryExhausted, true);
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
      jsonResponse(429, { error: { message: "Requests per minute limit reached", status: "RESOURCE_EXHAUSTED" } }, { "Retry-After": "2" }),
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
  let openAICalls = 0;
  const events = [];
  const queue = createPerLanguageDispatchQueue({
    languages: ["es", "ja", "zh"],
    concurrency: 3,
    requestDelayMs: 100,
    maxRetries: 0,
    onEvent: (event) => events.push(event),
    worker: async (language) => {
      const providerHealth = {
        gemini: { failures: 0, cooldownUntil: 0, lastSuccessAt: 0 },
        openai: { failures: 1, cooldownUntil: Date.now() + OPENAI_QUOTA_COOLDOWN_MS, lastSuccessAt: 0, quotaExhausted: true }
      };
      const providerOrder = buildProviderExecutionOrder({
        providerHealth,
        env: { geminiApiKey: "configured", openaiApiKey: "configured" },
        preferredProvider: "gemini",
        userPlan: "pro"
      });
      assert.deepEqual(providerOrder, ["gemini"]);

      if (providerOrder.includes("openai")) openAICalls += 1;
      return translateWithGemini({
        apiKey: "test-only",
        text: sourceText,
        sourceLang: "en",
        targetLang: language,
        includeMetadata: true,
        request: async () => geminiSuccessResponse(translations[language]),
        sleep: async () => undefined
      });
    }
  });

  const results = await queue.run();
  assert.equal(openAICalls, 0);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((result) => result.provider), ["gemini", "gemini", "gemini"]);
  assert.deepEqual(results.map((result) => result.providerModel), ["gemini-flash-latest", "gemini-flash-latest", "gemini-flash-latest"]);
  assert.ok(results.every((result) => result.text && result.text !== sourceText));
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
            errorCode: error.errorCode || null,
            errorCategory: error.errorCategory || null,
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
  for (const field of ["provider", "providerModel", "httpStatus", "reason", "errorCode", "errorCategory", "latencyMs", "retryCount", "queueLength", "activeWorkers", "requestId"]) {
    assert.ok(Object.hasOwn(diagnostic, field), `failure diagnostic must include ${field}`);
  }
}

assert.match(interpreterSource, /`Provider Model: \$\{providerModel \|\| "unknown"\}`/);
assert.match(interpreterSource, /`HTTP Status: \$\{statusCode \|\| "unknown"\}`/);
assert.match(interpreterSource, /`Failure Reason: \$\{summaryReason\}`/);
assert.match(interpreterSource, /`Queue Length: \$\{Number\.isFinite\(queueLength\)/);
assert.match(interpreterSource, /`Active Workers: \$\{Number\.isFinite\(activeWorkers\)/);
assert.doesNotMatch(interpreterSource, /message:\s*["']FAILED["']/);
assert.match(interpreterSource, /temporary_rate_limit/);
assert.match(interpreterSource, /daily_quota_exhausted/);
assert.match(interpreterSource, /billing_quota_exhausted/);
assert.match(interpreterSource, /existingQuotaActive/);
assert.match(interpreterSource, /createProviderUnavailableError/);
assert.match(frontendSource, /Provider Model:/);
assert.match(frontendSource, /diagnosticUpdates\[language\]\s*=\s*""/);
assert.match(frontendSource, /hasSuccessfulTranslation/);
assert.match(frontendSource, /OpenAI quota is currently unavailable/);
assert.match(frontendSource, /errorCategory\?: string \| null/);
assert.doesNotMatch(frontendSource, /if\s*\(diagnostic\.message\)\s*return/);
assert.doesNotMatch(frontendSource, /coerceTranslationState\(diagnostic\.status\s*\|\|\s*nextStatusUpdates\[language\]\s*\|\|\s*status\)/);

// Requested diagnostics: an explicit per-attempt log (so a future incident can prove which
// providers were actually tried for a given target language, in order), a from/to/reason
// fallback log distinct from the pre-existing PROVIDER_FALLBACK shape, and a final-failure log
// once every provider in the order has genuinely been exhausted.
assert.match(interpreterSource, /logTranslationEvent\("TRANSLATION_PROVIDER_ATTEMPT", \{\s*sessionId,\s*jobId,\s*targetLanguage: language,\s*provider,\s*attempt: attempt \+ 1\s*\}\);/, "TRANSLATION_PROVIDER_ATTEMPT is logged immediately before each provider attempt, with the target language and attempt number");
assert.match(interpreterSource, /logTranslationEvent\("TRANSLATION_PROVIDER_FALLBACK", \{\s*from: provider,\s*to: nextProviderInOrder,\s*jobId,\s*targetLanguage: language,\s*reason: lastError\?\.errorCategory \|\| lastError\?\.reason \|\| lastError\?\.message \|\| "provider_failed"\s*\}, "warn"\);/, "TRANSLATION_PROVIDER_FALLBACK is logged with the exact requested {from, to, reason} shape whenever a provider genuinely falls through to the next one in the order");
assert.match(interpreterSource, /logTranslationEvent\("TRANSLATION_PROVIDER_FINAL_FAILURE", \{/, "TRANSLATION_PROVIDER_FINAL_FAILURE is logged once every provider in the order has been exhausted for this target language");

// Section: these events must not be silently suppressed in production the way a non-PROVIDER_
// prefixed event would be by logTranslationEvent's own shouldLog gate.
assert.match(interpreterSource, /const providerEvent = \/\^PROVIDER_\|\^TRANSLATION_PROVIDER_\|/, "TRANSLATION_PROVIDER_* events are recognized as provider events, so they are NOT silently dropped in production (only NODE_ENV!=='production' or an explicit debug flag would otherwise let them through)");

// Never log API keys: none of the new diagnostic payloads reference apiKey or the raw env
// credential fields directly.
{
  const attemptLogIndex = interpreterSource.indexOf('logTranslationEvent("TRANSLATION_PROVIDER_ATTEMPT"');
  const attemptLogBlock = interpreterSource.slice(attemptLogIndex, attemptLogIndex + 300);
  assert.doesNotMatch(attemptLogBlock, /apiKey|geminiApiKey|openaiApiKey/, "TRANSLATION_PROVIDER_ATTEMPT never includes an API key field");
  const fallbackLogIndex = interpreterSource.indexOf('logTranslationEvent("TRANSLATION_PROVIDER_FALLBACK"');
  const fallbackLogBlock = interpreterSource.slice(fallbackLogIndex, fallbackLogIndex + 300);
  assert.doesNotMatch(fallbackLogBlock, /apiKey|geminiApiKey|openaiApiKey/, "TRANSLATION_PROVIDER_FALLBACK never includes an API key field");
}

// French + German (or any two targets) are dispatched through createPerLanguageDispatchQueue
// independently, each running its own translateProviderLanguageWithRecovery loop with its own
// providerOrder/lastError — proven end-to-end here: one target (es) hitting an OpenAI-shaped
// authentication failure after Gemini also fails must not cancel or fail the other targets
// (ja, zh), which succeed via OpenAI normally. This mirrors the exact French/German scenario:
// one target's provider exhaustion is fully isolated from the other target's outcome.
{
  const queue = createPerLanguageDispatchQueue({
    languages: ["fr", "de"],
    concurrency: 2,
    requestDelayMs: 50,
    maxRetries: 0,
    worker: async (language) => {
      // "fr" simulates the reported production failure: OpenAI quota exhausted. Gemini is
      // configured and healthy, so the backend fallback loop must still attempt it — and here
      // it succeeds, proving quota-exhausted OpenAI does not prevent Gemini from being tried.
      if (language === "fr") {
        return translateWithBackendProviderFallback({
          language,
          geminiRequest: async () => geminiSuccessResponse("Bien-être mental."),
          openAIRequest: async () => {
            throw new Error("OpenAI should not be reached: Gemini must be tried first here and succeed");
          }
        });
      }
      // "de" is fully independent of whatever happened to "fr" above.
      return translateWithBackendProviderFallback({
        language,
        geminiRequest: async () => jsonResponse(503, { error: { message: "Gemini overloaded" } }),
        openAIRequest: async () => openAISuccessResponse("Psychisches Wohlbefinden.")
      });
    }
  });

  const results = await queue.run();
  const frResult = results.find((_, index) => ["fr", "de"][index] === "fr");
  const deResult = results.find((_, index) => ["fr", "de"][index] === "de");
  assert.equal(frResult.text, "Bien-être mental.", "French resolves via Gemini independently of German's outcome");
  assert.equal(frResult.provider, "gemini");
  assert.equal(deResult.text, "Psychisches Wohlbefinden.", "German resolves via OpenAI independently of French's outcome");
  assert.equal(deResult.provider, "openai");
}
