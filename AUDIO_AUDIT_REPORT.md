# InterpShield Audio Audit Report

Date: 2026-06-07

## Scope

Audited the browser microphone startup path, `MediaRecorder` creation, audio chunk streaming, websocket audio transport, and backend audio chunk acceptance diagnostics.

Primary files:

- `frontend/src/App.tsx`
- `frontend/src/components/StatusBar.tsx`
- `frontend/src/components/TranslationPanel.tsx`
- `backend/services/audioPipeline.js`

## Root Causes Found

1. A saved microphone `deviceId` was used as an exact constraint. If the browser remembered a device that was removed, renamed, denied, or not available in the current browser profile, `getUserMedia()` could fail before falling back to the default microphone.

2. `MediaRecorder` was constructed against the preferred enhanced WebAudio stream and preferred MIME type without a resilient browser matrix. Safari, Firefox, and some Chromium profiles can reject supported-looking MIME combinations at construction time.

3. Unexpected recorder stops, track endings, and recorder errors surfaced as a terminal microphone failure instead of attempting a bounded recovery.

4. Backend audio chunk filtering already protected Deepgram from tiny, silent, or duplicate chunks, but production had limited diagnostics for understanding whether chunks were accepted or dropped.

## Fixes Applied

- Added default microphone fallback when exact device constraints fail.
- Added `MediaRecorder` construction fallback across enhanced/raw streams and browser-compatible MIME types.
- Added bounded automatic microphone recovery for ended tracks, recorder errors, and unexpected recorder stops.
- Added frontend microphone diagnostic state and surfaced it in the existing status bar without redesigning the UI.
- Added frontend audio debug logging controlled by `VITE_AUDIO_DEBUG`.
- Added backend audio debug logging controlled by `AUDIO_DEBUG`, including accepted chunk cadence and drop reasons.
- Preserved existing audio chunk timing and language behavior.

## Reliability Impact

- A stale saved mic no longer blocks all realtime audio.
- Safari-compatible MIME fallback is available through `audio/mp4` when supported.
- Chrome and Firefox remain covered through `audio/webm` and `audio/ogg` candidates.
- A transient audio device interruption now attempts recovery without ending the full translation session.

## Validation Results

- `npm run build`: passed.
- `npm run lint`: passed.
- Local `/health/audio`: HTTP 200.
- Local health payload showed audio health endpoint available with chunk counters.
- Browser-level microphone permission testing was not executable in this shell because it cannot grant browser mic permissions and `agent-browser` is not installed.

## Remaining Deployment Validation

- Perform a real browser microphone test on the deployed frontend in Chrome, Safari, Firefox, and a mobile browser.
- Run at least one 60+ minute mic streaming soak against the deployed backend with `AUDIO_DEBUG=true` for the test window only.
