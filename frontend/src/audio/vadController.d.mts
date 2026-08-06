export interface VadConfig { autoFinalize: boolean; calibrationMs: number; speechThreshold: number; silenceThreshold: number; minimumSpeechMs: number; minimumUtteranceMs: number; speechHangoverMs: number; preSpeechBufferMs: number; postSpeechBufferMs: number; shortPauseGraceMs: number; hardFinalizeMs: number; maximumUtteranceMs: number; transcriptChangeGraceMs: number; noiseFloorMultiplier: number; consecutiveSpeechSamples: number }
export type VadState = "idle" | "calibrating" | "listening" | "speaking" | "soft-pause" | "finalizing" | "paused" | "stopped";
export interface VadTranscriptSignals { providerFinal?: boolean; speechFinal?: boolean; utteranceEnd?: boolean }
export interface VadEvent { type: "calibrated" | "speech_candidate" | "speech_cancelled" | "speech_started" | "speech_resumed" | "soft_pause" | "finalize"; state: VadState; level: number; speech: number; silence: number; reason?: string; silenceMs?: number; dynamicHoldMs?: number }
export interface TranscriptCompleteness { text: string; wordCount: number; meaningful: boolean; punctuated: boolean; incomplete: boolean; completeShortPhrase: boolean }
export const DEFAULT_VAD_CONFIG: Readonly<VadConfig>;
export const analyzeTranscriptCompleteness: (text?: string) => TranscriptCompleteness;
export const getDynamicSilenceHoldMs: (text?: string, signals?: VadTranscriptSignals) => number;
export const buildProductionAudioConstraints: (supported?: MediaTrackSupportedConstraints, microphoneId?: string | Record<string, unknown>) => MediaTrackConstraints;
export const createVadController: (options?: Partial<VadConfig>) => { start(now?: number): VadState; update(level: number, now?: number, forceTransmit?: boolean): VadEvent | null; noteTranscript(text?: string, signals?: VadTranscriptSignals, now?: number): number; cancelFinalization(now?: number): boolean; markPaused(): VadState; stop(): VadState; getState(): VadState; getConfig(): VadConfig; getNoiseFloor(): number };
