export const stableSessionStartTime = (currentStartedAt, now = Date.now()) =>
  Number.isFinite(currentStartedAt) && currentStartedAt > 0 ? currentStartedAt : now;

export const createUtteranceBoundaryController = ({
  timeoutMs = 2500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  getAudioLevel = () => 0,
  onBoundary = () => undefined,
  onCancelled = () => undefined
} = {}) => {
  let pending = null;
  let timer = null;

  const clearPendingTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const settle = (reason, audioLevel = getAudioLevel()) => {
    if (!pending) return false;
    const boundary = pending;
    pending = null;
    clearPendingTimer();

    if (Number.isFinite(boundary.speechThreshold) && audioLevel >= boundary.speechThreshold) {
      onCancelled(boundary, reason);
      return false;
    }

    onBoundary(boundary, reason);
    return true;
  };

  const request = (boundary) => {
    if (pending) return false;
    pending = { ...boundary, requestedAt: boundary?.requestedAt || Date.now() };
    timer = setTimer(() => settle("timeout"), timeoutMs);
    return true;
  };

  const onDataAvailable = (audioLevel) => settle("dataavailable", audioLevel);
  const cancel = (reason = "cancelled") => {
    if (!pending) return false;
    const boundary = pending;
    pending = null;
    clearPendingTimer();
    onCancelled(boundary, reason);
    return true;
  };
  const stop = () => {
    pending = null;
    clearPendingTimer();
  };

  return { request, onDataAvailable, cancel, stop, hasPending: () => Boolean(pending) };
};
