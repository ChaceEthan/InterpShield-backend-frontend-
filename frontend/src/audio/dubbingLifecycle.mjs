const jobKey = ({ translationId, language, text }) => `${translationId}:${language}:${text}`;

export const createDubbingLifecycle = ({ play, cancel, onGateChange = () => {}, onIdle = () => {}, schedule = setTimeout, pauseMs = () => 0 }) => {
  const queues = new Map();
  const activeLanguages = new Set();
  const seen = new Set();
  let gated = false;

  const updateGate = () => {
    const next = activeLanguages.size > 0;
    if (gated === next) return;
    gated = next;
    onGateChange(gated);
    if (!gated) onIdle();
  };

  const pump = (language) => {
    if (activeLanguages.has(language)) return;
    const queue = queues.get(language) || [];
    const job = queue.shift();
    if (!job) return;
    activeLanguages.add(language);
    updateGate();

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      activeLanguages.delete(language);
      updateGate();
      schedule(() => pump(language), pauseMs(job));
    };

    try {
      play(job, finish, finish);
    } catch {
      finish();
    }
  };

  return {
    enqueue(job) {
      const key = jobKey(job);
      if (!job.translationId || !job.language || !job.text || seen.has(key)) return false;
      seen.add(key);
      const queue = queues.get(job.language) || [];
      queue.push(job);
      queues.set(job.language, queue);
      pump(job.language);
      return true;
    },
    stop({ clearQueue = true } = {}) {
      if (activeLanguages.size > 0) cancel?.();
      activeLanguages.clear();
      if (clearQueue) queues.clear();
      updateGate();
    },
    resetSeen() { seen.clear(); },
    snapshot() {
      return { gated, activeLanguages: [...activeLanguages], queued: [...queues.values()].reduce((sum, queue) => sum + queue.length, 0), seen: seen.size };
    }
  };
};
