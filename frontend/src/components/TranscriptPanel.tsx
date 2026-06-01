import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Zap } from 'lucide-react';

interface TranscriptEntry {
  id: string;
  original: string;
  translated: string;
  timestamp: string;
  sourceLang: string;
  targetLang: string;
  confidence?: number;
}

interface LiveTranscriptPanelProps {
  entries: TranscriptEntry[];
  currentOriginal?: string;
  currentTranslation?: string;
  isRecording?: boolean;
  maxEntries?: number;
  onEntryClick?: (entry: TranscriptEntry) => void;
}

/**
 * Live transcript panel with streaming updates
 */
export const LiveTranscriptPanel: React.FC<LiveTranscriptPanelProps> = ({
  entries,
  currentOriginal,
  currentTranslation,
  isRecording = false,
  maxEntries = 20,
  onEntryClick,
}) => {
  const displayEntries = entries.slice(-maxEntries);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const scrollSignature = [
    ...displayEntries.map((entry) => `${entry.id}:${entry.original}:${entry.translated}`),
    currentOriginal || "",
    currentTranslation || ""
  ].join("|");

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) return;
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [scrollSignature]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.05] to-transparent backdrop-blur-xl"
    >
      {/* Header */}
      <div className="border-b border-white/10 px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-blue-500/60" />
          <h3 className="text-sm font-bold uppercase tracking-widest text-slate-200">Live Transcript</h3>
          {isRecording && (
            <motion.div
              animate={{ opacity: [0.5, 1] }}
              transition={{ duration: 1, repeat: Infinity }}
              className="ml-auto text-xs font-bold text-red-400"
            >
              RECORDING
            </motion.div>
          )}
        </div>
      </div>

      {/* Transcript list */}
      <div ref={scrollRef} className="max-h-[400px] scroll-smooth space-y-0 overflow-y-auto overscroll-contain pb-4 pr-1 [scrollbar-gutter:stable]">
        <AnimatePresence mode="popLayout">
          {displayEntries.map((entry, index) => (
            <motion.button
              key={entry.id}
              layoutId={entry.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              onClick={() => onEntryClick?.(entry)}
              className="w-full border-b border-white/5 px-6 py-4 text-left transition hover:bg-white/5 active:bg-white/10"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Original</p>
                  <p className="mt-1 break-words text-sm text-slate-200">{entry.original}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Translated</p>
                  <p className="mt-1 break-words text-sm text-blue-200">{entry.translated}</p>
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-600">{entry.timestamp}</p>
            </motion.button>
          ))}

          {/* Current live entry */}
          {(currentOriginal || currentTranslation) && isRecording && (
            <motion.div
              key="current"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="border-b border-blue-500/20 bg-blue-500/5 px-6 py-4"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {currentOriginal && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-blue-400">
                      Speaking now...
                    </p>
                    <p className="mt-1 break-words text-sm text-slate-100">{currentOriginal}</p>
                  </div>
                )}
                {currentTranslation && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-blue-400">Translating...</p>
                    <p className="mt-1 break-words text-sm text-blue-100">{currentTranslation}</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {displayEntries.length === 0 && !currentOriginal && (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-slate-500">Start speaking to see transcripts here...</p>
          </div>
        )}
          <div ref={endRef} className="h-px" />
      </div>
    </motion.div>
  );
};

interface LanguageSelectorProps {
  sourceLang: string;
  targetLangs: string[];
  onSourceChange?: (lang: string) => void;
  onTargetToggle?: (lang: string) => void;
  disabled?: boolean;
  languages: Array<{ code: string; name: string; flag?: string }>;
}

/**
 * Premium language selector with grid layout
 */
export const LanguageSelector: React.FC<LanguageSelectorProps> = ({
  sourceLang,
  targetLangs,
  onSourceChange,
  onTargetToggle,
  disabled = false,
  languages,
}) => {
  const [showMore, setShowMore] = React.useState(false);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.05] to-transparent backdrop-blur-xl p-6"
    >
      {/* Source language */}
      <div className="mb-6">
        <label className="text-xs font-bold uppercase tracking-widest text-slate-400">Speaker Language</label>
        <select
          value={sourceLang}
          onChange={(e) => onSourceChange?.(e.target.value)}
          disabled={disabled}
          className="mt-3 w-full rounded-lg border border-white/10 bg-slate-950/50 px-4 py-2.5 text-sm font-semibold text-white outline-none transition focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {languages.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.flag && `${lang.flag} `}
              {lang.name}
            </option>
          ))}
        </select>
      </div>

      {/* Target languages */}
      <div>
        <label className="mb-3 block text-xs font-bold uppercase tracking-widest text-slate-400">
          Translation Targets
        </label>

        {/* Primary targets */}
        <div className="mb-4 grid grid-cols-auto gap-2">
          {languages
            .filter((lang) => lang.code !== sourceLang)
            .slice(0, showMore ? undefined : 6)
            .map((lang) => {
              const isActive = targetLangs.includes(lang.code);
              const isLocked = disabled || (!isActive && targetLangs.length >= 3);

              return (
                <motion.button
                  key={lang.code}
                  whileHover={{ scale: isLocked ? 1 : 1.05 }}
                  whileTap={{ scale: isLocked ? 1 : 0.95 }}
                  onClick={() => !isLocked && onTargetToggle?.(lang.code)}
                  disabled={isLocked}
                  className={`rounded-lg border px-3 py-2 text-xs font-bold uppercase transition ${
                    isActive
                      ? 'border-blue-400/50 bg-blue-500/30 text-blue-100 shadow-lg shadow-blue-500/20'
                      : 'border-white/10 bg-white/5 text-slate-400 hover:border-white/20 hover:text-white disabled:opacity-40'
                  }`}
                  title={lang.name}
                >
                  {lang.flag && `${lang.flag} `}
                  {lang.code.toUpperCase()}
                </motion.button>
              );
            })}
        </div>

        {/* Show more button */}
        {languages.length > 7 && (
          <button
            onClick={() => setShowMore(!showMore)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-400 transition hover:border-white/20 hover:text-white"
          >
            {showMore ? 'Show less' : 'Show more'}
            <ChevronDown className={`h-3 w-3 transition ${showMore ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
    </motion.div>
  );
};

interface ConnectionStatusProps {
  connected: boolean;
  reconnecting?: boolean;
  attemptCount?: number;
}

/**
 * Connection status banner
 */
export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  connected,
  reconnecting = false,
  attemptCount = 0,
}) => {
  return (
    <AnimatePresence>
      {!connected && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
        >
          <div className="flex items-center gap-3">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
            >
              <Zap className="h-4 w-4" />
            </motion.div>
            {reconnecting ? (
              <span>
                Reconnecting... <span className="font-semibold">Attempt {attemptCount}</span>
              </span>
            ) : (
              <span>Connection lost. Reconnecting...</span>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
