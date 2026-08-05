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

export function createDubbingLifecycle<TPrepared>(options: {
  prepare: (job: DubbingJob) => TPrepared;
  play: (prepared: TPrepared, job: DubbingJob, onStart: () => void, onEnd: () => void, onError: () => void) => void;
  cancel?: () => void;
  onGateChange?: (gated: boolean) => void;
  onIdle?: () => void;
  now?: () => number;
  maxAgeMs?: number;
}): DubbingLifecycle;
