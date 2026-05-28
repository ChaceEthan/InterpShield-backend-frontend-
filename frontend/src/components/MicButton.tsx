import { CircleStop, Loader2, Mic } from "lucide-react";
import { motion } from "motion/react";

interface MicButtonProps {
  isRecording: boolean;
  isConnecting?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function MicButton({ isRecording, isConnecting = false, disabled = false, onClick }: MicButtonProps) {
  const label = isConnecting ? "Starting live session..." : isRecording ? "Listening now" : "Press and start talking";

  return (
    <div className="flex flex-col items-center gap-4">
      <span className="rounded-full bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-600 shadow-sm shadow-blue-100">
        {label}
      </span>

      <div className="relative flex items-center justify-center">
        {isRecording && (
          <motion.span
            className="absolute h-20 w-20 rounded-full border border-red-200 bg-red-100/40"
            animate={{ scale: [1, 1.26], opacity: [0.55, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <motion.button
          type="button"
          disabled={disabled}
          onClick={onClick}
          whileHover={{ scale: disabled ? 1 : 1.04 }}
          whileTap={{ scale: disabled ? 1 : 0.95 }}
          className={`relative grid h-20 w-20 place-items-center rounded-full text-white shadow-xl transition disabled:cursor-wait disabled:opacity-70 ${
            isRecording
              ? "bg-red-500 shadow-red-200 hover:bg-red-600"
              : isConnecting
                ? "bg-blue-400 shadow-blue-200"
                : "bg-blue-600 shadow-blue-200 hover:bg-blue-700"
          }`}
          aria-label={isRecording ? "Stop recording" : "Start recording"}
        >
          {isConnecting ? (
            <Loader2 className="h-8 w-8 animate-spin" />
          ) : isRecording ? (
            <CircleStop className="h-8 w-8" />
          ) : (
            <Mic className="h-8 w-8" />
          )}
        </motion.button>
      </div>
    </div>
  );
}
