import { AlertTriangle, Download, Eraser, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { MicButton } from "./MicButton";
import { StatusBar } from "./StatusBar";
import { TranscriptArea, type TranscriptTranslationEntry } from "./TranscriptArea";

type SessionStatus = "idle" | "connecting" | "calibrating" | "listening" | "speaking" | "soft-pause" | "finalizing" | "dubbing" | "listening-after-dubbing" | "paused" | "stopping" | "error";
type ToolMode = "transcribe" | "translate" | "dubbing";
type ConnectionState = "ready" | "connecting" | "connected" | "listening" | "translating" | "reconnecting";

interface TranslationPanelProps {
  mode: ToolMode;
  status: SessionStatus;
  statusLabel: string;
  sourceLabel: string;
  targetLabel: string;
  originalText: string;
  interimText?: string;
  translations: TranscriptTranslationEntry[];
  isConnected: boolean;
  connectionState?: ConnectionState;
  isRecording: boolean;
  sessionSeconds: number;
  chunkCount: number;
  lastLatency: number | null;
  historyCount: number;
  microphoneLabel?: string;
  alert?: string | null;
  aiDegraded?: boolean;
  onMicClick: () => void;
  onClear: () => void;
  onSave: () => void;
}

export function TranslationPanel({
  mode,
  status,
  statusLabel,
  sourceLabel,
  targetLabel,
  originalText,
  interimText,
  translations,
  isConnected,
  connectionState,
  isRecording,
  sessionSeconds,
  chunkCount,
  lastLatency,
  historyCount,
  microphoneLabel,
  alert,
  aiDegraded = false,
  onMicClick,
  onClear,
  onSave
}: TranslationPanelProps) {
  const isConnecting = status === "connecting";
  const isBusy = status === "stopping";

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="rounded-2xl border border-gray-200 bg-white/90 p-4 shadow-md shadow-gray-200/60 backdrop-blur sm:p-6"
    >
      <div className="flex flex-col gap-4 border-b border-gray-100 pb-5 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
            <Sparkles className="h-3.5 w-3.5" />
            {statusLabel}
          </div>
          <h2 className="mt-3 text-xl font-semibold text-gray-950">Live translation room</h2>
          <p className="mt-1 text-sm text-gray-500">
            {sourceLabel} to {targetLabel}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-gray-200 bg-white px-3 text-sm font-medium text-gray-600 transition hover:bg-gray-50 hover:text-gray-950"
          >
            <Eraser className="h-4 w-4" />
            Clear
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={historyCount === 0}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-gray-200 bg-white px-3 text-sm font-medium text-gray-600 transition hover:bg-gray-50 hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Download className="h-4 w-4" />
            Export
          </button>
        </div>
      </div>

      <AnimatePresence>
        {(alert || aiDegraded) && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{alert || "High demand detected. Fallback AI processing is active to maintain low latency."}</p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex min-h-[520px] flex-col justify-between gap-7 py-7">
        <TranscriptArea
          mode={mode}
          originalText={originalText}
          interimText={interimText}
          translations={translations}
          isRecording={isRecording}
        />

        <div className="sticky bottom-4 z-20 mx-auto rounded-full bg-white/80 p-2 shadow-lg shadow-gray-200/80 backdrop-blur sm:static sm:bg-transparent sm:p-0 sm:shadow-none">
          <MicButton
            isRecording={isRecording}
            isConnecting={isConnecting}
            disabled={isBusy}
            onClick={onMicClick}
          />
        </div>

        <StatusBar
          isConnected={isConnected}
          connectionState={connectionState}
          elapsedSeconds={sessionSeconds}
          chunkCount={chunkCount}
          lastLatency={lastLatency}
          sessionActive={isRecording}
          microphoneLabel={microphoneLabel}
        />
      </div>
    </motion.section>
  );
}
