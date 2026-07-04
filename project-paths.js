// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const expectedRuntimeDrive = "F:";

const resolveProjectRoot = () => {
  const configuredRoot = process.env.INTERPSHIELD_ROOT || process.env.PROJECT_ROOT || "";
  return path.resolve(configuredRoot || moduleRoot);
};

const resolveDriveRoot = (root) => {
  const parsed = path.parse(root);
  return parsed.root || root;
};

const isWindowsAbsolutePath = (value = "") => /^[a-z]:[\\/]/i.test(String(value || ""));
const isCDrivePath = (value = "") => /^c:[\\/]/i.test(path.resolve(value || "."));
const isExpectedDrivePath = (value = "") => {
  const resolved = path.resolve(value || ".");
  if (!isWindowsAbsolutePath(resolved)) return true;
  return resolved.toUpperCase().startsWith(`${expectedRuntimeDrive.toUpperCase()}\\`);
};

export const getProjectPaths = () => {
  const root = resolveProjectRoot();
  const fromRoot = (...segments) => path.resolve(root, ...segments);

  return {
    root,
    backendRoot: fromRoot("backend"),
    frontendRoot: fromRoot("frontend"),
    nodeModules: fromRoot("node_modules"),
    cacheRoot: fromRoot(".cache"),
    npmCache: fromRoot(".cache", "npm"),
    npmPrefix: fromRoot(".cache", "npm-prefix"),
    npmTemp: fromRoot(".cache", "npm-temp"),
    nodeGypCache: fromRoot(".cache", "node-gyp"),
    nodeCache: fromRoot(".cache", "node"),
    viteCache: fromRoot(".cache", "vite"),
    browserProfile: fromRoot(".browser-profile"),
    logs: fromRoot("logs"),
    npmLogs: fromRoot(".cache", "npm", "_logs"),
    uploads: fromRoot("uploads"),
    temp: fromRoot("temp"),
    npmTmp: fromRoot("temp", "npm"),
    runtime: fromRoot("runtime"),
    audioCache: fromRoot("audio-cache"),
    translationCache: fromRoot("translation-cache"),
    frontendDist: fromRoot("frontend", "dist"),
    rootDist: fromRoot("dist")
  };
};

export const projectPaths = getProjectPaths();

export const runtimeDirectoryKeys = [
  "cacheRoot",
  "npmCache",
  "npmPrefix",
  "npmTemp",
  "nodeGypCache",
  "nodeCache",
  "viteCache",
  "browserProfile",
  "logs",
  "npmLogs",
  "uploads",
  "temp",
  "npmTmp",
  "runtime",
  "audioCache",
  "translationCache"
];

export const ensureProjectDirectories = (paths = projectPaths) => {
  for (const key of runtimeDirectoryKeys) {
    try {
      fs.mkdirSync(paths[key], { recursive: true });
    } catch (err) {
      console.warn(`[PATH_WARNING] Failed to ensure directory ${paths[key]}:`, err.message);
    }
  }

  return paths;
};

export const validateProjectPaths = (paths = projectPaths) => {
  const warnings = [];

  if (!isExpectedDrivePath(paths.root)) {
    warnings.push(`Project root is not on ${expectedRuntimeDrive}: ${paths.root}`);
  }

  for (const [name, value] of Object.entries(paths)) {
    if (!isWindowsAbsolutePath(value)) continue;
    if (isCDrivePath(value)) warnings.push(`Runtime path ${name} points to C: ${value}`);
    if (!isExpectedDrivePath(value)) warnings.push(`Runtime path ${name} is not on ${expectedRuntimeDrive}: ${value}`);
  }

  return {
    ok: warnings.length === 0,
    expectedDrive: expectedRuntimeDrive,
    root: paths.root,
    warnings
  };
};

const redirectEnvPath = (name, value) => {
  if (!value) return;
  const currentValue = process.env[name] || "";
  if (!currentValue || isCDrivePath(currentValue) || !isExpectedDrivePath(currentValue)) {
    process.env[name] = value;
  }
};

export const configureProjectRuntimePaths = (paths = projectPaths) => {
  ensureProjectDirectories(paths);

  process.env.INTERPSHIELD_ROOT = paths.root;
  redirectEnvPath("TEMP", paths.temp);
  redirectEnvPath("TMP", paths.temp);
  redirectEnvPath("TMPDIR", paths.temp);
  redirectEnvPath("npm_config_cache", paths.npmCache);
  redirectEnvPath("npm_config_prefix", paths.npmPrefix);
  redirectEnvPath("npm_config_tmp", paths.npmTemp);
  redirectEnvPath("npm_config_devdir", paths.nodeGypCache);
  redirectEnvPath("npm_config_logs_dir", paths.npmLogs);
  redirectEnvPath("VITE_CACHE_DIR", paths.viteCache);
  redirectEnvPath("NODE_COMPILE_CACHE", paths.nodeCache);
  redirectEnvPath("INTERPSHIELD_LOG_DIR", paths.logs);
  redirectEnvPath("INTERPSHIELD_UPLOAD_DIR", paths.uploads);
  redirectEnvPath("INTERPSHIELD_RUNTIME_DIR", paths.runtime);
  redirectEnvPath("INTERPSHIELD_AUDIO_CACHE_DIR", paths.audioCache);
  redirectEnvPath("INTERPSHIELD_TRANSLATION_CACHE_DIR", paths.translationCache);

  return validateProjectPaths(paths);
};
