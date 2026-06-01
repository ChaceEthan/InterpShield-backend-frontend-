# InterpShield Path Audit Report

Date: 2026-06-01

## Workspace Audited

- Requested path: `F:\InterpShield`
- Result: not found on this machine.
- Active project path audited and fixed: `F:\InterpShield-backend-frontend 2`
- Git remote: `https://github.com/ChaceEthan/InterpShield-backend-frontend-.git`

## Detected Path Issues

| Area | Old path or behavior | Affected file | Risk |
| --- | --- | --- | --- |
| npm cache | `.npm-cache` | `.npmrc`, `.gitignore` | Legacy cache location outside the new unified `.cache` layout. |
| npm logs | npm default or old cache log location | `.npmrc` | Logs could drift to npm defaults if cache config changes. |
| Vite cache | implicit `frontend/node_modules/.vite` | `frontend/vite.config.ts` | Vite cache was not explicitly project-managed. |
| Node temp | inherited OS defaults such as `TEMP`/`TMP` | backend startup environment | Node subprocesses could use user temp folders on C:. |
| Node compile/cache | inherited OS defaults or unset | backend startup environment | Runtime cache path was not centralized. |
| Runtime directories | no central definitions for logs, uploads, temp, runtime, audio cache, translation cache | backend config and scripts | Future writes could accidentally use OS defaults. |
| Build output | manually computed `frontend/dist` and `dist` | `scripts/sync-frontend-dist.mjs`, `frontend/vite.config.ts` | Build paths were duplicated instead of centralized. |
| Browser profile cache | `.browser-profile` existed but was not centrally defined | project root | Local browser cache was project-local but not documented in runtime paths. |
| Hardcoded C/AppData/Temp paths | none found in source after audit | all source files | No direct C-drive hardcoded write path remained. |

## Required Search Results

The repository was searched for:

- `C:\`
- `C:/`
- `AppData`
- `Temp`
- `os.tmpdir()`
- `process.env.TEMP`
- `process.env.TMP`
- `process.env.APPDATA`

No unsafe source references remain. The only remaining `TEMP`/`TMP` strings are intentional redirects in `project-paths.js` that force those environment variables to project-local `temp`.

## Runtime Paths After Audit

All project-managed runtime paths now resolve under the active F-drive workspace:

- `F:\InterpShield-backend-frontend 2\node_modules`
- `F:\InterpShield-backend-frontend 2\.cache`
- `F:\InterpShield-backend-frontend 2\.cache\npm`
- `F:\InterpShield-backend-frontend 2\.cache\vite`
- `F:\InterpShield-backend-frontend 2\.cache\node`
- `F:\InterpShield-backend-frontend 2\logs`
- `F:\InterpShield-backend-frontend 2\logs\npm`
- `F:\InterpShield-backend-frontend 2\uploads`
- `F:\InterpShield-backend-frontend 2\temp`
- `F:\InterpShield-backend-frontend 2\runtime`
- `F:\InterpShield-backend-frontend 2\audio-cache`
- `F:\InterpShield-backend-frontend 2\translation-cache`
- `F:\InterpShield-backend-frontend 2\frontend\dist`
- `F:\InterpShield-backend-frontend 2\dist`

## Notes

- The older generated `.npm-cache` directory was removed after migration to `.cache\npm`.
- Backend translation cache and audio cache are currently in-memory, but project-local directories now exist and are exported for future file-backed use.
- Startup validation warns if the project root or any managed runtime path points outside `F:`.
