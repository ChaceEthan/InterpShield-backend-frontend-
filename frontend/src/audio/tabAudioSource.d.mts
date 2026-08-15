export function isTabAudioCaptureSupported(mediaDevices: Pick<MediaDevices, "getDisplayMedia"> | null | undefined): boolean;
export function requestTabAudioStream(
  mediaDevices: Pick<MediaDevices, "getDisplayMedia"> | null | undefined,
  createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream
): Promise<MediaStream>;
