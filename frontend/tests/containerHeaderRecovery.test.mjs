import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

// ROOT CAUSE: MediaRecorder's WebM muxer can legitimately flush the EBML header alone as a very
// small (sometimes just a few bytes) blob before any audio cluster exists — the exact real
// production signature "45 df a3 9f 42 86 81 01 42 f7 81 01 42 f2 81 04" is the true header
// shifted by exactly one missing leading byte (see mediaRecorderFormat.test.mjs). Two existing
// filters ran BEFORE the header-validity check and could silently drop that genuinely-first,
// header-bearing chunk: the MIN_MEDIA_CHUNK_BYTES size filter (a header-only chunk can be small),
// and the MIN_AUDIO_CHUNK_INTERVAL_MS throttle (a fast recorder restart, including the retry path
// itself, can leave the timestamps close together). Once dropped, awaitingContainerHeaderRef
// stayed true for the NEXT chunk — which genuinely is not byte-0-of-file anymore — so the
// signature check correctly, but misleadingly, reported it as invalid.
const ondataavailableStart = appSource.indexOf("recorder.ondataavailable = async (event) => {");
const ondataavailableEnd = appSource.indexOf("recorder.onerror = ");
assert.ok(ondataavailableStart > -1 && ondataavailableEnd > ondataavailableStart, "the ondataavailable handler is found");
const ondataavailableBody = appSource.slice(ondataavailableStart, ondataavailableEnd);

assert.match(
  ondataavailableBody,
  /if \(!awaitingContainerHeaderRef\.current && event\.data\.size < MIN_MEDIA_CHUNK_BYTES\) return;/,
  "the small-chunk filter is exempted while still awaiting this generation's container header, so a genuinely tiny header-only chunk is never silently dropped before validation"
);
assert.match(
  ondataavailableBody,
  /if \(!awaitingContainerHeaderRef\.current && elapsedSinceLastChunk < MIN_AUDIO_CHUNK_INTERVAL_MS && audioLevel < 0\.002\) return;/,
  "the inter-chunk throttle is exempted while still awaiting the container header, so a fast recorder restart cannot swallow the new generation's true first chunk either"
);
assert.doesNotMatch(
  ondataavailableBody,
  /if \(event\.data\.size < MIN_MEDIA_CHUNK_BYTES\) return;\s*\n\s*if \(isDesktopChrome/,
  "the old unconditional size filter (dropping every small chunk, including a legitimate header-only one) is gone"
);

// A single failed header probe must not, by itself, stop/restart MediaRecorder: a fast chunk
// boundary can legitimately leave one chunk not starting at byte 0 without any real corruption.
// Only a SECOND consecutive failure for the same generation escalates to the existing bounded
// stop/restart recovery path — genuine, sustained container corruption still fails immediately
// on that very next probe too, so it remains just as reliably caught as before.
assert.match(appSource, /const containerHeaderProbeFailuresRef = useRef\(0\);/, "a dedicated counter tracks consecutive header-probe failures, separate from the actual stop/restart retry count");
assert.match(
  ondataavailableBody,
  /containerHeaderProbeFailuresRef\.current \+= 1;[\s\S]{0,1400}?if \(containerHeaderProbeFailuresRef\.current < 2\) return;/,
  "the first header-probe failure for a generation only skips that one chunk (no stop/restart) and waits for the next chunk to be evaluated fresh"
);
assert.match(
  ondataavailableBody,
  /if \(isDesktopChrome\(\) && containerHeaderRetryCountRef\.current < MAX_CONTAINER_HEADER_RETRIES && recordingRef\.current && !explicitStopRequestedRef\.current\) \{/,
  "the existing bounded stop/restart recovery mechanism for a genuinely invalid generation is preserved, unreached until the second consecutive failure"
);
assert.match(
  ondataavailableBody,
  /scheduleAudioRecovery\("container_header_missing"\);/,
  "unrecoverable container corruption (exhausted retries) still falls through to full audio recovery, unchanged"
);

// The probe-failure counter is reset alongside every point that legitimately starts a fresh
// generation's header wait, so a later generation is never penalized by an earlier one's history.
assert.match(appSource, /containerHeaderRetryCountRef\.current = 0;\s*containerHeaderProbeFailuresRef\.current = 0;/, "the probe-failure counter resets alongside the retry counter at session start");
assert.match(appSource, /awaitingContainerHeaderRef\.current = true;\s*containerHeaderProbeFailuresRef\.current = 0;\s*recorderGenerationRestartRef\.current = false;/, "the probe-failure counter resets when a Deepgram-triggered generation change re-arms the header wait on an inactive recorder");
assert.match(appSource, /awaitingContainerHeaderRef\.current = true;\s*containerHeaderProbeFailuresRef\.current = 0;\s*const previousState = recorder\.state;/, "the probe-failure counter resets when a generation restart re-arms the header wait after the recorder actually stops");
assert.match(
  ondataavailableBody,
  /awaitingContainerHeaderRef\.current = false;\s*containerHeaderRetryCountRef\.current = 0;\s*containerHeaderProbeFailuresRef\.current = 0;/,
  "a successful header validation resets the probe-failure counter alongside the retry counter"
);

// Explicit Stop must still stop capture normally — none of this recovery logic is reachable
// while an explicit stop is in progress (the retry escalation itself is gated on
// !explicitStopRequestedRef.current, and cleanupMedia's own stop path is untouched by this fix).
assert.match(appSource, /!explicitStopRequestedRef\.current\) \{\s*containerHeaderRetryCountRef\.current \+= 1;/, "the retry escalation only fires when an explicit stop is not already in progress");

console.log("Container header recovery regression tests passed.");
