import { Languages, Volume2 } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

export interface TranscriptTranslationEntry {
  language: string;
  label: string;
  text: string;
  state: string;
  diagnostic?: string;
}

interface TranscriptAreaProps {
  mode: "transcribe" | "translate" | "dubbing";
  originalText: string;
  interimText?: string;
  translations: TranscriptTranslationEntry[];
  isRecording: boolean;
  onSpeakTranslation?: (language: string, text: string) => void;
}

export function TranscriptArea({ mode, originalText, interimText = "", translations, isRecording, onSpeakTranslation }: TranscriptAreaProps) {
  const visibleOriginal = interimText || originalText;
  const hasTranslations = translations.some((entry) => entry.text.trim());
  const isTranscribe = mode === "transcribe";
  return (
    <div      className="mx-auto flex min-h-[220px] w-full min-w-0 max-w-4xl flex-col gap-4 px-1 pb-5 pt-2"
    >
      <AnimatePresence mode="popLayout">
        {visibleOriginal ? (
          <motion.article
            key="source-card"
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="min-w-0 rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm sm:p-6"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Live subtitles</span>
              {isRecording && <span className="h-2 w-2 rounded-full bg-red-500 shadow-sm shadow-red-200" />}
            </div>
            <p className="break-words text-lg font-medium leading-8 text-gray-950 sm:text-xl">{visibleOriginal}</p>
          </motion.article>
        ) : (
          <motion.div
            key="empty-card"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="grid min-h-[190px] place-items-center rounded-2xl border border-dashed border-gray-200 bg-white/70 p-8 text-center"
          >
            <div>
              <div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-blue-50 text-blue-600">
                <Languages className="h-5 w-5" />
              </div>
              <p className="mt-4 text-sm font-medium text-gray-500">
                {isRecording ? "Waiting for more speech…" : "Press and start talking"}
              </p>
            </div>
          </motion.div>
        )}

        {!isTranscribe && (hasTranslations || isRecording) && (
          <motion.div
            key="translation-grid"
            layout
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="grid grid-cols-1 gap-3 md:grid-cols-3"
          >
            {translations.map((entry) => (
              <motion.article
                layout
                key={entry.language}
                role={entry.text && onSpeakTranslation ? "button" : undefined}
                tabIndex={entry.text && onSpeakTranslation ? 0 : undefined}
                aria-label={entry.text && onSpeakTranslation ? `Speak ${entry.label} translation` : undefined}
                onClick={() => { if (entry.text) onSpeakTranslation?.(entry.language, entry.text); }}
                onKeyDown={(event) => {
                  if (!entry.text || !onSpeakTranslation || (event.key !== "Enter" && event.key !== " ")) return;
                  event.preventDefault();
                  onSpeakTranslation(entry.language, entry.text);
                }}
                className={`min-w-0 rounded-2xl border border-blue-100 bg-blue-50/80 p-4 text-left shadow-sm ${entry.text && onSpeakTranslation ? "cursor-pointer transition hover:border-blue-300 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-400" : ""}`}
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className="min-w-0 break-words text-xs font-semibold uppercase tracking-wide text-blue-700">{entry.label}</span>
                  <span className="flex items-center gap-1.5">
                    {entry.text && onSpeakTranslation && <Volume2 className="h-4 w-4 text-blue-600" aria-hidden="true" />}
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 shadow-sm">{entry.state}</span>
                  </span>
                </div>
                <p className="min-h-16 break-words text-base font-semibold leading-7 text-gray-950">
                  {entry.text || (isRecording ? "Translating..." : "Translation will appear here.")}
                </p>
                {entry.diagnostic && (
                  <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg border border-red-200 bg-white/80 p-3 text-xs font-semibold leading-5 text-red-800">
                    {entry.diagnostic}
                  </pre>
                )}
              </motion.article>
            ))}
          </motion.div>
        )}
      </AnimatePresence>    </div>
  );
}
