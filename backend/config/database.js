// @ts-nocheck
import mongoose from "mongoose";

mongoose.set("bufferCommands", false);

let connectionPromise = null;

export const getDatabaseStatus = () => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  return states[mongoose.connection.readyState] || "unknown";
};

export const connectDatabase = async (env) => {
  if (!env.mongoUri) {
    console.warn("MongoDB not connected because MONGO_URI is not set.");
    return null;
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  connectionPromise ||= mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10000
  });

  try {
    await connectionPromise;
  } catch (error) {
    connectionPromise = null;
    const message = error?.message || "Unknown MongoDB connection error.";
    throw new Error(`MongoDB connection failed: ${message}`);
  }

  return mongoose.connection;
};

export const requireDatabase = (env) => {
  if (!env.mongoUri) {
    const error = new Error("Database is not configured. Set MONGO_URI on the server.");
    error.statusCode = 503;
    throw error;
  }

  if (mongoose.connection.readyState !== 1) {
    const error = new Error("Database is not connected. Please try again in a moment.");
    error.statusCode = 503;
    throw error;
  }
};
