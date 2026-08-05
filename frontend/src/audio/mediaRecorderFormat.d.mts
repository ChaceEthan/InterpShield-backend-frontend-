export const DEEPGRAM_MEDIA_RECORDER_MIME_TYPES: readonly string[];
export function selectDeepgramMediaRecorderMimeType(isTypeSupported: (mimeType: string) => boolean): { mimeType: string; support: Record<string, boolean> };
export function containerSignature(bytes: ArrayBuffer | Uint8Array): { valid: boolean; container: "webm" | "ogg" | "unknown"; hex: string };
