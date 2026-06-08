const trimTrailingSlash = (value = "") => String(value || "").trim().replace(/\/+$/, "");

const rawFrontendEnv = {
  API_URL: trimTrailingSlash(import.meta.env.VITE_API_URL),
  SOCKET_URL: trimTrailingSlash(import.meta.env.VITE_SOCKET_URL),
  WS_URL: trimTrailingSlash(import.meta.env.VITE_WS_URL),
  CLIENT_URL: trimTrailingSlash(import.meta.env.VITE_CLIENT_URL) || window.location.origin,
  GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID || ""
};

console.log({
  API_URL: import.meta.env.VITE_API_URL,
  SOCKET_URL: import.meta.env.VITE_SOCKET_URL,
  WS_URL: import.meta.env.VITE_WS_URL
});

const placeholderHostPattern = /your-?backend/i;
const disallowedHostPatterns = [/^your-?backend\.onrender\.com$/i, /^your-?backend-url\.com$/i];
const localHostPatterns = [new RegExp(`^${["local", "host"].join("")}$`, "i"), /^127(?:\.0){2}\.1$/];

const isDisallowedPlaceholder = (value: string, parsed?: URL) =>
  placeholderHostPattern.test(value) ||
  (parsed ? disallowedHostPatterns.some((pattern) => pattern.test(parsed.hostname)) : false);

const isLocalHost = (parsed: URL) => localHostPatterns.some((pattern) => pattern.test(parsed.hostname));

const validateUrl = ({
  name,
  value,
  protocols,
  errors,
  warnings
}: {
  name: string;
  value: string;
  protocols: string[];
  errors: string[];
  warnings: string[];
}) => {
  if (!value) {
    warnings.push(`${name} is missing.`);
    return null;
  }

  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) {
      errors.push(`${name} must use one of: ${protocols.join(", ")}.`);
    }
    if (isDisallowedPlaceholder(value, parsed)) {
      errors.push(`${name} points to a placeholder backend host.`);
    }
    if (import.meta.env.PROD && isLocalHost(parsed)) {
      errors.push(`${name} cannot point to a local host in production.`);
    }
    if (import.meta.env.PROD && ["http:", "ws:"].includes(parsed.protocol)) {
      errors.push(`${name} must use HTTPS/WSS in production.`);
    }
    return parsed;
  } catch {
    errors.push(`${name} is malformed.`);
    return null;
  }
};

export const toWebSocketUrl = (socketUrl: string) => {
  const parsed = new URL(socketUrl);
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (!["ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported socket protocol: ${parsed.protocol}`);
  }
  return trimTrailingSlash(parsed.toString());
};

const validateFrontendEnvironment = () => {
  const errors: string[] = [];
  const warnings: string[] = [];

  const apiUrl = validateUrl({
    name: "VITE_API_URL",
    value: rawFrontendEnv.API_URL,
    protocols: ["https:", "http:"],
    errors,
    warnings
  });

  const socketUrl = validateUrl({
    name: "VITE_SOCKET_URL",
    value: rawFrontendEnv.SOCKET_URL,
    protocols: ["https:", "http:"],
    errors,
    warnings
  });

  const wsUrl = validateUrl({
    name: "VITE_WS_URL",
    value: rawFrontendEnv.WS_URL,
    protocols: ["wss:", "ws:"],
    errors,
    warnings
  });

  const clientUrl = validateUrl({
    name: "VITE_CLIENT_URL",
    value: rawFrontendEnv.CLIENT_URL,
    protocols: ["https:", "http:"],
    errors,
    warnings
  });

  let derivedWsUrl = "";
  if (socketUrl) {
    try {
      derivedWsUrl = toWebSocketUrl(rawFrontendEnv.SOCKET_URL);
      if (wsUrl && trimTrailingSlash(wsUrl.toString()) !== derivedWsUrl) {
        errors.push("VITE_WS_URL must match VITE_SOCKET_URL after HTTPS-to-WSS conversion.");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Unable to derive websocket URL from VITE_SOCKET_URL.");
    }
  }

  if (!rawFrontendEnv.GOOGLE_CLIENT_ID) {
    warnings.push("VITE_GOOGLE_CLIENT_ID is missing; Google sign-in is disabled.");
  }

  const diagnostics = {
    ok: errors.length === 0,
    errors,
    warnings,
    apiUrl: rawFrontendEnv.API_URL,
    socketUrl: rawFrontendEnv.SOCKET_URL,
    wsUrl: rawFrontendEnv.WS_URL,
    derivedWsUrl,
    clientUrl: rawFrontendEnv.CLIENT_URL,
    parsed: {
      apiUrl,
      socketUrl,
      wsUrl,
      clientUrl
    }
  };

  if (warnings.length > 0) {
    console.warn("[FRONTEND_ENV_WARNINGS]", warnings);
  }

  if (errors.length > 0) {
    console.error("[FRONTEND_ENV_ERRORS]", errors);
    throw new Error(`Invalid frontend environment configuration: ${errors.join("; ")}`);
  }

  return diagnostics;
};

export const FRONTEND_CONFIG_DIAGNOSTICS = validateFrontendEnvironment();
export const API = rawFrontendEnv.API_URL;
export const API_URL = rawFrontendEnv.API_URL;
export const SOCKET_URL = rawFrontendEnv.SOCKET_URL;
export const SOCKET_WEBSOCKET_URL = FRONTEND_CONFIG_DIAGNOSTICS.derivedWsUrl;
export const WS_URL = rawFrontendEnv.WS_URL;
export const CLIENT_URL = rawFrontendEnv.CLIENT_URL;
export const GOOGLE_CLIENT_ID = rawFrontendEnv.GOOGLE_CLIENT_ID;
export const SOCKET_TRANSPORTS = ["websocket", "polling"] as const;
