export interface DubbingJob {
  translationId: string;
  language: string;
  text: string;
  createdAt: number;
}

export interface DubbingLifecycle {
  enqueue(job: DubbingJob): boolean;
  stop(options?: { clearQueue?: boolean }): void;
  resetSeen(): void;
  snapshot(): { gated: boolean; activeLanguages: string[]; queued: number; seen: number };
}

export function createDubbingLifecycle(options: {
  play: (job: DubbingJob, onEnd: () => void, onError: () => void) => void;
  cancel?: () => void;
  onGateChange?: (gated: boolean) => void;
  onIdle?: () => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  pauseMs?: (job: DubbingJob) => number;
}): DubbingLifecycle;
