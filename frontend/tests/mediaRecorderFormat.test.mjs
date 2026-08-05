import assert from "node:assert/strict";
import { DEEPGRAM_MEDIA_RECORDER_MIME_TYPES, containerSignature, selectDeepgramMediaRecorderMimeType } from "../src/audio/mediaRecorderFormat.mjs";

assert.deepEqual(DEEPGRAM_MEDIA_RECORDER_MIME_TYPES, ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);
const selected = selectDeepgramMediaRecorderMimeType((mimeType) => mimeType === "audio/webm" || mimeType === "audio/ogg;codecs=opus");
assert.equal(selected.mimeType, "audio/webm", "selection must follow the supported preference order");
assert.throws(() => selectDeepgramMediaRecorderMimeType(() => false), /does not support/);
assert.equal(containerSignature(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])).container, "webm");
assert.equal(containerSignature(Uint8Array.from([0x4f, 0x67, 0x67, 0x53])).container, "ogg");
assert.equal(containerSignature(Uint8Array.from([0x1f, 0x43, 0xb6, 0x75])).valid, false, "a middle WebM cluster is not a fresh container header");
