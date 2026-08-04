export interface VadConfig { calibrationMs: number; speechThreshold: number; silenceThreshold: number; minimumSpeechMs: number; silenceHoldMs: number; preSpeechBufferMs: number; maximumUtteranceMs: number; noiseFloorMultiplier: number }
export type VadState = "idle" | "calibrating" | "listening" | "speaking" | "finalizing" | "paused" | "stopped";
export interface VadEvent { type: "calibrated" | "speech_candidate" | "speech_cancelled" | "speech_started" | "finalize"; state: VadState; level: number; speech: number; silence: number; reason?: string }
export const DEFAULT_VAD_CONFIG: Readonly<VadConfig>;
export const buildProductionAudioConstraints: (supported?: MediaTrackSupportedConstraints, microphoneId?: string | Record<string, unknown>) => MediaTrackConstraints;
export const createVadController: (options?: Partial<VadConfig>) => { start(now?: number): VadState; update(level: number, now?: number, forceTransmit?: boolean): VadEvent | null; markPaused(): VadState; stop(): VadState; getState(): VadState; getConfig(): VadConfig; getNoiseFloor(): number };
