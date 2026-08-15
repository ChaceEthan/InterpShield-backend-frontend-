import assert from "node:assert/strict";
import { DEEPGRAM_MEDIA_RECORDER_MIME_TYPES, containerSignature, selectDeepgramMediaRecorderMimeType } from "../src/audio/mediaRecorderFormat.mjs";

assert.deepEqual(DEEPGRAM_MEDIA_RECORDER_MIME_TYPES, ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);
const selected = selectDeepgramMediaRecorderMimeType((mimeType) => mimeType === "audio/webm" || mimeType === "audio/ogg;codecs=opus");
assert.equal(selected.mimeType, "audio/webm", "selection must follow the supported preference order");
assert.throws(() => selectDeepgramMediaRecorderMimeType(() => false), /does not support/);
assert.equal(containerSignature(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])).container, "webm");
assert.equal(containerSignature(Uint8Array.from([0x4f, 0x67, 0x67, 0x53])).container, "ogg");
assert.equal(containerSignature(Uint8Array.from([0x1f, 0x43, 0xb6, 0x75])).valid, false, "a middle WebM cluster is not a fresh container header");

// The exact byte sequence from the real production AUDIO_CONTAINER_HEADER_INVALID log:
// "45 df a3 9f 42 86 81 01 42 f7 81 01 42 f2 81 04" is precisely the true EBML header
// "1a 45 df a3 9f 42 86 81 01 42 f7 81 01 42 f2 81 04" with only its leading 0x1a byte
// missing — a fully valid, well-formed EBML header/EBMLVersion/EBMLReadVersion/
// EBMLMaxIDLength sequence shifted by exactly one byte. containerSignature correctly rejects
// this (it is not byte-0-of-file), confirming the validation logic itself is correct: the bug
// was upstream, in a chunk that legitimately held the true first bytes being dropped before
// this check ever saw it (see App.tsx's awaitingContainerHeaderRef exemptions).
assert.equal(
  containerSignature(Uint8Array.from([0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04])).valid,
  false,
  "a header shifted by exactly one missing leading byte is correctly still rejected"
);
assert.equal(
  containerSignature(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04])).valid,
  true,
  "the same bytes with the leading 0x1a restored are correctly accepted as a valid EBML header"
);
// A genuinely tiny header-only chunk (just the 4-byte EBML ID, no size/sub-elements yet) must
// still validate successfully — the fix must never require a minimum chunk size to recognize a
// real header, since MediaRecorder can legitimately flush the header alone as a very small blob.
assert.equal(containerSignature(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])).valid, true, "a minimal 4-byte EBML header alone is still recognized as valid");
