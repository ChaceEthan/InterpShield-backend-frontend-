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
    (error) => error.name === "TabAudioNoTrackError" && /audio/i.test(error.message),
    "no shared audio track produces a controlled error instead of silently recording silence"
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
assert.match(appSource, /activeAudioSource === "tab" \? await requestTabAudioStream\(navigator\.mediaDevices\) : await requestMicrophoneStream/, "desktop live sessions route tab/system audio through the same capture-then-record pipeline as the microphone");
assert.match(appSource, /activeAudioSource === "tab" && !isTabAudioCaptureSupported\(navigator\.mediaDevices\)/, "starting tab/system audio mode on an unsupported browser is rejected before requesting anything");
assert.match(appSource, /This browser does not support sharing tab or system audio\. Switch to Microphone mode to continue\./, "an unsupported browser gets a concise, actionable message rather than a silent failure");
assert.match(appSource, /<AudioSourceTabs activeSource=\{audioSource\} disabled=\{isRecording\} onChange=\{handleAudioSourceChange\} \/>/, "the Microphone / Tab & System Audio switch is rendered on the live screen");
assert.match(appSource, /isDesktopChrome\(\) && isTabAudioCaptureSupported\(typeof navigator !== "undefined" \? navigator\.mediaDevices : undefined\)/, "the source switch itself is only shown where the browser can actually honor it");

console.log("Tab/system audio capture regression tests passed.");
