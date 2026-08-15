// A translation card must only ever say "Translating..." once a translation job has actually
// been created for a finalized transcript (state is queued/processing/retrying) — never merely
// because the mic happens to be recording. Before that, and after a failure/timeout, it must
// show a state that isn't misleading about work actually happening.
export const translationPlaceholder = (state, isRecording) => {
  if (["queued", "processing", "retrying"].includes(state)) return "Translating...";
  if (["failed", "stale", "cancelled"].includes(state)) return "Translation unavailable — retry";
  // Defensive guard, not a normally-reachable path: the caller only ever invokes this when its
  // own translated text is empty, and "translated"/"done" is only ever set alongside non-empty
  // text (see App.tsx's displayTranslationEntries). If that invariant is ever violated by a
  // future change, this must show an honest "something went wrong" message — never "Waiting for
  // speech...", which would falsely claim a completed translation was never even attempted.
  if (["translated", "done"].includes(state)) return "Translation unavailable — retry";
  return isRecording ? "Waiting for speech…" : "Translation will appear here.";
};
