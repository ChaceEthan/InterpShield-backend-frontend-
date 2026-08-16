// @ts-nocheck
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GEMINI_TIMEOUT_MS,
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
  DEFAULT_TRANSLATION_PROVIDER,
  OPENAI_QUOTA_COOLDOWN_MS,
  applyProviderFailureToHealth,
  buildProviderExecutionOrder,
  createProviderUnavailableError,
  createPerLanguageDispatchQueue,
  isProviderAvailableFromHealth,
  isRetryableProviderError,
  shouldDegradeProviderHealth
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

// A real fetch() rejects a pending request the moment its AbortSignal fires; a naive mock that
// just returns `new Promise(() => {})` does not replicate that, so it can never actually be
// unblocked by translateOnce's own timeout-driven abort() — leaving the test itself hanging
// instead of testing what happens when a genuine network stall gets cut off by the timeout.
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
  // Real production bug: Gemini's actual free-tier per-minute 429 response reuses the exact
  // same "check your plan and billing details" boilerplate Google sends for a genuine billing
  // block, and its quotaId ("GenerateRequestsPerMinutePerProjectPerModel-FreeTier") is camelCase
  // with no spaces, so naive phrase matching on the message text alone misclassified this
  // self-healing, seconds-long rate limit as a 30-minute billing failure — starving every other
  // in-flight language/session of Gemini even though the paid provider was never actually broken.
  const realGeminiPerMinuteRateLimitError = {
    httpStatus: 429,
    errorStatus: "RESOURCE_EXHAUSTED",
    reason: "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
    errorDetails: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            quotaValue: "15"
          }
        ]
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "24s" }
    ]
  };

  assert.equal(
    classifyGeminiError(realGeminiPerMinuteRateLimitError),
    "temporary_rate_limit",
    "a real Gemini per-minute quotaId must win over Google's shared 'check your plan and billing details' boilerplate"
  );

  const geminiHealth = { failures: 0, cooldownUntil: 0, lastSuccessAt: 0, lastFailure: null };
  const now = Date.now();
  const outcome = applyProviderFailureToHealth({
    provider: "gemini",
    health: geminiHealth,
    error: Object.assign(new Error(realGeminiPerMinuteRateLimitError.reason), realGeminiPerMinuteRateLimitError),
    now
  });
  assert.equal(outcome.reason, "temporary_rate_limit");
  assert.ok(
    geminiHealth.cooldownUntil < now + 60000,
    "a genuine per-minute rate limit must self-heal in well under a minute, not the 30-minute billing cooldown"
  );
  assert.equal(geminiHealth.quotaExhausted, false, "a per-minute rate limit is not quota exhaustion");
  assert.equal(isProviderAvailableFromHealth({ gemini: geminiHealth }, "gemini", now + 60000), true, "Gemini must be usable again well before 30 minutes pass");

  // A genuine billing/account block — no quotaId, no RetryInfo — must still be treated as a real
  // 30-minute failure; the fix must not make InterpShield blind to actual billing exhaustion.
  const genuineBillingFailure = {
    httpStatus: 429,
    errorStatus: "RESOURCE_EXHAUSTED",
    reason: "You exceeded your current quota, please check your plan and billing details."
  };
  assert.equal(classifyGeminiError(genuineBillingFailure), "billing_quota_exhausted");
  const billingHealth = { failures: 0, cooldownUntil: 0, lastSuccessAt: 0, lastFailure: null };
  applyProviderFailureToHealth({
    provider: "gemini",
    health: billingHealth,
    error: Object.assign(new Error(genuineBillingFailure.reason), genuineBillingFailure),
    now
  });
  assert.ok(billingHealth.cooldownUntil >= now + 30 * 60 * 1000, "a genuine billing block must still receive the full 30-minute cooldown");
}

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

const translateWithBackendProviderFallback = async ({ language, geminiRequest, openAIRequest }, { geminiTimeoutMs } = {}) => {
  let geminiFailure;

  try {
    return await translateWithGemini({
      apiKey: "test-only",
      text: sourceText,
      sourceLang: "en",
      targetLang: language,
      includeMetadata: true,
      request: geminiRequest,
      sleep: async () => undefined,
      ...(geminiTimeoutMs ? { timeoutMs: geminiTimeoutMs } : {})
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
assert.match(interpreterSource, /logTranslationEvent\("TRANSLATION_PROVIDER_ATTEMPT", \{\s*sessionId,\s*jobId,\s*utteranceId: jobId,\s*targetLanguage: language,\s*provider,\s*attempt: attempt \+ 1\s*\}\);/, "TRANSLATION_PROVIDER_ATTEMPT is logged immediately before each provider attempt, with the target language, utterance identity, and attempt number");
assert.match(interpreterSource, /logTranslationEvent\("TRANSLATION_PROVIDER_SUCCESS", \{\s*sessionId,\s*jobId,\s*utteranceId: jobId,\s*targetLanguage: language,\s*provider: result\.provider\s*\}\);/, "TRANSLATION_PROVIDER_SUCCESS is logged as soon as a provider's result is accepted as a real translation");
assert.match(interpreterSource, /logTranslationEvent\("TRANSLATION_PROVIDER_FALLBACK", \{\s*sessionId,\s*jobId,\s*utteranceId: jobId,\s*targetLanguage: language,\s*from: provider,\s*to: nextProviderInOrder,\s*reason: lastError\?\.errorCategory \|\| lastError\?\.reason \|\| lastError\?\.message \|\| "provider_failed"\s*\}, "warn"\);/, "TRANSLATION_PROVIDER_FALLBACK is logged with the exact requested {from, to, reason} shape (plus session/job/utterance identity) whenever a provider genuinely falls through to the next one in the order");
assert.match(interpreterSource, /logTranslationEvent\("TRANSLATION_PROVIDER_FINAL_FAILURE", \{\s*sessionId,\s*jobId,\s*utteranceId: jobId,/, "TRANSLATION_PROVIDER_FINAL_FAILURE is logged once every provider in the order has been exhausted for this target language, with full session/job/utterance identity");

// Section: these events must not be silently suppressed in production the way a non-PROVIDER_
// prefixed event would be by logTranslationEvent's own shouldLog gate.
assert.match(interpreterSource, /const providerEvent = \/\^PROVIDER_\|\^TRANSLATION_PROVIDER_\|/, "TRANSLATION_PROVIDER_* events are recognized as provider events, so they are NOT silently dropped in production (only NODE_ENV!=='production' or an explicit debug flag would otherwise let them through)");

// Never log API keys: none of the new diagnostic payloads reference apiKey or the raw env
// credential fields directly.
{
  const attemptLogIndex = interpreterSource.indexOf('logTranslationEvent("TRANSLATION_PROVIDER_ATTEMPT"');
  const attemptLogBlock = interpreterSource.slice(attemptLogIndex, attemptLogIndex + 300);
  assert.doesNotMatch(attemptLogBlock, /apiKey|geminiApiKey|openaiApiKey/, "TRANSLATION_PROVIDER_ATTEMPT never includes an API key field");
  const successLogIndex = interpreterSource.indexOf('logTranslationEvent("TRANSLATION_PROVIDER_SUCCESS"');
  const successLogBlock = interpreterSource.slice(successLogIndex, successLogIndex + 300);
  assert.doesNotMatch(successLogBlock, /apiKey|geminiApiKey|openaiApiKey/, "TRANSLATION_PROVIDER_SUCCESS never includes an API key field");
  const fallbackLogIndex = interpreterSource.indexOf('logTranslationEvent("TRANSLATION_PROVIDER_FALLBACK"');
  const fallbackLogBlock = interpreterSource.slice(fallbackLogIndex, fallbackLogIndex + 300);
  assert.doesNotMatch(fallbackLogBlock, /apiKey|geminiApiKey|openaiApiKey/, "TRANSLATION_PROVIDER_FALLBACK never includes an API key field");
  const finalFailureLogIndex = interpreterSource.indexOf('logTranslationEvent("TRANSLATION_PROVIDER_FINAL_FAILURE"');
  const finalFailureLogBlock = interpreterSource.slice(finalFailureLogIndex, finalFailureLogIndex + 300);
  assert.doesNotMatch(finalFailureLogBlock, /apiKey|geminiApiKey|openaiApiKey/, "TRANSLATION_PROVIDER_FINAL_FAILURE never includes an API key field");
}

// Gemini-first default: DEFAULT_TRANSLATION_PROVIDER is the single source of truth used
// wherever the caller does not explicitly request a provider (preferredProvider === "auto"),
// and it resolves to "gemini" unless an operator explicitly overrides it via env — never a
// second, independently-hardcoded "openai" default drifting out of sync.
{
  assert.equal(DEFAULT_TRANSLATION_PROVIDER, "gemini", "Gemini is the default primary translation provider (OpenAI, which currently has no paid quota, is fallback-only)");
  const defaultOrder = buildProviderExecutionOrder({
    providerHealth: {
      gemini: { failures: 0, cooldownUntil: 0, lastSuccessAt: 0, lastFailure: null },
      openai: { failures: 0, cooldownUntil: 0, lastSuccessAt: 0, lastFailure: null }
    },
    env: { geminiApiKey: "configured", openaiApiKey: "configured" },
    preferredProvider: "auto"
  });
  assert.deepEqual(defaultOrder, ["gemini", "openai"], "with no explicit preference, Gemini is tried before OpenAI by default");
}
assert.match(interpreterSource, /const preferred = \["gemini", "openai"\]\.includes\(preferredProvider\) \? preferredProvider : DEFAULT_TRANSLATION_PROVIDER;/, "buildProviderExecutionOrder's own default resolves through the single DEFAULT_TRANSLATION_PROVIDER constant, not a separately hardcoded literal");
assert.match(interpreterSource, /: DEFAULT_TRANSLATION_PROVIDER;\s*\n\s*const order = buildProviderExecutionOrder/, "getHealthyProviders' primaryChoice fallback resolves through the same single DEFAULT_TRANSLATION_PROVIDER constant");

// Safe startup diagnostics (section 4): reports configured/model/preferred for both providers
// without ever printing the key itself, and clearly flags a missing GEMINI_API_KEY.
{
  const serverSource = readFileSync(resolve(__dirname, "../server.js"), "utf8");
  assert.match(serverSource, /event: "TRANSLATION_PROVIDER_STATUS",\s*provider: "gemini",\s*configured: Boolean\(env\.geminiApiKey\),\s*model: env\.geminiModel,\s*preferred: DEFAULT_TRANSLATION_PROVIDER === "gemini"/, "startup logs Gemini's configured/model/preferred status");
  assert.match(serverSource, /event: "TRANSLATION_PROVIDER_STATUS",\s*provider: "openai",\s*configured: Boolean\(env\.openaiApiKey\),/, "startup logs OpenAI's configured status");
  assert.doesNotMatch(serverSource, /TRANSLATION_PROVIDER_STATUS[\s\S]{0,400}geminiApiKey(?!\)|,)/, "the startup diagnostic never prints the raw geminiApiKey value, only Boolean(...) of it");
  assert.match(serverSource, /GEMINI_API_KEY is not configured in this environment/, "a missing GEMINI_API_KEY is clearly reported at startup instead of silently degrading");
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

// Real production evidence: Gemini's fetch() genuinely never resolves (a network-level stall,
// not an HTTP error response), the internal AbortController/timeout fires, and the resulting
// error must be classified as a real network_timeout — not a billing/quota failure, and not
// something that silently retries forever. `timeoutMs` is overridden to a few milliseconds so
// this test proves the real timeout code path without waiting the real 25-second budget.
{
  let calls = 0;
  const start = Date.now();
  let failure;
  // The internal AbortController timer is intentionally created with unref() in production (so a
  // slow provider never blocks process shutdown); with nothing else scheduled, a bare test would
  // let Node consider the event loop "empty" and exit before that unref'd timer ever fires. A
  // small ref'd keep-alive timer is test-only scaffolding to give the real timer a chance to run.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    await translateWithGemini({
      apiKey: "test-only",
      text: sourceText,
      sourceLang: "en",
      targetLang: "fr",
      timeoutMs: 40,
      request: async (url, options) => {
        calls += 1;
        // Simulates a stalled Render -> Google connection: only resolves if/when aborted.
        return stalledFetch(url, options);
      },
      sleep: async () => undefined
    });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(keepAlive);
  }
  const elapsedMs = Date.now() - start;
  assert.ok(failure, "a genuinely stalled Gemini fetch must still reject once its timeout elapses");
  assert.match(failure.message, /timed out/i);
  assert.equal(failure.errorCategory, "network_timeout", "a real stall must classify as network_timeout, never as a billing/quota failure");
  assert.equal(calls, 1, "a hard network stall (no status code) must not be retried within the same attempt budget");
  assert.ok(elapsedMs < 2000, `the timeout must actually bound the call instead of hanging (took ${elapsedMs}ms)`);
}

// The full production chain from Phase 3: Gemini times out (a real stall, not an HTTP error),
// then OpenAI is attempted as fallback and returns 429 with no credits. The result must reach a
// terminal FAILED state with both providers' diagnostics available — never left implying the
// target is still "retrying" or "translating" once both providers have genuinely been exhausted.
{
  let openAICalls = 0;
  let failure;
  const keepAlive = setTimeout(() => {}, 500);
  try {
    await translateWithBackendProviderFallback({
      language: "fr",
      // Only resolves if/when aborted: a genuine network stall, not an HTTP error response.
      geminiRequest: stalledFetch,
      openAIRequest: async () => {
        openAICalls += 1;
        return jsonResponse(429, {
          error: { message: "You have no credits remaining.", code: "insufficient_quota", type: "insufficient_quota" }
        });
      }
    }, { geminiTimeoutMs: 40 });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(keepAlive);
  }

  assert.ok(failure, "Gemini timeout + OpenAI 429 must terminate, not hang indefinitely");
  assert.equal(openAICalls, 1, "OpenAI fallback must be attempted exactly once after a genuine Gemini timeout");
  assert.equal(failure.httpStatus, 429);
  assert.equal(failure.errorCategory, "billing_quota_exhausted");
  assert.equal(failure.providerRetryExhausted, true, "a terminal OpenAI billing failure must not be retried further, so the target can settle into FAILED instead of staying RETRYING/Translating forever");
}

// Real production evidence: many concurrent preview-1-zh/preview-2-zh/preview-3-zh/preview-4-zh
// requests were observed in flight at once for the SAME target language, none of them actually
// cancelled — only their eventual result was discarded if superseded. That flood is what drove
// genuine Gemini 503 provider_overloaded responses, which in turn applied a real cooldown that
// then starved unrelated final jobs (French failing while Chinese succeeded). The fix bounds each
// target language to exactly one in-flight preview request, cancels the previous one the moment a
// newer one supersedes it, and makes any real final translation job outrank/cancel preview work
// for the same languages the instant the source utterance is finalized.
assert.match(
  interpreterSource,
  /const activePreviewJobIdByLanguage = new Map\(\);/,
  "at most one in-flight preview provider request is tracked per target language"
);
assert.match(
  interpreterSource,
  /const cancelActivePreviewForLanguage = \(language, \{ reason = "superseded", newPreviewJobId = null \} = \{\}\) => \{/,
  "a single, reusable cancellation helper exists for retiring a target language's in-flight preview"
);
{
  const emitPreviewIndex = interpreterSource.indexOf("const emitStreamingProviderPreviewForLanguage = (");
  const emitPreviewBody = interpreterSource.slice(emitPreviewIndex, emitPreviewIndex + 700);
  assert.match(
    emitPreviewBody,
    /cancelActivePreviewForLanguage\(language, \{ reason: "newer_preview", newPreviewJobId: previewJobId \}\);/,
    "starting a new preview for a language must first cancel that SAME language's previous in-flight preview (never a different language's, never a final job's)"
  );
  assert.match(
    emitPreviewBody,
    /activePreviewJobIdByLanguage\.set\(language, previewJobId\);/,
    "the newly started preview must register itself as the active preview for this language"
  );
}
{
  const finalPriorityIndex = interpreterSource.indexOf('cancelActivePreviewForLanguage(language, { reason: "final_job_started" });');
  assert.ok(finalPriorityIndex >= 0, "creating a real final translation job must cancel any still-running preview for each of its target languages — a final job always outranks preview work");
  const finalJobFollowup = interpreterSource.slice(finalPriorityIndex, finalPriorityIndex + 200);
  assert.match(finalJobFollowup, /logTranslationEvent\("FINAL_TRANSLATION_PRIORITY", \{/);
}
assert.match(interpreterSource, /logTranslationEvent\("PREVIEW_TRANSLATION_SUPERSEDED", \{/);
assert.match(interpreterSource, /logTranslationEvent\("TRANSLATION_ABORT_REQUESTED", \{/);
// Isolation is structural, not just behavioral: a preview's jobId always embeds its own target
// language (`preview-${previewId}-${language}`), and cancellation is always looked up by the
// exact jobId string — so cancelling one language's preview can never resolve to a different
// language's entry in providerAbortControllersByJob, and can never match a final job's numeric id.
assert.match(interpreterSource, /const previewJobId = `preview-\$\{previewId\}-\$\{language\}`;/);

// Preview cancellation must never look like a real Gemini failure to provider-health tracking.
// noteProviderFailure() is only reached through isProviderNonRetryableFailure(), which matches on
// HTTP status (400/401/403/404) or billing/quota/permission keywords in the error message — an
// intentional cancellation's message ("Gemini translation aborted") matches neither, so a run of
// preview supersessions during continuous speech can never accumulate into a false Gemini cooldown.
{
  const intentionalAbort = Object.assign(new Error("Gemini translation aborted"), {});
  assert.equal(
    shouldDegradeProviderHealth({ error: intentionalAbort, provider: "gemini" }),
    false,
    "an intentional cancellation (plain Error, not a real AbortError, no timedOut flag) must not be treated as a provider health signal"
  );

  // A GENUINE timeout/abort (native fetch AbortError, or the explicit timedOut flag) must still
  // count as a real signal — the fix must not blind the app to actual Gemini outages.
  const genuineAbortError = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  assert.equal(
    shouldDegradeProviderHealth({ error: genuineAbortError, provider: "gemini" }),
    true,
    "a genuine AbortError (e.g. the provider's own request truly timed out) must still degrade provider health"
  );
  assert.equal(
    shouldDegradeProviderHealth({ result: { timedOut: true }, provider: "gemini" }),
    true,
    "an explicit timedOut result must still degrade provider health"
  );
}

// Production evidence: sourceChars: 50, contextChars: 1787 — a 35x context-to-source ratio,
// dominated by accumulated styleMemory (past translation samples). Previews are interim and
// routinely superseded within ~500ms, so they never need that context; the final job for the
// same utterance still gets it in full. This does not remove styleMemory from translation
// memory — only from the interim preview requests that immediately discard their own context.
assert.match(
  interpreterSource,
  /const languageTranslationContext = \{\s*\.\.\.languageTranslationContextFor\(language, buildTranslationContext\(\{ sentence: cleanSentence, direction, detectedLanguage \}\)\),\s*styleMemory: null\s*\};/,
  "preview provider requests strip styleMemory from their translation context to avoid sending unnecessarily large context for interim, soon-discarded text"
);
{
  // Final jobs must NOT be affected by the preview-only context trim: languageTranslationContextFor
  // itself (used by every final-job translation path) still attaches styleMemory unconditionally.
  assert.match(
    interpreterSource,
    /const languageTranslationContextFor = \(language, translationContext\) => \(\{\s*\.\.\.translationContext,\s*styleMemory: styleMemoryByLanguage\.get\(language\) \|\| null\s*\}\);/,
    "the shared context builder used by final jobs still includes full styleMemory"
  );
}

// Production evidence: GEMINI_REQUEST_ERROR { jobId: "preview-41-zh", errorName: "AbortError",
// errorCategory: "network_timeout", aborted: true, timedOut: false } followed by TRANSLATION_FAILED
// { jobId: "preview-41-zh", reason: "Gemini translation aborted", timeoutMs: 25000 }. A native
// fetch AbortError fires whenever ANY signal in the merged set aborts — including the CALLER
// (interpreter.js) intentionally cancelling a superseded preview via its own AbortController, which
// is not a timeout at all. translateOnce/translateWithGemini must distinguish that from a genuine
// timeout using actual state (their own `timedOut` flag), not merely error.name === "AbortError".

// TEST 1 — intentional preview abort: the CALLER's own signal aborts while translateOnce's
// internal timeout has not fired. Must be classified intentional_abort (never network_timeout),
// must not be retryable, and must not degrade Gemini provider health / trigger cooldown.
{
  const callerController = new AbortController();
  const abortErr = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  // Mirrors a real in-flight fetch: never resolves on its own, only rejects when its signal aborts.
  const hangingUntilAbortedRequest = async (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortErr());
        return;
      }
      options.signal?.addEventListener("abort", () => reject(abortErr()));
    });

  const translationPromise = translateWithGemini({
    apiKey: "test-only",
    model: "models/gemini-flash-latest",
    text: sourceText,
    sourceLang: "en",
    targetLang: "fr",
    includeMetadata: true,
    signal: callerController.signal,
    request: hangingUntilAbortedRequest,
    sleep: async () => undefined
  });

  // Give the request a tick to actually be in flight before superseding it — cancellation always
  // targets an already-started request in production, never one that hasn't been issued yet.
  await new Promise((resolve) => setTimeout(resolve, 5));
  callerController.abort();

  let caughtError = null;
  try {
    await translationPromise;
  } catch (error) {
    caughtError = error;
  }

  assert.ok(caughtError, "a superseded preview request must reject, not silently resolve");
  assert.equal(caughtError.errorCategory, "intentional_abort", "a caller-cancelled request must be classified as intentional_abort, never network_timeout");
  assert.equal(caughtError.intentionalAbort, true, "the error must carry an explicit, unambiguous marker instead of relying on error.name/message text downstream");
  assert.equal(isRetryableProviderError(caughtError), false, "an intentional abort must never be retried");
  assert.equal(
    shouldDegradeProviderHealth({ error: caughtError, provider: "gemini" }),
    false,
    "an intentional abort must never degrade Gemini provider health or trigger a cooldown"
  );
}

// TEST 2 — a genuine timeout: translateOnce's OWN timer fires (nothing external cancelled it).
// Must remain classified network_timeout and stay eligible for the existing bounded retry logic —
// the fix for TEST 1 must not blind the app to real Gemini outages/stalls.
{
  const abortErr = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  // A real fetch() rejects the instant its AbortSignal fires — including translateOnce's OWN
  // internal timeout, which aborts the merged signal it hands to `request`. A mock that never
  // settles at all would hang forever regardless of that timeout firing.
  const neverResolvingRequest = async (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortErr());
        return;
      }
      options.signal?.addEventListener("abort", () => reject(abortErr()));
    });
  // translateOnce's own timeout timer is intentionally unref()'d (so a hung request never keeps
  // a real server process alive) — in this isolated script, with nothing else ref'd, Node can
  // decide the event loop is "empty" before that timer gets a chance to fire. A trivial ref'd
  // interval keeps the process alive long enough for the genuine timeout to occur, exactly as it
  // would in a real, always-running server process.
  const keepAlive = setInterval(() => undefined, 1000);
  const shortTimeoutPromise = translateWithGemini({
    apiKey: "test-only",
    model: "models/gemini-flash-latest",
    text: sourceText,
    sourceLang: "en",
    targetLang: "fr",
    includeMetadata: true,
    timeoutMs: 20,
    request: neverResolvingRequest,
    sleep: async () => undefined
  });

  let caughtError = null;
  try {
    await shortTimeoutPromise;
  } catch (error) {
    caughtError = error;
  } finally {
    clearInterval(keepAlive);
  }

  assert.ok(caughtError, "a genuine timeout must still reject");
  assert.equal(caughtError.errorCategory, "network_timeout", "a genuine internal timeout must remain classified as network_timeout");
  assert.notEqual(caughtError.intentionalAbort, true, "a genuine timeout must never be marked as an intentional abort");
  // A genuine timeout already consumed its own full timeoutMs budget with no response at all —
  // gemini.js deliberately does NOT retry it internally (retrying would multiply worst-case
  // latency) and marks it providerRetryExhausted, so isRetryableProviderError correctly says this
  // SAME attempt should not be retried again. That is a distinct question from whether the
  // interpreter.js's OUTER loop may still move on to a different provider (e.g. OpenAI) for this
  // language — which it may, exactly as an intentional abort must not (see TEST 1).
  assert.equal(caughtError.providerRetryExhausted, true, "a genuine timeout is marked provider-exhausted for this attempt by gemini.js's own bounded retry logic");
  assert.equal(isRetryableProviderError(caughtError), false, "isRetryableProviderError respects providerRetryExhausted — this SAME attempt must not be retried again");
  assert.equal(
    shouldDegradeProviderHealth({ error: caughtError, provider: "gemini" }),
    true,
    "a genuine timeout must still degrade provider health, or real Gemini outages would go undetected"
  );
}

// The classification lives in gemini.js's own catch blocks, not just interpreter.js's consumers —
// assert the actual source carries the explicit marker rather than only asserting on behavior,
// so a future refactor that accidentally drops the marker (while still passing the above
// behavioral checks by coincidence) gets caught here too.
{
  const geminiSource = readFileSync(resolve(__dirname, "../services/gemini.js"), "utf8");
  assert.match(
    geminiSource,
    /const intentionalAbort = !timedOut && Boolean\(signal\?\.aborted\);/,
    "translateOnce distinguishes a caller-initiated abort from its own timeout using actual state (the timedOut flag), not merely error.name"
  );
  assert.match(
    geminiSource,
    /cancelledError\.errorCategory = "intentional_abort";\s*cancelledError\.intentionalAbort = true;/,
    "an intentional abort is marked with an explicit, unambiguous errorCategory/flag instead of being inferred downstream from message text"
  );
  assert.match(
    geminiSource,
    /if \(error\?\.intentionalAbort \|\| signal\?\.aborted \|\| \/aborted\/i\.test\(error\?\.message \|\| ""\)\) \{/,
    "translateWithGemini's outer retry loop preserves the intentional-abort marker on re-throw instead of discarding it via a fresh, untagged Error"
  );
}
