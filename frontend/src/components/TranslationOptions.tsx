import { Info, Route } from "lucide-react";
import { motion } from "framer-motion";

interface TranslationOptionsProps {
  twoWayEnabled: boolean;
  threeWayEnabled: boolean;
  disabled?: boolean;
  onTwoWayToggle: (enabled: boolean) => void;
  onThreeWayToggle: (enabled: boolean) => void;
}

export function TranslationOptions({
  twoWayEnabled,
  threeWayEnabled,
  disabled = false,
  onTwoWayToggle,
  onThreeWayToggle
}: TranslationOptionsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="mx-auto flex w-full max-w-[520px] flex-col gap-3 border-t border-gray-100 pt-5 sm:flex-row sm:items-center sm:justify-between"
    >
      <Toggle
        label="Two-way translation"
        checked={twoWayEnabled}
        disabled={disabled}
        onChange={onTwoWayToggle}
      />
      <Toggle
        label="Three-way translation"
        checked={threeWayEnabled}
        disabled={disabled}
        onChange={onThreeWayToggle}
      />
    </motion.div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex min-h-10 items-center justify-between gap-3 rounded-xl px-2 text-left text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-0"
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        <Route className="h-4 w-4 shrink-0 text-gray-400" />
        <span className="truncate">{label}</span>
        <Info className="h-3.5 w-3.5 shrink-0 text-gray-400" />
      </span>
      <span className={`relative h-5 w-9 shrink-0 rounded-full p-0.5 transition ${checked ? "bg-blue-500" : "bg-gray-200"}`}>
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 500, damping: 35 }}
          className={`block h-4 w-4 rounded-full bg-white shadow-sm ${checked ? "ml-4" : "ml-0"}`}
        />
      </span>
    </button>
  );
}
