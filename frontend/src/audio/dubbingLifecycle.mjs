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
  let activeKey = null;
  const queue = [];

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
    if (activeKey === key) activeKey = null;
    updateGate();
    playNext();
  };

  const playNext = () => {
    if (activeKey || queue.length === 0) return;
    const key = queue.shift();
    const item = pending.get(key);
    if (!item) return playNext();
    const { job, prepared, queuedGeneration } = item;
    if (queuedGeneration !== generation || (Number.isFinite(job.createdAt) && now() - job.createdAt > maxAgeMs)) {
      settle(key, queuedGeneration);
      return;
    }
    activeKey = key;
    const finish = () => settle(key, queuedGeneration);
    try { play(prepared, job, () => {}, finish, finish); }
    catch { seen.delete(key); finish(); }
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
      pending.set(key, { job, prepared, queuedGeneration });
      pendingByLanguage.set(job.language, (pendingByLanguage.get(job.language) || 0) + 1);
      queue.push(key);
      updateGate();
      playNext();
      return true;
    },
    stop({ clearQueue = true } = {}) {
      generation += 1;
      if (pending.size > 0) cancel?.();
      pending.clear();
      pendingByLanguage.clear();
      queue.length = 0;
      activeKey = null;
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
