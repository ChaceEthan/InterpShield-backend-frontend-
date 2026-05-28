import { useEffect, useRef, useCallback, useState } from 'react';

interface SpeechRecognitionOptions {
  language?: string;
  continuous?: boolean;
  interimResults?: boolean;
  enabled?: boolean;
  onStart?: () => void;
  onEnd?: () => void;
  onResult?: (result: { transcript: string; isFinal: boolean }) => void;
  onError?: (error: string) => void;
  onNetworkError?: () => void;
}

interface SpeechRecognitionStatus {
  active: boolean;
  listening: boolean;
  hasPermission: boolean;
  error?: string;
}

// Get the appropriate SpeechRecognition API
const getSpeechRecognition = () => {
  if (typeof window === 'undefined') return null;
  const SpeechRecognition =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition ||
    null;
  return SpeechRecognition;
};

/**
 * Stable browser speech recognition hook with auto-restart and cleanup
 */
export const useSpeechRecognition = (options: SpeechRecognitionOptions = {}) => {
  const {
    language = 'en-US',
    continuous = true,
    interimResults = true,
    enabled = true,
    onStart,
    onEnd,
    onResult,
    onError,
    onNetworkError,
  } = options;

  const recognitionRef = useRef<any>(null);
  const isListeningRef = useRef(false);
  const restartTimeoutRef = useRef<number | null>(null);
  const isManualStopRef = useRef(false);
  const [status, setStatus] = useState<SpeechRecognitionStatus>({
    active: false,
    listening: false,
    hasPermission: false,
    error: undefined,
  });

  // Initialize recognition
  const initRecognition = useCallback(() => {
    if (!enabled) return;

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setStatus((prev) => ({
        ...prev,
        error: 'Speech Recognition not supported',
      }));
      return;
    }

    if (recognitionRef.current) return;

    try {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = continuous;
      recognitionRef.current.interimResults = interimResults;
      recognitionRef.current.language = language;
      recognitionRef.current.maxAlternatives = 1;

      // Start listening
      recognitionRef.current.onstart = () => {
        isListeningRef.current = true;
        setStatus((prev) => ({
          ...prev,
          active: true,
          listening: true,
          hasPermission: true,
          error: undefined,
        }));
        onStart?.();
      };

      // End listening
      recognitionRef.current.onend = () => {
        isListeningRef.current = false;
        setStatus((prev) => ({
          ...prev,
          listening: false,
        }));
        onEnd?.();

        // Auto-restart if not manually stopped
        if (!isManualStopRef.current && enabled && continuous) {
          if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
          restartTimeoutRef.current = window.setTimeout(() => {
            try {
              recognitionRef.current?.start();
            } catch (e) {
              // Browser already started, ignore
            }
          }, 100);
        }
      };

      // Process results
      recognitionRef.current.onresult = (event: any) => {
        let transcript = '';
        let isFinal = false;

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcriptSegment = event.results[i][0].transcript;
          transcript += transcriptSegment;

          if (event.results[i].isFinal) {
            isFinal = true;
          }
        }

        if (transcript.trim()) {
          onResult?.({
            transcript: transcript.trim(),
            isFinal,
          });
        }
      };

      // Handle errors
      recognitionRef.current.onerror = (event: any) => {
        const errorCode = event.error;

        // Don't report network errors if intentionally stopped
        if (isManualStopRef.current) return;

        if (errorCode === 'network') {
          setStatus((prev) => ({
            ...prev,
            error: 'Network error',
          }));
          onNetworkError?.();
        } else if (errorCode === 'no-speech') {
          // No-speech error is normal, don't treat as error
        } else if (errorCode === 'not-allowed') {
          setStatus((prev) => ({
            ...prev,
            hasPermission: false,
            error: 'Microphone permission denied',
          }));
          onError?.('Microphone permission denied');
        } else {
          setStatus((prev) => ({
            ...prev,
            error: errorCode,
          }));
          onError?.(errorCode);
        }
      };

      setStatus((prev) => ({
        ...prev,
        active: true,
      }));
    } catch (error) {
      setStatus((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to initialize',
      }));
    }
  }, [enabled, continuous, interimResults, language, onStart, onEnd, onResult, onError, onNetworkError]);

  // Start listening
  const start = useCallback(() => {
    if (!enabled) return false;

    try {
      if (!recognitionRef.current) {
        initRecognition();
      }

      isManualStopRef.current = false;
      recognitionRef.current?.start();
      return true;
    } catch (error) {
      // Already started or other error
      return false;
    }
  }, [enabled, initRecognition]);

  // Stop listening
  const stop = useCallback(() => {
    isManualStopRef.current = true;
    isListeningRef.current = false;

    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    try {
      recognitionRef.current?.stop();
    } catch (error) {
      // Already stopped
    }
  }, []);

  // Abort completely
  const abort = useCallback(() => {
    stop();
    try {
      recognitionRef.current?.abort();
    } catch (error) {
      // Already aborted
    }
  }, [stop]);

  // Update language
  const setLanguage = useCallback(
    (newLanguage: string) => {
      if (recognitionRef.current) {
        recognitionRef.current.language = newLanguage;
      }
    },
    []
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
      abort();
      recognitionRef.current = null;
    };
  }, [abort]);

  // Initialize on mount if enabled
  useEffect(() => {
    if (enabled) {
      initRecognition();
    }
  }, [enabled, initRecognition]);

  return {
    status,
    start,
    stop,
    abort,
    setLanguage,
    isActive: status.active,
    isListening: status.listening,
  };
};
