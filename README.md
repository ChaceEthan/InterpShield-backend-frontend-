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
  .env
  .env.example
```

## Environment

Create a root `.env` file:

```bash
DEEPGRAM_API_KEY=
GEMINI_API_KEY=
GOOGLE_CLIENT_ID=
JWT_SECRET=replace_with_a_long_random_secret
JWT_ISSUER=interp-shield
CLIENT_ORIGIN=*
PORT=5000
MAX_SESSION_SECONDS=120
AUDIO_CHUNK_MS=700
DATA_DIR=.data
VITE_API_URL=http://localhost:5000
VITE_GOOGLE_CLIENT_ID=
```

`.env` and the default local `.data/` auth store are ignored by Git. Keep real API keys and secrets in `.env` only.

## Run Locally

```bash
npm install
npm run dev
```

Backend: `http://localhost:5000`

Frontend: `http://localhost:5173`

## Auth

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/google`
- `GET /api/auth/me`
- `POST /api/auth/logout`

Sessions use JWT bearer tokens. Dashboard, history, settings, and the interpreter socket require auth.

Google Sign-In uses Google Identity Services when `VITE_GOOGLE_CLIENT_ID` is set. The frontend opens the Google account picker, sends the Google credential JWT to `POST /api/auth/google`, and the backend verifies it with `GOOGLE_CLIENT_ID` before creating or updating the local JWT session.

## Real-Time Interpreter

Frontend emits:

- `session:start`
- `audio-chunk`
- `session:stop`

Backend emits:

- `server-config`
- `session:ready`
- `result`
- `warning`
- `app-error`
- `session:closed`

Audio chunks are streamed every `500ms` to `1000ms`. Final result payload:

```json
{
  "originalText": "Hello",
  "translatedText": "Hola",
  "isFinal": true
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

1. Set all root `.env` values in your hosting provider.
2. Use a strong `JWT_SECRET`.
3. Set `CLIENT_ORIGIN` to the deployed frontend origin.
4. Set `VITE_API_URL` to the deployed backend URL.
5. Configure Google OAuth and set both Google client ID variables.
6. Run `npm run build`.
7. Serve `frontend/dist` from your frontend host.
8. Run `npm run start` for the backend.

## Verification

```bash
npm run lint
npm run build
```
