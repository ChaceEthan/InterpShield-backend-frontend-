// A live audio track ending is only a genuine failure if InterpShield still expects it to be
// live. Every intentional stop/replacement path (explicit Stop, mobile utterance completion,
// desktop generation restart, cleanupMedia teardown) already flips one of these signals before
// it ever calls track.stop(); if none of them are set, the track ended on its own — a real
// unexpected failure (unplugged device, OS revoked permission, browser killed the track).
export const isTrackEndExpected = ({
  isCurrentGeneration,
  isCurrentStream,
  recordingExpected,
  intentionalStopInProgress,
  recorderTransitionInProgress,
  phase
} = {}) => {
  const lifecycleSettling = ["draining", "finalizing", "idle"].includes(phase);
  return (
    !isCurrentGeneration ||
    !isCurrentStream ||
    !recordingExpected ||
    Boolean(intentionalStopInProgress) ||
    Boolean(recorderTransitionInProgress) ||
    lifecycleSettling
  );
};

// recorderStoppedForGenerationRef is set by application code immediately before every
// intentional MediaRecorder.stop() call. If it doesn't match the generation that just
// stopped, nothing in this app called stop() for it — the recorder stopped on its own.
export const classifyRecorderStop = ({ stopWasIntentional, trackedReason } = {}) =>
  stopWasIntentional ? trackedReason : "unexpected_recorder_stop";

export const shouldRecoverFromRecorderStop = ({ recordingExpected, stopWasIntentional } = {}) =>
  Boolean(recordingExpected) && !stopWasIntentional;
