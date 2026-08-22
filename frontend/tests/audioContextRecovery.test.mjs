import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ROOT CAUSE (long desktop/tab sessions: audioLevel decaying from real speech energy down to
// ~1e-137, then ~1e-200, then ~1e-293 over tens of seconds, while MediaRecorder kept emitting
// ~185-byte header-only chunks and Deepgram kept returning DEEPGRAM_RESULTS_EMPTY): browsers
// (Chrome in particular) auto-suspend a WebAudio AudioContext after it has carried only silence
// for a while, as a power-saving measure. Once suspended, the analyser the VAD/level-metering
// graph reads from stops receiving fresh frames, so every poll tick's exponential smoothing
// (smoothedLevel = smoothedLevel * 0.75 + rms * 0.25) decays multiplicatively toward zero forever.
// The only code that resumed a suspended context used to live inside the "speech_candidate" VAD
// branch, which requires the analyser to already be reading a non-trivial signal to ever fire —
// a deadlock once the context was genuinely suspended (no signal -> never reaches
// speech_candidate -> context never resumed -> still no signal). These are source-pattern
// regression guards (this codebase's established convention for App.tsx, since it isn't
// imported/executed directly by the plain-node test runner) proving the resume check now runs
// unconditionally on every VAD poll tick, before a level is even sampled, instead of being gated
// behind ever detecting a candidate signal first.
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

const pollTimerIndex = appSource.indexOf("vadPollTimerRef.current = window.setInterval(() => {");
assert.ok(pollTimerIndex >= 0, "the VAD poll interval must exist");
const pollTimerBody = appSource.slice(pollTimerIndex, pollTimerIndex + 3300);

const resumeCheckIndex = pollTimerBody.indexOf(
  'if (enhancedAudio.audioContext?.state === "suspended") void enhancedAudio.audioContext.resume().catch(() => undefined);'
);
assert.ok(resumeCheckIndex >= 0, "every VAD poll tick must check for and resume a suspended AudioContext");

const levelSampleIndex = pollTimerBody.indexOf(
  "const action = vadControllerRef.current.update(getAudioLevelRef.current(), Date.now(), false);"
);
assert.ok(levelSampleIndex >= 0, "the VAD poll tick must sample the current audio level");
assert.ok(
  resumeCheckIndex < levelSampleIndex,
  "the suspended-AudioContext resume check must run BEFORE the level is sampled each tick, so a resumed context has a chance to produce a fresh, non-stale reading on the very same tick that noticed it was suspended"
);

// The resume check must no longer be gated behind ever reaching "speech_candidate" — a suspended
// context can never produce the signal that branch requires, so gating the fix there recreates
// the exact deadlock this fix exists to break.
const speechCandidateIndex = pollTimerBody.indexOf('if (action.type === "speech_candidate") {');
assert.ok(speechCandidateIndex >= 0, "the speech_candidate VAD branch must still exist");
const speechCandidateBody = pollTimerBody.slice(speechCandidateIndex, speechCandidateIndex + 150);
assert.doesNotMatch(
  speechCandidateBody,
  /audioContext\.resume\(\)/,
  "the AudioContext resume check must not be duplicated inside (or only reachable through) the speech_candidate branch"
);

console.log("AudioContext long-session auto-suspend recovery regression tests passed.");
