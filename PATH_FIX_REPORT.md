# InterpShield Path Fix Report

Date: 2026-06-01

## Summary

Runtime path management was centralized so backend, frontend, npm, Vite, logs, temp files, uploads, runtime files, audio cache, translation cache, and build output paths are project-local under the active F-drive workspace.

## Fixes Applied

| Affected file | Old path or behavior | New path or behavior | Fix applied |
| --- | --- | --- | --- |
| `project-paths.js` | No central path registry | Project-local paths under `process.env.INTERPSHIELD_ROOT` or the repo root | Added shared path resolver, directory creation, environment redirection, and F-drive validation. |
| `backend/config/env.js` | Backend startup did not validate or redirect runtime paths | Uses `configureProjectRuntimePaths()` during config load | Creates required directories, redirects temp/cache/log env vars, and warns on unsafe paths. |
| `.npmrc` | `cache=.npm-cache` | `cache=.cache/npm`, `logs-dir=logs/npm` | Moved npm cache and npm logs into the unified project-local runtime layout. |
| `.gitignore` | Ignored `.npm-cache`; did not ignore new runtime folders | Ignores `.cache`, `logs`, `uploads`, `temp`, `runtime`, `audio-cache`, `translation-cache`, `frontend/dist` | Prevents runtime-generated files from being committed. |
| `frontend/vite.config.ts` | Vite cache path implicit; build output path implicit | `cacheDir` uses `.cache/vite`; `build.outDir` uses centralized `frontend/dist` | Forces Vite cache and build output to F-drive project paths. |
| `scripts/sync-frontend-dist.mjs` | Local path math duplicated in script | Uses `project-paths.js` | Keeps root `dist` sync tied to centralized build paths. |
| `package.json` | Root lint/build did not validate path module syntax | `node --check project-paths.js` runs before lint/build | Adds syntax coverage for the new path management module. |
| `backend/.env.example` | No documented root override | `INTERPSHIELD_ROOT=F:\InterpShield` | Documents optional explicit runtime root for deployments or renamed workspaces. |
| Generated cache | Existing `.npm-cache` directory | Removed; replaced by `.cache/npm` | Cleaned up legacy generated cache location. |
| Generated Vite cache | Existing `frontend\node_modules\.vite` directory | Removed; replaced by `.cache\vite` | Cleaned up stale generated Vite cache location. |

## Directories Created Automatically

Startup and Vite config now create these directories as needed:

- `.cache`
- `.cache\npm`
- `.cache\node`
- `.cache\vite`
- `.browser-profile`
- `logs`
- `logs\npm`
- `uploads`
- `temp`
- `temp\npm`
- `runtime`
- `audio-cache`
- `translation-cache`

## Validation Rules Added

- Verify the project root is on `F:`.
- Warn if any centralized runtime path points to `C:`.
- Warn if any centralized runtime path points outside `F:`.
- Redirect `TEMP`, `TMP`, `TMPDIR`, `npm_config_cache`, `npm_config_logs_dir`, `VITE_CACHE_DIR`, `NODE_COMPILE_CACHE`, and InterpShield runtime path variables to project-local F-drive locations.

## Remaining Notes

- `F:\InterpShield` was requested but does not exist on this machine. The implementation is portable: if this repo is moved or `INTERPSHIELD_ROOT` is set to `F:\InterpShield`, the same centralized paths resolve there.
- No source hardcoded `C:\`, `AppData`, `os.tmpdir()`, `process.env.APPDATA`, or unsafe temp usage remains.
