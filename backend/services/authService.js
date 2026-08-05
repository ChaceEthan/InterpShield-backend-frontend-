import bcrypt from "bcrypt";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import { requireDatabase } from "../config/database.js";
import User from "../models/User.js";

const MIN_PASSWORD_LENGTH = 6;
const BCRYPT_SALT_ROUNDS = 12;

let googleClient = null;

/** @param {string|undefined|null} email */
const normalizeEmail = (email) => email?.trim().toLowerCase();

/** @param {string} message @param {number} [statusCode] @returns {Error & {statusCode: number}} */
export const httpError = (message, statusCode = 400) => {
  /** @type {Error & {statusCode: number}} */
  const error = /** @type {any} */ (new Error(message));
  error.statusCode = statusCode;
  return error;
};

const requireJwtSecret = (env) => {
  if (!env.jwtSecret) {
    throw httpError("JWT_SECRET is not configured on the server.", 503);
  }
};

/** @param {string} password */
export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

/** @param {string|undefined|null} storedHash */
const isBcryptHash = (storedHash) => storedHash?.startsWith("$2a$") || storedHash?.startsWith("$2b$") || storedHash?.startsWith("$2y$");

/** @param {string} password @param {string|undefined|null} storedHash */
export const verifyPassword = async (password, storedHash) => {
  if (!storedHash) return false;
  if (!isBcryptHash(storedHash)) return false;
  return bcrypt.compare(password, storedHash);
};

/** @param {any} value */
const toId = (value) => value?._id?.toString?.() || value?.id || value?.toString?.() || "";

/** @param {any} user */
export const safeUser = (user) => ({
  id: toId(user),
  name: user.name,
  email: user.email,
  avatar: user.avatar || user.picture || "",
  picture: user.picture || user.avatar || "",
  plan: user.plan || "free",
  provider: user.provider || "password",
  role: user.role || "user",
  status: user.status || "active",
  planOverride: user.planOverride,
  accessOverrideEndsAt: user.accessOverrideEndsAt?.toISOString?.() || user.accessOverrideEndsAt,
  mustChangePassword: Boolean(user.mustChangePassword),
  settings: user.settings || {
    privateMode: true,
    shareableMode: false,
    preferredSourceLang: "en",
    preferredTargetLang: "es"
  },
  createdAt: user.createdAt?.toISOString?.() || user.createdAt
});

/** @param {any} user @param {any} env */
export const signToken = (user, env) => {
  requireJwtSecret(env);

  return jwt.sign({ userId: toId(user) }, env.jwtSecret, { expiresIn: "30d" });
};

/** @param {string} token @param {any} env */
export const verifyToken = (token, env) => {
  requireJwtSecret(env);

  return jwt.verify(token, env.jwtSecret);
};

/** @param {any} user @param {any} env */
export const createSession = (user, env) => ({
  user: safeUser(user),
  token: signToken(user, env)
});

/** @param {{name?: string, email?: string, password?: string}} [credentials] @param {any} [env] */
export const registerUser = async ({ name, email, password } = {}, env) => {
  const normalizedEmail = normalizeEmail(email);
  const cleanName = name?.trim() || normalizedEmail?.split("@")[0] || "Interpreter";

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw httpError("Enter a valid email address.", 400);
  }

  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw httpError("Password must be at least 6 characters.", 400);
  }

  requireDatabase(env);

  try {
    const user = await User.create({
      name: cleanName,
      email: normalizedEmail,
      password: await hashPassword(password),
      provider: "password"
    });

    return createSession(user, env);
  } catch (error) {
    if (error?.code === 11000) {
      throw httpError("An account already exists for this email", 409);
    }

    throw error;
  }
};

/** @param {{email?: string, password?: string}} [credentials] @param {any} [env] */
export const loginUser = async ({ email, password } = {}, env) => {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw httpError("Email is required.", 400);
  }

  if (typeof password !== "string" || !password) {
    throw httpError("Password is required.", 400);
  }

  requireDatabase(env);

  const user = await User.findOne({ email: normalizedEmail }).select("+password");
  if (!user) {
    throw httpError("User not found", 404);
  }

  if (!user.password || !(await verifyPassword(password, user.password))) {
    throw httpError("Invalid email or password", 401);
  }

  if ((user.status || "active") !== "active") {
    throw httpError("Your account has been suspended. Contact support.", 403);
  }
  user.lastLoginAt = new Date();
  user.lastActiveAt = user.lastLoginAt;
  await user.save();

  return createSession(user, env);
};

/** @param {{credential?: string}} credentials @param {any} env */
const verifyGoogleCredential = async ({ credential }, env) => {
  if (!credential) {
    throw httpError("Missing Google credential", 400);
  }

  try {
    googleClient ||= new OAuth2Client();
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      ...(env.googleClientId ? { audience: env.googleClientId } : {})
    });
    const payload = ticket.getPayload();

    if (payload?.email_verified === false) {
      throw httpError("Google account email is not verified.", 401);
    }

    return {
      googleId: payload?.sub,
      email: payload?.email,
      name: payload?.name || payload?.email?.split("@")[0],
      picture: payload?.picture || ""
    };
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError("Invalid Google token", 401);
  }
};

/** @param {{credential?: string}} [credentials] @param {any} [env] */
export const loginWithGoogle = async ({ credential } = {}, env) => {
  const googleProfile = await verifyGoogleCredential({ credential }, env);
  const normalizedEmail = normalizeEmail(googleProfile.email);

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw httpError("Google account did not return a valid email.", 400);
  }

  requireDatabase(env);

  let user = googleProfile.googleId ? await User.findOne({ googleId: googleProfile.googleId }) : null;
  user ||= await User.findOne({ email: normalizedEmail });

  if (!user) {
    user = await User.create({
      name: googleProfile.name || normalizedEmail.split("@")[0],
      email: normalizedEmail,
      googleId: googleProfile.googleId || undefined,
      avatar: googleProfile.picture || "",
      picture: googleProfile.picture || "",
      provider: "google"
    });
  } else {
    user.name = googleProfile.name || user.name;
    user.googleId = googleProfile.googleId || user.googleId;
    user.avatar = googleProfile.picture || user.avatar;
    user.picture = googleProfile.picture || user.picture;
    user.provider = user.provider === "password" ? "password+google" : "google";
    await user.save();
  }

  if ((user.status || "active") !== "active") {
    throw httpError("Your account has been suspended. Contact support.", 403);
  }

  return createSession(user, env);
};

/** @param {string} token @param {any} env */
export const getUserByToken = async (token, env) => {
  requireDatabase(env);

  const payload = verifyToken(token, env);
  const user = await User.findById(payload.userId);

  if (!user) {
    throw new Error("User not found");
  }

  if ((user.status || "active") !== "active") {
    throw httpError("Your account has been suspended. Contact support.", 403);
  }

  return safeUser(user);
};

/** @param {string} token @param {any} env */
export const refreshSessionByToken = async (token, env) => {
  const user = await getUserByToken(token, env);
  return createSession(user, env);
};
