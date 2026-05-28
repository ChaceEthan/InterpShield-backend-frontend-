import { FileText, Languages, Volume2 } from "lucide-react";
import { motion } from "framer-motion";

export type ToolType = "transcribe" | "translate" | "dubbing";

interface ToolTabsProps {
  activeTool: ToolType;
  disabled?: boolean;
  onChange: (tool: ToolType) => void;
}

const TOOLS = [
  { id: "transcribe", label: "Transcribe", icon: FileText },
  { id: "translate", label: "Translate", icon: Languages },
  { id: "dubbing", label: "Dubbing", icon: Volume2 }
] as const;

export function ToolTabs({ activeTool, disabled = false, onChange }: ToolTabsProps) {
  return (
    <div className="mx-auto grid w-full max-w-[430px] grid-cols-3 gap-2 rounded-2xl bg-gray-50 p-1.5 shadow-inner shadow-gray-100">
      {TOOLS.map(({ id, label, icon: Icon }) => {
        const isActive = activeTool === id;

        return (
          <motion.button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(id)}
            whileTap={{ scale: disabled ? 1 : 0.98 }}
            className={`relative inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
              isActive
                ? "border-blue-200 bg-blue-50 text-blue-700 shadow-sm"
                : "border-transparent bg-white text-gray-600 shadow-sm hover:border-gray-200 hover:text-gray-950"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{label}</span>
          </motion.button>
        );
      })}
    </div>
  );
}
