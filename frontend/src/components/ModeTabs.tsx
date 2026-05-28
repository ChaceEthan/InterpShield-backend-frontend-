import { Lock, Share2 } from "lucide-react";
import { motion } from "motion/react";

export type PrivacyMode = "private" | "shareable";

interface ModeTabsProps {
  activeMode: PrivacyMode;
  disabled?: boolean;
  onChange: (mode: PrivacyMode) => void;
}

const MODES = [
  { id: "private", label: "Private", icon: Lock },
  { id: "shareable", label: "Shareable", icon: Share2 }
] as const;

export function ModeTabs({ activeMode, disabled = false, onChange }: ModeTabsProps) {
  return (
    <div className="flex justify-center">
      <div className="inline-flex items-center gap-6 border-b border-gray-200 px-4">
        {MODES.map(({ id, label, icon: Icon }) => {
          const isActive = activeMode === id;

          return (
            <button
              key={id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(id)}
              className={`relative inline-flex h-11 items-center gap-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                isActive ? "text-gray-950" : "text-gray-500 hover:text-gray-800"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
              {isActive && (
                <motion.span
                  layoutId="privacy-mode-underline"
                  className="absolute -bottom-px left-0 right-0 h-0.5 rounded-full bg-blue-500"
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
