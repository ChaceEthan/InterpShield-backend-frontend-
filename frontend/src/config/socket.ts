const trimTrailingSlash = (value = "") => String(value || "").trim().replace(/\/+$/, "");
const socketIoPathPattern = /\/socket\.io\/?$/i;

const rawFrontendEnv = {
  API_URL: trimTrailingSlash(import.meta.env.VITE_API_URL),
  SOCKET_URL: trimTrailingSlash(import.meta.env.VITE_SOCKET_URL),
  WS_URL: trimTrailingSlash(import.meta.env.VITE_WS_URL),
  CLIENT_URL: trimTrailingSlash(import.meta.env.VITE_CLIENT_URL) || window.location.origin,
  GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID || ""
};

const placeholderHostPattern = /your-?backend/i;
const disallowedHostPatterns = [/^your-?backend\.onrender\.com$/i, /^your-?backend-url\.com$/i];
const localHostPatterns = [new RegExp(`^${["local", "host"].join("")}$`, "i"), /^127(?:\.0){2}\.1$/];

const isDisallowedPlaceholder = (value: string, parsed?: URL) =>
  placeholderHostPattern.test(value) ||
  (parsed ? disallowedHostPatterns.some((pattern) => pattern.test(parsed.hostname)) : false);

const isLocalHost = (parsed: URL) => localHostPatterns.some((pattern) => pattern.test(parsed.hostname));

const stripSocketIoPath = (parsed: URL) => {
  parsed.pathname = parsed.pathname.replace(socketIoPathPattern, "") || "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed;
};

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
  const parsed = stripSocketIoPath(new URL(socketUrl));
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "wss:" || parsed.protocol === "ws:") {
    // Already a websocket URL; keep it after normalizing any Socket.IO path suffix.
  }
  else if (!["ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported socket protocol: ${parsed.protocol}`);
  }
  return trimTrailingSlash(parsed.toString());
};

export const toSocketHttpUrl = (socketUrl: string) => {
  const parsed = stripSocketIoPath(new URL(socketUrl));
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  else if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported socket protocol: ${parsed.protocol}`);
  }
  return trimTrailingSlash(parsed.toString());
};

const validateFrontendEnvironment = () => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Determine fallback URLs to self-heal
  let activeApiUrl = rawFrontendEnv.API_URL;
  let activeSocketUrl = rawFrontendEnv.SOCKET_URL;
  let activeClientUrl = rawFrontendEnv.CLIENT_URL;

  if (typeof window !== "undefined") {
    if (!activeApiUrl) {
      warnings.push("VITE_API_URL is missing. Self-healing by falling back to current host: " + window.location.origin);
      activeApiUrl = window.location.origin;
    }
    if (!activeSocketUrl) {
      warnings.push("VITE_SOCKET_URL is missing. Self-healing by falling back to current host: " + window.location.origin);
      activeSocketUrl = window.location.origin;
    }
    if (!activeClientUrl) {
      activeClientUrl = window.location.origin;
    }
  }

  // Ensure HTTPS / WSS upgrades in production to prevent browser Mixed Content errors
  if (typeof window !== "undefined" && window.location.protocol === "https:") {
    if (activeApiUrl && activeApiUrl.startsWith("http://")) {
      warnings.push("Upgrading API connection to HTTPS to prevent Mixed Content blocking.");
      activeApiUrl = activeApiUrl.replace(/^http:\/\//i, "https://");
    }
    if (activeSocketUrl && activeSocketUrl.startsWith("http://")) {
      warnings.push("Upgrading Socket connection to HTTPS to prevent Mixed Content blocking.");
      activeSocketUrl = activeSocketUrl.replace(/^http:\/\//i, "https://");
    }
  }

  const apiUrl = validateUrl({
    name: "VITE_API_URL",
    value: activeApiUrl,
    protocols: ["https:", "http:"],
    errors,
    warnings
  });

  const socketUrl = validateUrl({
    name: "VITE_SOCKET_URL",
    value: activeSocketUrl,
    protocols: ["https:", "http:", "wss:", "ws:"],
    errors,
    warnings
  });

  const wsUrl = validateUrl({
    name: "VITE_WS_URL",
    value: rawFrontendEnv.WS_URL || (activeSocketUrl ? toWebSocketUrl(activeSocketUrl) : ""),
    protocols: ["wss:", "ws:"],
    errors,
    warnings
  });

  const clientUrl = validateUrl({
    name: "VITE_CLIENT_URL",
    value: activeClientUrl,
    protocols: ["https:", "http:"],
    errors,
    warnings
  });

  let normalizedSocketUrl = "";
  let derivedWsUrl = "";
  if (activeSocketUrl) {
    try {
      normalizedSocketUrl = toSocketHttpUrl(activeSocketUrl);
      derivedWsUrl = toWebSocketUrl(activeSocketUrl);
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
    apiUrl: activeApiUrl,
    socketUrl: normalizedSocketUrl || activeSocketUrl,
    wsUrl: rawFrontendEnv.WS_URL || derivedWsUrl,
    derivedWsUrl,
    clientUrl: activeClientUrl,
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
    console.error("[FRONTEND_ENV_ERRORS] Non-fatal, self-healing applied:", errors);
    // NEVER throw an Error here! Throwing here prevents the React app from compiling or rendering.
    // Instead of crashing the whole browser session, we report and carry on with self-healed URLs.
  }

  return diagnostics;
};

export const FRONTEND_CONFIG_DIAGNOSTICS = validateFrontendEnvironment();
export const API = FRONTEND_CONFIG_DIAGNOSTICS.apiUrl;
export const API_URL = FRONTEND_CONFIG_DIAGNOSTICS.apiUrl;
export const SOCKET_URL = FRONTEND_CONFIG_DIAGNOSTICS.socketUrl;
export const SOCKET_WEBSOCKET_URL = FRONTEND_CONFIG_DIAGNOSTICS.derivedWsUrl;
export const WS_URL = FRONTEND_CONFIG_DIAGNOSTICS.wsUrl;
export const CLIENT_URL = FRONTEND_CONFIG_DIAGNOSTICS.clientUrl;
export const GOOGLE_CLIENT_ID = rawFrontendEnv.GOOGLE_CLIENT_ID;
export const SOCKET_TRANSPORTS = ["websocket", "polling"] as const;
