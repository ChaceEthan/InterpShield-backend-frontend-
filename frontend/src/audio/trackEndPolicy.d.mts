export function isTrackEndExpected(input?: {
  isCurrentGeneration?: boolean;
  isCurrentStream?: boolean;
  recordingExpected?: boolean;
  intentionalStopInProgress?: boolean;
  recorderTransitionInProgress?: boolean;
  phase?: string;
}): boolean;

export function classifyRecorderStop(input?: { stopWasIntentional?: boolean; trackedReason?: string }): string;

export function shouldRecoverFromRecorderStop(input?: { recordingExpected?: boolean; stopWasIntentional?: boolean }): boolean;
