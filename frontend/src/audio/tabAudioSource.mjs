export const isTabAudioCaptureSupported = (mediaDevices) =>
  typeof mediaDevices?.getDisplayMedia === "function";

// getDisplayMedia requires requesting a video track for Chrome to reliably offer the
// "Share tab audio" checkbox; only the audio track is ever forwarded to the recorder/backend.
// createMediaStream is injected so this stays testable without a real MediaStream constructor.
export const requestTabAudioStream = async (mediaDevices, createMediaStream = (tracks) => new MediaStream(tracks)) => {
  if (!isTabAudioCaptureSupported(mediaDevices)) {
    const error = new Error("This browser does not support sharing tab or system audio.");
    error.name = "TabAudioUnsupportedError";
    throw error;
  }

  const displayStream = await mediaDevices.getDisplayMedia({ video: true, audio: true });
  const audioTracks = displayStream.getAudioTracks();
  for (const track of displayStream.getVideoTracks()) track.stop();

  if (audioTracks.length === 0) {
    const error = new Error('No audio was shared. Reopen the picker and enable "Share tab audio" (or share a screen/window with audio).');
    error.name = "TabAudioNoTrackError";
    throw error;
  }

  return createMediaStream(audioTracks);
};
