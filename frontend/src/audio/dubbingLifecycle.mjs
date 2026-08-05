const jobKey = ({ translationId, language, text }) => `${translationId}:${language}:${text}`;

export const createDubbingLifecycle = ({
  prepare,
  play,
  cancel,
  onGateChange = () => {},
  onIdle = () => {},
  now = Date.now,
  maxAgeMs = 45000
}) => {
  const pending = new Map();
  const pendingByLanguage = new Map();
  const seen = new Set();
  let gated = false;
  let generation = 0;

  const updateGate = () => {
    const next = pending.size > 0;
    if (gated === next) return;
    gated = next;
    onGateChange(gated);
    if (!gated) onIdle();
  };

  const settle = (key, queuedGeneration) => {
    if (queuedGeneration !== generation || !pending.has(key)) return;
    const { job } = pending.get(key);
    pending.delete(key);
    const languageCount = (pendingByLanguage.get(job.language) || 1) - 1;
    if (languageCount > 0) pendingByLanguage.set(job.language, languageCount);
    else pendingByLanguage.delete(job.language);
    updateGate();
  };

  return {
    enqueue(job) {
      const key = jobKey(job);
      if (!job.translationId || !job.language || !job.text || seen.has(key)) return false;
      if (Number.isFinite(job.createdAt) && now() - job.createdAt > maxAgeMs) return false;

      let prepared;
      try {
        prepared = prepare(job);
      } catch {
        return false;
      }

      seen.add(key);
      const queuedGeneration = generation;
      pending.set(key, { job, prepared });
      pendingByLanguage.set(job.language, (pendingByLanguage.get(job.language) || 0) + 1);
      updateGate();

      const start = () => {
        if (queuedGeneration !== generation || !pending.has(key)) return;
        if (!Number.isFinite(job.createdAt) || now() - job.createdAt <= maxAgeMs) return;
        generation += 1;
        cancel?.();
        pending.clear();
        pendingByLanguage.clear();
        updateGate();
      };
      const finish = () => settle(key, queuedGeneration);
      try {
        // Submit immediately. Browser speech synthesis can prepare this queued
        // utterance while the preceding utterance is still playing.
        play(prepared, job, start, finish, finish);
      } catch {
        seen.delete(key);
        finish();
        return false;
      }
      return true;
    },
    stop({ clearQueue = true } = {}) {
      generation += 1;
      if (pending.size > 0) cancel?.();
      pending.clear();
      pendingByLanguage.clear();
      if (clearQueue) seen.clear();
      updateGate();
    },
    resetSeen() { seen.clear(); },
    snapshot() {
      return {
        gated,
        activeLanguages: [...pendingByLanguage.keys()],
        queued: Math.max(0, pending.size - (pending.size > 0 ? 1 : 0)),
        seen: seen.size
      };
    }
  };
};
