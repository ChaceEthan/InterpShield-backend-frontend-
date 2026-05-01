import bcrypt from "bcrypt";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import { requireDatabase } from "../config/database.js";
import User from "../models/User.js";

const MIN_PASSWORD_LENGTH = 6;
const BCRYPT_SALT_ROUNDS = 12;

let googleClient = null;

const normalizeEmail = (email) => email?.trim().toLowerCase();

export const httpError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const requireJwtSecret = (env) => {
  if (!env.jwtSecret) {
    throw httpError("JWT_SECRET is not configured on the server.", 503);
  }
};

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

const isBcryptHash = (storedHash) => storedHash?.startsWith("$2a$") || storedHash?.startsWith("$2b$") || storedHash?.startsWith("$2y$");

const verifyPassword = async (password, storedHash) => {
  if (!storedHash) return false;
  if (!isBcryptHash(storedHash)) return false;
  return bcrypt.compare(password, storedHash);
};

const toId = (value) => value?._id?.toString?.() || value?.id || value?.toString?.() || "";

export const safeUser = (user) => ({
  id: toId(user),
  name: user.name,
  email: user.email,
  avatar: user.avatar || user.picture || "",
  picture: user.picture || user.avatar || "",
  plan: user.plan || "free",
  provider: user.provider || "password",
  settings: user.settings || {
    privateMode: true,
    shareableMode: false,
    preferredSourceLang: "en",
    preferredTargetLang: "es"
  },
  createdAt: user.createdAt?.toISOString?.() || user.createdAt
});

export const signToken = (user, env) => {
  requireJwtSecret(env);

  return jwt.sign({ userId: toId(user) }, env.jwtSecret, { expiresIn: "7d" });
};

export const verifyToken = (token, env) => {
  requireJwtSecret(env);

  return jwt.verify(token, env.jwtSecret);
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

  return createSession(user, env);
};

const verifyGoogleCredential = async ({ credential }, env) => {
  if (!credential) {
    throw httpError("Missing Google credential", 400);
  }

  try {
    googleClient ||= new OAuth2Client();
    const ticket = await googleClient.verifyIdToken({
      idToken: credential
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

  return createSession(user, env);
};

export const getUserByToken = async (token, env) => {
  requireDatabase(env);

  const payload = verifyToken(token, env);
  const user = await User.findById(payload.userId);

  if (!user) {
    throw new Error("User not found");
  }

  return safeUser(user);
};
