export const providerErrorMessage = (error = {}) => String(error?.message || error || "");

export const normalizeProviderText = (value = "") =>
  String(value ?? "")
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim();

export const normalizeForComparison = (value = "") =>
  normalizeProviderText(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");

export const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

export const getRetryAfterMs = (error = {}) => {
  const headers = error.headers || error.response?.headers;
  const rawValue = typeof headers?.get === "function"
    ? headers.get("retry-after")
    : headers?.["retry-after"] || headers?.["Retry-After"];

  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") return null;

  const value = String(rawValue).trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null;
};

export const getRetryDelay = ({ attempt = 1, baseMs = 1000, maxMs = 4000, error = null }) => {
  if (error) {
    const retryAfterMs = getRetryAfterMs(error);
    if (retryAfterMs !== null) return Math.min(maxMs, retryAfterMs);
    const match = /retry after (\d+) second/i.exec(error.message || "");
    if (match) {
      const seconds = parseInt(match[1], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return Math.min(maxMs, seconds * 1000);
      }
    }
  }
  const backoff = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.random() * 200;
  return backoff + jitter;
};

export const createAbortPromise = (signal, abortErrorFactory = () => new Error("Translation aborted")) => {
  if (!signal) return { promise: null, cleanup: () => undefined };
  if (signal.aborted) return { promise: Promise.reject(abortErrorFactory()), cleanup: () => undefined };

  let handleAbort = () => undefined;
  const promise = new Promise((_, reject) => {
    handleAbort = () => reject(abortErrorFactory());
    signal.addEventListener?.("abort", handleAbort, { once: true });
  });

  return {
    promise,
    cleanup: () => signal.removeEventListener?.("abort", handleAbort)
  };
};

export const mergeAbortSignals = (...signals) => {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return { signal: undefined, cleanup: () => undefined };
  if (activeSignals.length === 1) return { signal: activeSignals[0], cleanup: () => undefined };

  const controller = new AbortController();
  const abort = () => controller.abort();
  const cleanupCallbacks = [];

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      for (const cleanup of cleanupCallbacks) cleanup();
      return { signal: controller.signal, cleanup: () => undefined };
    }
    signal.addEventListener?.("abort", abort, { once: true });
    cleanupCallbacks.push(() => signal.removeEventListener?.("abort", abort));
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const cleanup of cleanupCallbacks) cleanup();
    }
  };
};

export const getErrorStatusCode = (error = {}) => {
  const statusCandidates = [
    error?.status,
    error?.statusCode,
    error?.httpStatus,
    error?.response?.status,
    error?.details?.status,
    error?.code
  ];

  for (const candidate of statusCandidates) {
    const numericStatus = Number(candidate);
    if (Number.isFinite(numericStatus) && numericStatus > 0) {
      return numericStatus;
    }
  }

  return null;
};

export const isNonRetryableProviderError = (error = {}, statusCodes = [400, 401, 403, 404], extraPatterns = []) => {
  const message = providerErrorMessage(error);
  const statusCode = getErrorStatusCode(error);

  if (statusCode && statusCodes.includes(statusCode)) return true;

  const patternSource = [
    ...extraPatterns,
    "quota",
    "billing",
    "unauthori[sz]ed",
    "forbidden",
    "invalid api key",
    "permission",
    "resource_exhausted",
    "insufficient"
  ]
    .filter(Boolean)
    .join("|");

  return patternSource ? new RegExp(`\\b(?:${patternSource})\\b`, "i").test(message) : false;
};
