import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isTabAudioCaptureSupported, requestTabAudioStream } from "../src/audio/tabAudioSource.mjs";

const fakeTrack = (kind) => {
  let stopped = false;
  return { kind, stop() { stopped = true; }, get stopped() { return stopped; } };
};

// Unsupported browser: no getDisplayMedia at all.
assert.equal(isTabAudioCaptureSupported(undefined), false, "no mediaDevices means tab/system audio is unsupported");
assert.equal(isTabAudioCaptureSupported({}), false, "mediaDevices without getDisplayMedia means tab/system audio is unsupported");
assert.equal(isTabAudioCaptureSupported({ getDisplayMedia: async () => null }), true, "a real getDisplayMedia implementation is detected as supported");

await assert.rejects(
  () => requestTabAudioStream(undefined),
  (error) => error.name === "TabAudioUnsupportedError",
  "requesting tab audio on an unsupported browser throws a controlled, named error instead of crashing"
);

// Supported browser, user picks a tab and enables "Share tab audio": only the audio track
// must reach the caller, and the video track (required only so Chrome offers the audio
// checkbox) must never be exposed to the recorder/backend pipeline.
{
  const videoTrack = fakeTrack("video");
  const audioTrack = fakeTrack("audio");
  const mediaDevices = {
    async getDisplayMedia(constraints) {
      assert.equal(constraints.video, true, "video must be requested so Chrome offers the tab-audio checkbox");
      assert.equal(constraints.audio, true, "audio must be requested");
      return { getAudioTracks: () => [audioTrack], getVideoTracks: () => [videoTrack] };
    }
  };
  const createdStreams = [];
  const stream = await requestTabAudioStream(mediaDevices, (tracks) => {
    createdStreams.push(tracks);
    return { tracks };
  });
  assert.deepEqual(stream.tracks, [audioTrack], "only the audio track is forwarded into the capture pipeline");
  assert.equal(createdStreams.length, 1, "exactly one audio-only stream is built from the shared tab");
  assert.equal(videoTrack.stopped, true, "the video track is stopped immediately and never sent to STT/backend");
  assert.equal(audioTrack.stopped, false, "the audio track stays live for capture");
}

// User shares a tab but leaves "Share tab audio" unchecked: no audio track exists, so this
// must fail with a controlled, actionable error rather than silently recording zero audio.
{
  const videoTrack = fakeTrack("video");
  const mediaDevices = {
    async getDisplayMedia() {
      return { getAudioTracks: () => [], getVideoTracks: () => [videoTrack] };
    }
  };
  await assert.rejects(
    () => requestTabAudioStream(mediaDevices),
    (error) => error.name === "TabAudioNoTrackError" && error.message === "Shared source has no audio. Select the browser tab containing the video and enable Share tab audio.",
    "no shared audio track produces the exact required controlled error message instead of silently recording silence"
  );
  assert.equal(videoTrack.stopped, true, "the video track is released even when no audio was shared");
}

// The picker being cancelled (or the OS blocking capture) surfaces as a normal rejected
// promise from getDisplayMedia; requestTabAudioStream must propagate it, not swallow it.
{
  const mediaDevices = {
    async getDisplayMedia() {
      const error = new DOMException("Permission denied", "NotAllowedError");
      throw error;
    }
  };
  await assert.rejects(
    () => requestTabAudioStream(mediaDevices),
    (error) => error.name === "NotAllowedError",
    "a cancelled share picker propagates as a real error for the UI to display"
  );
}

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(appSource, /import \{ isTabAudioCaptureSupported, requestTabAudioStream \} from "\.\/audio\/tabAudioSource\.mjs"/, "App.tsx wires the live session to the tested tab-audio module");
assert.match(appSource, /if \(activeAudioSource === "tab"\) \{\s*console\.info\("\[GET_DISPLAY_MEDIA_REQUEST\]"/, "tab mode calls getDisplayMedia (via requestTabAudioStream), never getUserMedia, for the actual STT input");
assert.match(appSource, /stream = await requestTabAudioStream\(navigator\.mediaDevices\);/, "the tab branch acquires its stream through the tested tab-audio module");
assert.match(appSource, /stream = await requestMicrophoneStream\(audio, fallbackAudio\);/, "the microphone branch acquires its stream through getUserMedia, never getDisplayMedia");
assert.match(appSource, /console\.info\("\[GET_DISPLAY_MEDIA_SUCCESS\]", \{ recordingGeneration, audioTracks: stream\.getAudioTracks\(\)\.length \}\);/, "a successful tab-audio acquisition is logged with track counts only, no stream contents");
assert.match(appSource, /console\.info\("\[GET_USER_MEDIA_SUCCESS\]", \{ recordingGeneration, audioTracks: stream\.getAudioTracks\(\)\.length \}\);/, "a successful microphone acquisition is logged the same way");
assert.match(appSource, /console\.error\("\[GET_DISPLAY_MEDIA_ERROR\]"/, "a failed tab-audio acquisition is logged without swallowing the error");
assert.match(appSource, /console\.error\("\[GET_USER_MEDIA_ERROR\]"/, "a failed microphone acquisition is logged without swallowing the error");
assert.match(appSource, /activeAudioSource === "tab" && !isTabAudioCaptureSupported\(navigator\.mediaDevices\)/, "starting tab/system audio mode on an unsupported browser is rejected before requesting anything");
assert.match(appSource, /This browser does not support sharing tab or system audio\. Switch to Microphone mode to continue\./, "an unsupported browser gets a concise, actionable message rather than a silent failure");
assert.match(appSource, /<AudioSourceTabs activeSource=\{audioSource\} disabled=\{isRecording\} onChange=\{handleAudioSourceChange\} \/>/, "the Microphone / Tab & System Audio switch is rendered on the live screen");
assert.match(appSource, /isDesktopChrome\(\) && isTabAudioCaptureSupported\(typeof navigator !== "undefined" \? navigator\.mediaDevices : undefined\)/, "the source switch itself is only shown where the browser can actually honor it");

// D: when the user stops sharing the tab/screen from Chrome's own UI, the audio track's
// `ended` event must trigger a real, visible cleanup — not leave the session hanging in
// "Listening"/"Translating" forever.
assert.match(appSource, /track\.onended = \(\) => \{/, "the shared audio track's ended event is handled");
assert.match(appSource, /console\.info\("\[TAB_AUDIO_CAPTURE\]", \{\s*event: "track_ended",\s*audioTracks: stream\.getAudioTracks\(\)\.length,\s*trackReadyState: track\.readyState,\s*muted: track\.muted,\s*enabled: track\.enabled\s*\}\);/, "ending the shared source logs track diagnostics without any sensitive data");
assert.match(appSource, /scheduleAudioRecovery\("track_ended"\);\s*\};\s*\}/, "track ended routes through the same controlled recovery path used for any other capture failure, which fully cleans up and returns to idle");
assert.match(appSource, /isTabSource \? "Tab\/system audio sharing stopped unexpectedly\." : "Microphone stopped unexpectedly\."/, "the recovery message correctly names the tab/system audio source instead of always blaming the microphone");

// E: after a Tab/System Audio session ends (however it ended), starting a fresh Microphone
// session must not be blocked by any leftover tab-session state — startSession() always
// re-reads the currently selected source and re-initializes every generation-scoped ref.
assert.match(appSource, /const activeAudioSource = audioSourceRef\.current;/, "each new session re-reads the current source selection instead of reusing a stale one");
assert.match(appSource, /const recordingGeneration = activeRecordingGenerationRef\.current \+ 1;/, "every explicit Start (mic or tab, in either order) begins a fresh, independent generation");

console.log("Tab/system audio capture regression tests passed.");
