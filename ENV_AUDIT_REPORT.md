# InterpShield Environment Audit Report

Date: 2026-06-07

## Scope

Audited frontend and backend environment variables, production URLs, CORS origins, websocket URL compatibility, provider key presence, startup validation, and repository URL references.

Primary files:

- `frontend/.env`
- `frontend/.env.example`
- `backend/.env`
- `backend/.env.example`
- `backend/config/env.js`
- `backend/server.js`

## Findings

Frontend local production-style environment:

- `VITE_API_URL=https://interpshield-backend.onrender.com`
- `VITE_SOCKET_URL=https://interpshield-backend.onrender.com`
- `VITE_WS_URL=wss://interpshield-backend.onrender.com`
- `VITE_CLIENT_URL=https://interp-shield-backend-frontend-fron.vercel.app`
- `VITE_GOOGLE_CLIENT_ID` is set.
- Frontend debug flags are present and default to `false`.

Backend local production-style environment:

- `CLIENT_URL=https://interp-shield-backend-frontend-fron.vercel.app`
- `CORS_ORIGIN=https://interp-shield-backend-frontend-fron.vercel.app,https://interpshield.vercel.app`
- `JWT_SECRET`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, and `MONGO_URI` are set locally.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are not set in the local backend environment.
- Backend debug flags are documented in `.env.example` and default to `false`.

Repository URL search:

- No production env example points to `localhost` or `127.0.0.1`.
- Remaining `localhost` references are development allowlist and URL validation code.
- No stale Render backend URL was found beyond the active Render backend domain.

## Fixes Applied

- Added centralized backend startup diagnostics and fail-fast validation.
- Added frontend startup URL diagnostics and fail-fast session blocking when required URLs are invalid.
- Added explicit `VITE_WS_URL` documentation.
- Added backend `MAX_SESSION_SECONDS` documentation.
- Added backend and frontend debug flag documentation.
- Updated backend CORS example to include both the current Vercel frontend and custom production domain.
- Added backend Google client ID audience enforcement when `GOOGLE_CLIENT_ID` is configured.

## Startup Validation Rules

Backend now fails fast when:

- `CLIENT_URL` or `CORS_ORIGIN` is missing.
- A configured production origin is not HTTPS.
- `JWT_SECRET` is missing.
- `DEEPGRAM_API_KEY` is missing.
- `GEMINI_API_KEY` is missing.
- `PORT` is invalid.

Backend warns when:

- `OPENAI_API_KEY` is missing.
- Backend `GOOGLE_CLIENT_ID` is not configured.
- Backend `GOOGLE_CLIENT_SECRET` is not configured.

Frontend now blocks session start when:

- `VITE_API_URL` is missing or malformed.
- `VITE_SOCKET_URL`/`VITE_WS_URL` is missing or malformed.
- `VITE_CLIENT_URL` is missing or malformed.
- A production URL uses a non-secure protocol.

## Validation Results

- Masked env audit completed without exposing secrets.
- Local `/health`: HTTP 200 with config `ok: true`.
- Local `/health` showed allowed origins:
  - `https://interp-shield-backend-frontend-fron.vercel.app`
  - `https://interpshield.vercel.app`
- Local `/health` showed debug flags disabled by default.

## Remaining Deployment Validation

- Confirm Render environment variables match the audited local backend values.
- Configure backend `GOOGLE_CLIENT_ID` on Render if Google sign-in should enforce ID-token audience checks.
- Confirm Vercel environment variables match the audited frontend values for production.
