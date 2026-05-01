import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
const MIN_PASSWORD_LENGTH = 6;

let storeLock = Promise.resolve();
let googleClient = null;

const base64Url = (input) => Buffer.from(input).toString("base64url");
const fromBase64Url = (input) => Buffer.from(input, "base64url").toString("utf8");

const normalizeEmail = (email) => email?.trim().toLowerCase();

const httpError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const ensureStore = async (env) => {
  await fs.mkdir(env.dataDir, { recursive: true });
  const filePath = path.join(env.dataDir, "users.json");

  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify({ users: [], history: [] }, null, 2));
  }

  return filePath;
};

const readStore = async (env) => {
  const filePath = await ensureStore(env);
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw || "{}");
};

const writeStore = async (env, store) => {
  const filePath = await ensureStore(env);
  await fs.writeFile(filePath, JSON.stringify(store, null, 2));
};

export const withUserStore = async (env, mutator) => {
  const run = async () => {
    const store = await readStore(env);
    store.users ||= [];
    store.history ||= [];
    const result = await mutator(store);
    await writeStore(env, store);
    return result;
  };

  storeLock = storeLock.then(run, run);
  return storeLock;
};

const hashPassword = (password, salt = crypto.randomBytes(16).toString("hex")) => {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
};

const verifyPassword = (password, storedHash) => {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;

  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
};

const safeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  picture: user.picture || "",
  plan: user.plan || "free",
  provider: user.provider || "password",
  settings: user.settings || {
    privateMode: true,
    shareableMode: false,
    preferredSourceLang: "en",
    preferredTargetLang: "es"
  },
  createdAt: user.createdAt
});

export const signToken = (user, env) => {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: user.id,
    email: user.email,
    plan: user.plan || "free",
    iss: env.jwtIssuer,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac("sha256", env.jwtSecret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
};

export const verifyToken = (token, env) => {
  const [encodedHeader, encodedPayload, signature] = token?.split(".") || [];
  if (!encodedHeader || !encodedPayload || !signature) {
    throw new Error("Invalid token");
  }

  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto.createHmac("sha256", env.jwtSecret).update(unsigned).digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    throw new Error("Invalid token signature");
  }

  const payload = JSON.parse(fromBase64Url(encodedPayload));
  if (payload.iss !== env.jwtIssuer || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Expired token");
  }

  return payload;
};

export const createSession = (user, env) => ({
  user: safeUser(user),
  token: signToken(user, env)
});

export const registerUser = async ({ name, email, password } = {}, env) => {
  const normalizedEmail = normalizeEmail(email);
  const cleanName = name?.trim() || normalizedEmail?.split("@")[0] || "Interpreter";

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw httpError("Enter a valid email address.", 400);
  }

  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw httpError("Password must be at least 6 characters.", 400);
  }

  return withUserStore(env, async (store) => {
    if (store.users.some((user) => user.email === normalizedEmail)) {
      throw httpError("An account already exists for this email.", 409);
    }

    const user = {
      id: crypto.randomUUID(),
      name: cleanName,
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      provider: "password",
      plan: "free",
      createdAt: new Date().toISOString(),
      settings: {
        privateMode: true,
        shareableMode: false,
        preferredSourceLang: "en",
        preferredTargetLang: "es"
      }
    };

    store.users.push(user);
    return createSession(user, env);
  });
};

export const loginUser = async ({ email, password } = {}, env) => {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw httpError("Email is required.", 400);
  }

  if (typeof password !== "string" || !password) {
    throw httpError("Password is required.", 400);
  }

  return withUserStore(env, async (store) => {
    const user = store.users.find((candidate) => candidate.email === normalizedEmail);
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      throw httpError("Invalid email or password.", 401);
    }

    return createSession(user, env);
  });
};

const verifyGoogleAccessToken = async (accessToken) => {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw httpError("Google login failed. Please try again.", 401);
  }

  const payload = await response.json();
  if (payload.email_verified === false) {
    throw httpError("Google account email is not verified.", 401);
  }

  return {
    email: payload.email,
    name: payload.name || payload.email?.split("@")[0],
    picture: payload.picture || ""
  };
};

const verifyGoogleCredential = async ({ credential, accessToken, profile }, env) => {
  if (accessToken) {
    return verifyGoogleAccessToken(accessToken);
  }

  if (credential && !env.googleClientId) {
    throw httpError("Google login is not configured on the server.", 400);
  }

  if (env.googleClientId && credential) {
    try {
      googleClient ||= new OAuth2Client(env.googleClientId);
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: env.googleClientId
      });
      const payload = ticket.getPayload();

      if (payload?.email_verified === false) {
        throw httpError("Google account email is not verified.", 401);
      }

      return {
        email: payload?.email,
        name: payload?.name || payload?.email?.split("@")[0],
        picture: payload?.picture || ""
      };
    } catch (error) {
      if (error?.statusCode) throw error;
      throw httpError("Invalid Google token.", 401);
    }
  }

  if (env.googleClientId && !credential) {
    throw httpError("Missing Google credential.", 400);
  }

  return {
    email: normalizeEmail(profile?.email) || "google-demo@interpshield.local",
    name: profile?.name || "Google Demo User",
    picture: profile?.picture || ""
  };
};

export const loginWithGoogle = async ({ credential, accessToken, profile } = {}, env) => {
  const googleProfile = await verifyGoogleCredential({ credential, accessToken, profile }, env);
  const normalizedEmail = normalizeEmail(googleProfile.email);

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw httpError("Google account did not return a valid email.", 400);
  }

  return withUserStore(env, async (store) => {
    let user = store.users.find((candidate) => candidate.email === normalizedEmail);

    if (!user) {
      user = {
        id: crypto.randomUUID(),
        name: googleProfile.name || normalizedEmail.split("@")[0],
        email: normalizedEmail,
        picture: googleProfile.picture || "",
        provider: "google",
        plan: "free",
        createdAt: new Date().toISOString(),
        settings: {
          privateMode: true,
          shareableMode: false,
          preferredSourceLang: "en",
          preferredTargetLang: "es"
        }
      };
      store.users.push(user);
    } else {
      user.name = googleProfile.name || user.name;
      user.picture = googleProfile.picture || user.picture;
      user.provider = user.provider === "password" ? "password+google" : "google";
    }

    return createSession(user, env);
  });
};

export const getUserByToken = async (token, env) => {
  const payload = verifyToken(token, env);
  const store = await readStore(env);
  const user = store.users.find((candidate) => candidate.id === payload.sub);

  if (!user) {
    throw new Error("User not found");
  }

  return safeUser(user);
};
