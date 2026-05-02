# InterpShield

Production-ready AI live interpreter SaaS built with React, Vite, Express, Socket.io, Deepgram, Gemini, JWT auth, Google Sign-In, and Capacitor Android.

## Product Flow

```text
Landing -> Signup/Login/Google -> Dashboard -> Microphone -> Deepgram STT -> Gemini translation -> live subtitles
```

Deepgram is used for streaming speech-to-text only. Gemini is used for translation only.

## Structure

```text
interp-shield/
  backend/
    config/
      env.js
    routes/
      auth.js
      user.js
    services/
      authService.js
      userService.js
      deepgram.js
      gemini.js
      interpreter.js
    sockets/
      interpreterSocket.js
    server.js
  frontend/
    src/
      App.tsx
      main.tsx
      index.css
  android/
  capacitor.config.ts
```

## Environment

Use layer-specific env files. Do not use a root `.env`.

Backend local file: `backend/.env`

```bash
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/interpshield
JWT_SECRET=replace_with_a_long_random_secret
DEEPGRAM_API_KEY=
GEMINI_API_KEY=
CLIENT_URL=http://localhost:5173,https://interpshield.vercel.app,https://interp-shield-backend-frontend-frontend-8akv4lq3k.vercel.app
```

Frontend local file: `frontend/.env`

```bash
VITE_API_URL=https://interpshield-backend.onrender.com
VITE_GOOGLE_CLIENT_ID=
```

`.env` files are ignored by Git. Keep real API keys and secrets in layer-specific `.env` files or hosting provider env settings only.

## Run Locally

```bash
npm install
npm run dev
```

Backend: `http://localhost:10000` by default, or the value of `PORT` when one is provided by the host.

Frontend: `http://localhost:5173`

## Auth

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/google`
- `GET /api/auth/me`
- `POST /api/auth/logout`

Sessions use JWT bearer tokens. Dashboard, history, settings, and the interpreter socket require auth.

Google Sign-In uses Google Identity Services when `VITE_GOOGLE_CLIENT_ID` is set. The frontend opens the Google account picker, sends the Google credential JWT to `POST /api/auth/google`, and the backend verifies it before creating or updating the local JWT session.

Authorized JavaScript origins in Google Cloud Console:

- `http://localhost:5173`
- `https://interpshield.vercel.app`
- `https://interp-shield-backend-frontend-frontend-8akv4lq3k.vercel.app`

## Real-Time Interpreter

Frontend emits:

- `start_session`
- `audio_chunk`
- `end_session`

Backend emits:

- `server-config`
- `session_ready`
- `transcript_partial`
- `transcript_final`
- `translation_update`
- `warning`
- `session_error`
- `session:closed`

Audio chunks are streamed every `500ms` to `1000ms` using Socket.io binary payloads. Final transcript payload:

```json
{
  "text": "Hello",
  "sourceLang": "en",
  "targetLang": "es",
  "latencyMs": 120
}
```

## SaaS Features

- Landing page
- Signup/Login
- Google Sign-In
- Protected dashboard
- Get Pro upgrade UI
- Pricing page
- History page
- Help page
- Settings menu
- Private mode and shareable mode toggles
- Transcribe, Translate, and Dubbing tool modes
- Speaker and translation language selectors
- Two-way translation toggle
- 2 minute live session limit
- Clean dashboard UI with user-facing offline and microphone fallback messages

## Android / APK

Capacitor is configured with `webDir: frontend/dist` and an Android project is included.

```bash
npm run android:sync
npm run android:open
```

Build APK from Android Studio, or run:

```bash
npm run android:build
```

Android microphone permissions are declared in `android/app/src/main/AndroidManifest.xml`.

For a physical Android device, set `VITE_API_URL` to a reachable HTTPS production backend or a LAN development URL.

## Production Deployment

1. Set backend env values in Render.
2. Use a strong `JWT_SECRET`.
3. Set `CLIENT_URL` to `http://localhost:5173,https://interpshield.vercel.app,https://interp-shield-backend-frontend-frontend-8akv4lq3k.vercel.app`.
4. Set frontend env values in Vercel.
5. Set `VITE_API_URL` to `https://interpshield-backend.onrender.com`.
6. Configure Google OAuth and set `VITE_GOOGLE_CLIENT_ID` in the frontend environment.
7. Run `npm run build`.
8. Serve `frontend/dist` from your frontend host.
9. Run `npm run start` for the backend.

## Verification

```bash
npm run lint
npm run build
```
