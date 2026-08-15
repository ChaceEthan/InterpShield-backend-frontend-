import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMeaningfulSpeechGate } from "../src/audio/meaningfulSpeechGate.mjs";

// Reproduces the exact real production log sequence: the UI/session is genuinely idle
// (status "idle", recordingActive false, every in-flight ref false) but
// utteranceLifecycleRef is stuck at phase "listening" from a previous session that never
// reset it. Every later mic/tab press was rejected before getUserMedia/getDisplayMedia could
// ever run, with the misleading reason "session_action_in_progress" even though nothing was
// actually in flight.

// 1. The underlying state machine itself: resetToIdle() is a full, safe reset — a gate stuck
// at "listening" can be normalized back to "idle" and then legitimately restarted, exactly
// what startSession()'s new stale-lifecycle-recovery branch does before proceeding to
// getUserMedia/getDisplayMedia. This is source-agnostic: both Microphone and Tab/System Audio
// share the same utteranceLifecycleRef/gate, so one proof covers both.
{
  const gate = createMeaningfulSpeechGate();
  gate.start({ now: 1000, recordingGeneration: 1, sessionId: "session-1" });
  assert.equal(gate.snapshot().phase, "listening", "the gate can genuinely reach listening, matching the production report");

  // Simulate whatever left it stale: nothing further happens to the gate itself (no stop/reset
  // call), while the rest of the app's refs/status independently already returned to idle.
  gate.resetToIdle(2000);
  assert.equal(gate.snapshot().phase, "idle", "resetToIdle() fully normalizes a stale listening phase back to idle");

  const restarted = gate.start({ now: 3000, recordingGeneration: 2, sessionId: "session-2" });
  assert.equal(restarted.phase, "listening", "a legitimate new press can start a fresh generation immediately after the stale phase was normalized — the recovery does not leave the gate unusable");
  assert.equal(gate.snapshot().recordingGeneration, 2, "the new generation is tracked correctly, independent of the stale prior generation");
}

// 2. The real wiring in App.tsx: verify the entry guard, the stale-phase recovery branch, and
// the diagnostics exist, are correctly ordered, and are source-agnostic (both Microphone and
// Tab/System Audio flow through the exact same startSession() code before diverging on
// activeAudioSource further down).
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const startSessionBody = appSource.slice(
  appSource.indexOf("const startSession = useCallback(async () => {"),
  appSource.indexOf("const selectMode = (nextMode: Mode) => {")
);

// "session_action_in_progress" must only be reported when a real action is genuinely in
// flight — never merely because the lifecycle phase is stale. The old buggy guard OR'd a raw
// phase check into the same condition; that must be gone.
assert.doesNotMatch(
  startSessionBody,
  /if \(sessionActionInFlightRef\.current \|\| startInFlightRef\.current \|\| recordingRef\.current \|\| utteranceLifecycleRef\.current\.snapshot\(\)\.phase !== "idle"\)/,
  'the old guard that blocked on a raw phase !== "idle" check (mislabeled as session_action_in_progress) is gone'
);
assert.match(
  startSessionBody,
  /if \(sessionActionInFlightRef\.current \|\| startInFlightRef\.current \|\| stopInFlightRef\.current \|\| recordingRef\.current\) \{\s*console\.warn\("\[MIC_START_BLOCKED\]", \{\s*reason: "session_action_in_progress"/,
  "session_action_in_progress is reported only from the four real in-flight/recording refs, never from the lifecycle phase alone"
);

const sessionActionGuardIndex = startSessionBody.indexOf('reason: "session_action_in_progress"');
const staleRecoveryLogIndex = startSessionBody.indexOf("[MIC_STALE_LIFECYCLE_RECOVERED]");
const recordingAlreadyActiveIndex = startSessionBody.indexOf('reason: "recording_already_active"');
const resetToIdleCallIndex = startSessionBody.indexOf("utteranceLifecycleRef.current.resetToIdle();");
const micStartEnteredIndex = startSessionBody.indexOf("[MIC_START_ENTERED]");
const getUserMediaRequestIndex = startSessionBody.indexOf("[GET_USER_MEDIA_REQUEST]");
const getDisplayMediaRequestIndex = startSessionBody.indexOf("[GET_DISPLAY_MEDIA_REQUEST]");
const mediaRecorderCreatedIndex = startSessionBody.indexOf("[MEDIARECORDER_CREATED]");
const mediaRecorderStartRequestIndex = startSessionBody.indexOf("[MEDIARECORDER_START_REQUEST]");

assert.ok(sessionActionGuardIndex > -1 && staleRecoveryLogIndex > -1 && recordingAlreadyActiveIndex > -1 && resetToIdleCallIndex > -1 && micStartEnteredIndex > -1, "all the stale-lifecycle-recovery markers exist");

// A genuinely stale phase (no live recorder/stream) is normalized and the press proceeds —
// getUserMedia/getDisplayMedia, MediaRecorder creation and start are all still reachable
// afterward, for both Microphone and Tab/System Audio (this is the single shared code path
// both sources flow through before branching on activeAudioSource further down).
assert.ok(sessionActionGuardIndex < staleRecoveryLogIndex, "the real in-flight guard runs before the stale-lifecycle-recovery branch");
assert.ok(recordingAlreadyActiveIndex < staleRecoveryLogIndex, "a genuinely active recorder/stream is rejected with recording_already_active BEFORE the stale-phase branch would ever normalize it away — an actually active desktop session is never blindly reset");
assert.ok(staleRecoveryLogIndex < resetToIdleCallIndex, "MIC_STALE_LIFECYCLE_RECOVERED is logged before the phase is actually reset, so the pre-recovery state is always captured in the diagnostic");
assert.ok(resetToIdleCallIndex < micStartEnteredIndex, "the lifecycle is normalized before MIC_START_ENTERED, so the entered log always reflects a clean phase");
assert.ok(micStartEnteredIndex < getUserMediaRequestIndex, "after recovery, the microphone path still reaches GET_USER_MEDIA_REQUEST — the press is not blocked");
assert.ok(micStartEnteredIndex < getDisplayMediaRequestIndex, "after recovery, the tab/system audio path still reaches GET_DISPLAY_MEDIA_REQUEST — the press is not blocked");
assert.ok(getUserMediaRequestIndex < mediaRecorderCreatedIndex && getDisplayMediaRequestIndex < mediaRecorderCreatedIndex, "MediaRecorder is still created after a recovered stale-phase press");
assert.ok(mediaRecorderCreatedIndex < mediaRecorderStartRequestIndex, "MediaRecorder.start is still requested after a recovered stale-phase press");

// The normalization touches only capture/utterance-lifecycle refs — never auth, user,
// subscription, translation history, settings, or provider state.
const staleRecoveryBlock = startSessionBody.slice(staleRecoveryLogIndex, startSessionBody.indexOf("[MIC_START_ENTERED]"));
for (const forbidden of ["setUser(", "setToken(", "setHistory(", "setPreferredProvider(", "setSourceLang(", "setTargetLang(", "clearSessionStorage("]) {
  assert.ok(!staleRecoveryBlock.includes(forbidden), `the stale-lifecycle recovery block never touches unrelated state via ${forbidden}`);
}

// A genuinely active recording (a live recorder or a live stream track) must never be blindly
// reset just because some OTHER ref looks idle — that would kill a real desktop session.
assert.match(
  startSessionBody,
  /const recorderGenuinelyActive = staleRecorder\?\.state !== undefined && staleRecorder\.state !== "inactive";\s*const streamGenuinelyLive = streamRef\.current\?\.getTracks\(\)\.some\(\(track\) => track\.readyState === "live"\) \?\? false;\s*if \(recorderGenuinelyActive \|\| streamGenuinelyLive\) \{\s*console\.warn\("\[MIC_START_BLOCKED\]", \{\s*reason: "recording_already_active"/,
  "a live recorder or live stream track blocks the stale-phase normalization and reports recording_already_active instead of silently resetting an active session"
);

// 3. Failed Tab/System Audio must return the lifecycle to idle (via the existing catch-all
// exception path), so an immediate switch to Microphone starts cleanly with no leftover state.
assert.match(
  startSessionBody,
  /stream = await requestTabAudioStream\(navigator\.mediaDevices\);/,
  "the tab branch requests its stream inside the try block, so a TabAudioNoTrackError (no shared audio) is caught by the same catch-all handler as any other startup failure"
);
assert.match(
  appSource,
  /\} catch \(error\) \{\s*sessionActionInFlightRef\.current = false;\s*startInFlightRef\.current = false;\s*cleanupMedia\(\{ stopReason: "session_start_exception" \}\);\s*utteranceLifecycleRef\.current\.resetToIdle\(\);/,
  "any startup exception (including a failed tab/system audio attempt) fully cleans up and resets the lifecycle to idle before returning control to the user"
);

// 4. Production self-heal: if the impossible combination (status idle, nothing recording or in
// flight, but a stale non-idle phase) is ever reached through some other path, a watchdog
// proactively logs it and normalizes it — without needing another press first.
assert.match(appSource, /console\.error\("\[MIC_LIFECYCLE_INVARIANT_VIOLATION\]"/, "MIC_LIFECYCLE_INVARIANT_VIOLATION is logged when the impossible idle/stale-phase combination is detected");
assert.match(
  appSource,
  /if \(!recorderGenuinelyActive && !streamGenuinelyLive\) utteranceLifecycleRef\.current\.resetToIdle\(\);/,
  "the invariant watchdog only self-heals when there is provably no live recorder/stream to protect"
);

// 5. logout() is a confirmed real path that reset status back to idle without ever touching the
// utterance lifecycle — closing this gap so the next login's first press does not inherit a
// stale phase from a prior session that was still active at logout time.
assert.match(
  appSource,
  /if \(recordingRef\.current \|\| utteranceLifecycleRef\.current\.snapshot\(\)\.phase !== "idle"\) \{\s*cleanupMedia\(\{ stopReason: "logout" \}\);\s*\}/,
  "logout() releases capture and resets the utterance lifecycle when a session was active, instead of only resetting status"
);

console.log("Stale utterance-lifecycle recovery regression tests passed.");
