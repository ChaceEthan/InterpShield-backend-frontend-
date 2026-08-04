export interface UtteranceBoundary { sequence: number; capturedAt: number; speechThreshold: number; requestedAt?: number }
export const stableSessionStartTime: (currentStartedAt: number | null | undefined, now?: number) => number;
export const createUtteranceBoundaryController: (options?: {
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  getAudioLevel?: () => number;
  onBoundary?: (boundary: UtteranceBoundary, reason: string) => void;
  onCancelled?: (boundary: UtteranceBoundary, reason: string) => void;
}) => {
  request(boundary: UtteranceBoundary): boolean;
  onDataAvailable(audioLevel?: number): boolean;
  cancel(reason?: string): boolean;
  stop(): void;
  hasPending(): boolean;
};
