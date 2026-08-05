export const DEEPGRAM_MEDIA_RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus"
];

export const selectDeepgramMediaRecorderMimeType = (isTypeSupported) => {
  if (typeof isTypeSupported !== "function") throw new Error("MediaRecorder MIME support detection is unavailable.");
  const support = Object.fromEntries(DEEPGRAM_MEDIA_RECORDER_MIME_TYPES.map((mimeType) => [mimeType, Boolean(isTypeSupported(mimeType))]));
  const mimeType = DEEPGRAM_MEDIA_RECORDER_MIME_TYPES.find((candidate) => support[candidate]);
  if (!mimeType) throw new Error("This browser does not support a Deepgram-compatible Opus recording format.");
  return { mimeType, support };
};

export const containerSignature = (bytes) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const isWebm = view.length >= 4 && view[0] === 0x1a && view[1] === 0x45 && view[2] === 0xdf && view[3] === 0xa3;
  const isOgg = view.length >= 4 && view[0] === 0x4f && view[1] === 0x67 && view[2] === 0x67 && view[3] === 0x53;
  return { valid: isWebm || isOgg, container: isWebm ? "webm" : isOgg ? "ogg" : "unknown", hex: [...view.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ") };
};
