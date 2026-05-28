import type { ReactNode } from "react";
import { ArrowRightLeft, ChevronDown } from "lucide-react";
import { motion } from "motion/react";

interface LanguageOption {
  code: string;
  name: string;
  region?: string;
}

interface LanguageSelectorProps {
  languages: LanguageOption[];
  sourceLanguage: string;
  targetLanguage: string;
  disabled?: boolean;
  onSourceChange: (language: string) => void;
  onTargetChange: (language: string) => void;
  onSwap: () => void;
}

export function LanguageSelector({
  languages,
  sourceLanguage,
  targetLanguage,
  disabled = false,
  onSourceChange,
  onTargetChange,
  onSwap
}: LanguageSelectorProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="mx-auto grid w-full max-w-[520px] grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_44px_1fr]"
    >
      <SelectShell label="Source language">
        <select
          value={sourceLanguage}
          disabled={disabled}
          onChange={(event) => onSourceChange(event.target.value)}
          className="h-12 w-full appearance-none rounded-xl border border-gray-200 bg-white px-4 pr-10 text-sm font-semibold text-gray-900 shadow-sm outline-none transition hover:border-gray-300 focus:border-blue-400 focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
        >
          <option value="auto">Auto Detect</option>
          {languages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.name}
            </option>
          ))}
        </select>
      </SelectShell>

      <motion.button
        type="button"
        disabled={disabled}
        onClick={onSwap}
        whileTap={{ scale: disabled ? 1 : 0.94 }}
        className="grid h-11 w-11 place-items-center justify-self-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50 sm:mb-0.5"
        aria-label="Swap languages"
        title="Swap languages"
      >
        <ArrowRightLeft className="h-4 w-4" />
      </motion.button>

      <SelectShell label="Target language">
        <select
          value={targetLanguage}
          disabled={disabled}
          onChange={(event) => onTargetChange(event.target.value)}
          className="h-12 w-full appearance-none rounded-xl border border-blue-100 bg-blue-50 px-4 pr-10 text-sm font-semibold text-gray-900 shadow-sm outline-none transition hover:border-blue-200 focus:border-blue-400 focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
        >
          {languages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.name}
            </option>
          ))}
        </select>
      </SelectShell>
    </motion.div>
  );
}

function SelectShell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="relative block">
      <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      {children}
      <ChevronDown className="pointer-events-none absolute bottom-3.5 right-3 h-4 w-4 text-gray-400" />
    </label>
  );
}
