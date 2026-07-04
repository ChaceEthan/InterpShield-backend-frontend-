import type { ReactNode } from "react";
import { ArrowRightLeft, ChevronDown } from "lucide-react";
import { motion } from "framer-motion";

interface LanguageOption {
  code: string;
  name: string;
  region?: string;
}

interface LanguageSelectorProps {
  languages: LanguageOption[];
  sourceLanguage: string;
  targetLanguage: string;
  targetLanguages?: string[];
  targetLimit?: number;
  disabled?: boolean;
  onSourceChange: (language: string) => void;
  onTargetChange: (language: string) => void;
  onTargetSlotChange?: (index: number, language: string) => void;
  onSwap: () => void;
}

export function LanguageSelector({
  languages,
  sourceLanguage,
  targetLanguage,
  targetLanguages = [targetLanguage],
  targetLimit = 1,
  disabled = false,
  onSourceChange,
  onTargetChange,
  onTargetSlotChange,
  onSwap
}: LanguageSelectorProps) {
  const activeTargets = targetLanguages.length > 0 ? targetLanguages : [targetLanguage];
  const targetModeLabel = targetLimit === 1 ? "One-way" : targetLimit === 2 ? "Two-way" : "Three-way";

  const isTargetDisabled = (language: string, slotIndex?: number) => {
    if (language === sourceLanguage) return true;
    if (slotIndex === undefined) return false;
    return activeTargets.some((target, index) => index !== slotIndex && target === language);
  };

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
            <option key={language.code} value={language.code} disabled={isTargetDisabled(language.code)}>
              {language.name}
            </option>
          ))}
        </select>
      </SelectShell>

      <motion.div
        layout
        className="sm:col-span-3"
      >
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-500">{targetModeLabel}</span>
          {activeTargets.map((target, index) => {
            const language = languages.find((option) => option.code === target);
            return (
              <span
                key={`${target}-${index}`}
                className="inline-flex min-h-8 items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 text-xs font-semibold text-blue-700"
              >
                <span>{language?.name || target.toUpperCase()}</span>
                <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] uppercase text-blue-500">{target}</span>
              </span>
            );
          })}
        </div>

        {activeTargets.length > 1 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="mt-3 grid gap-2 sm:grid-cols-2"
          >
            {activeTargets.map((target, index) => (
              <SelectShell key={`${target}-${index}`} label={`Target ${index + 1}`}>
                <select
                  value={target}
                  disabled={disabled}
                  onChange={(event) => onTargetSlotChange?.(index, event.target.value)}
                  className="h-11 w-full appearance-none rounded-xl border border-gray-200 bg-white px-4 pr-10 text-sm font-semibold text-gray-900 shadow-sm outline-none transition hover:border-gray-300 focus:border-blue-400 focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
                >
                  {languages.map((language) => (
                    <option key={language.code} value={language.code} disabled={isTargetDisabled(language.code, index)}>
                      {language.name}
                    </option>
                  ))}
                </select>
              </SelectShell>
            ))}
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
}

function SelectShell({ label, children, ...props }: { label: string; children: ReactNode; [key: string]: any }) {
  return (
    <label {...props} className="relative block">
      <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      {children}
      <ChevronDown className="pointer-events-none absolute bottom-3.5 right-3 h-4 w-4 text-gray-400" />
    </label>
  );
}
