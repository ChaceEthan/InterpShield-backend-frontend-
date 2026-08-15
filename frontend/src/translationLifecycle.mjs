// A translation card must only ever say "Translating..." once a translation job has actually
// been created for a finalized transcript (state is queued/processing/retrying) — never merely
// because the mic happens to be recording. Before that, and after a failure/timeout, it must
// show a state that isn't misleading about work actually happening.
export const translationPlaceholder = (state, isRecording) => {
  if (["queued", "processing", "retrying"].includes(state)) return "Translating...";
  if (["failed", "stale", "cancelled"].includes(state)) return "Translation unavailable — retry";
  return isRecording ? "Waiting for speech…" : "Translation will appear here.";
};
