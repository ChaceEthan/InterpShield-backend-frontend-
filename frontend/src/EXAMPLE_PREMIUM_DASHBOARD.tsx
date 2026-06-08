import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Menu, Settings, LogOut, History } from 'lucide-react';

// Import premium hooks
import { useSocket } from './hooks/useSocket';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { useAuth } from './hooks/useAuth';
import { useAudioStream, getSupportedAudioMimeType } from './hooks/useAudioStream';

// Import premium components
import { GlassPanel, StatusBadge, AnimatedIcon } from './components/GlassUI';
import { AnimatedMic, LiveIndicator, SessionTimer } from './components/AnimatedMic';
import { LiveTranscriptPanel, LanguageSelector, ConnectionStatus } from './components/TranscriptPanel';
import { LANGUAGE_CATALOG, LANGUAGE_FLAGS } from '../../shared/languages.mjs';

const SUPPORTED_LANGUAGES = LANGUAGE_CATALOG.map(({ code, name }) => ({
  code,
  name,
  flag: LANGUAGE_FLAGS[code]
}));

/**
 * Premium Dashboard Component with Real-time AI Interpretation
 * Inspired by Maestra AI Live Translate
 */
export default function PremiumDashboard() {
  // ============ STATE MANAGEMENT ============
  const [sourceLang, setSourceLang] = useState('en');
  const [targetLangs, setTargetLangs] = useState(['es']);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [transcripts, setTranscripts] = useState<Array<{
    id: string;
    original: string;
    translated: string;
    timestamp: string;
    sourceLang: string;
    targetLang: string;
  }>>([]);
  const [currentOriginal, setCurrentOriginal] = useState('');
  const [currentTranslation, setCurrentTranslation] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ============ HOOK INTEGRATION ============
  const auth = useAuth();
  const { socket, status: socketStatus, emit } = useSocket({
    token: auth.token,
    enabled: auth.isAuthed,
    onConnect: () => console.log('Socket connected'),
    onDisconnect: (reason) => console.log('Socket disconnected:', reason),
    onReconnect: (attempt) => console.log('Reconnect attempt:', attempt),
  });

  const speech = useSpeechRecognition({
    language: `${sourceLang}-US`,
    continuous: true,
    interimResults: true,
    enabled: isRecording && auth.isAuthed,
    onStart: () => console.log('Speech recognition started'),
    onEnd: () => console.log('Speech recognition ended'),
    onResult: ({ transcript, isFinal }) => {
      setCurrentOriginal(transcript);
      
      if (isFinal) {
        // Send to backend for translation
        emit('audio_chunk', {
          text: transcript,
          sourceLang,
          targetLang: targetLangs[0],
          isFinal: true,
        });
      }
    },
    onError: (error) => console.error('Speech error:', error),
  });

  const audio = useAudioStream();

  // ============ SESSION TIMER ============
  useEffect(() => {
    if (!isRecording) return;

    const interval = setInterval(() => {
      setSessionSeconds((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [isRecording]);

  // ============ SOCKET EVENT LISTENERS ============
  useEffect(() => {
    if (!socket) return;

    const handleTranslationUpdate = (data: any) => {
      setCurrentTranslation(data.text || data.translatedText || '');

      // Add to transcript history when final
      if (data.complete || data.isFinal) {
        setTranscripts((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random()}`,
            original: data.original || currentOriginal,
            translated: data.text || data.translatedText || '',
            timestamp: new Date().toLocaleTimeString(),
            sourceLang,
            targetLang: targetLangs[0],
          },
        ]);

        setCurrentOriginal('');
        setCurrentTranslation('');
      }
    };

    socket.on('translation_update', handleTranslationUpdate);

    return () => {
      socket.off('translation_update', handleTranslationUpdate);
    };
  }, [socket, sourceLang, targetLangs, currentOriginal]);

  // ============ START/STOP RECORDING ============
  const handleStartRecording = async () => {
    if (!auth.isAuthed) {
      alert('Please log in first');
      return;
    }

    try {
      // Request microphone access
      const stream = await audio.requestMicrophone({
        microphoneId: 'default',
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });

      // Create enhanced audio stream
      const enhanced = audio.createEnhancedStream(stream);

      // Start recording
      setIsRecording(true);
      speech.start();
      setSessionSeconds(0);

      // Emit session start to backend
      emit('session:start', {
        sourceLang,
        targetLanguages: targetLangs,
        translate: true,
        mimeType: getSupportedAudioMimeType(),
        audioProfile: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        userPlan: auth.user?.plan || 'free',
      });

      console.log('Recording started');
    } catch (error) {
      console.error('Failed to start recording:', error);
      alert('Could not access microphone. Please check permissions.');
    }
  };

  const handleStopRecording = () => {
    setIsRecording(false);
    speech.stop();
    audio.stop();

    emit('session:stop');
    console.log('Recording stopped');
  };

  // ============ LANGUAGE CONTROLS ============
  const handleSourceLangChange = (lang: string) => {
    setSourceLang(lang);
    speech.setLanguage(`${lang}-US`);
  };

  const handleTargetLangToggle = (lang: string) => {
    setTargetLangs((prev) => {
      if (prev.includes(lang)) {
        return prev.filter((l) => l !== lang);
      }
      if (prev.length >= 3) {
        return [lang];
      }
      return [...prev, lang];
    });
  };

  // ============ NOT AUTHENTICATED ============
  if (!auth.isAuthed) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-slate-950 to-slate-900 px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center"
        >
          <h1 className="mb-4 text-4xl font-black text-white md:text-6xl">
            InterpShield
          </h1>
          <p className="mb-8 text-lg text-slate-400">
            Premium Live Translation & AI Interpretation
          </p>
          <button
            onClick={() => auth.login('demo@example.com', 'password')}
            disabled={auth.isLoading}
            className="rounded-lg bg-blue-600 px-8 py-3 font-bold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {auth.isLoading ? 'Loading...' : 'Sign In'}
          </button>
        </motion.div>
      </div>
    );
  }

  // ============ AUTHENTICATED DASHBOARD ============
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-4 py-8">
      {/* Header */}
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black text-white">InterpShield</h1>
          <p className="mt-1 text-sm text-slate-400">Live Interpretation & Translation</p>
        </div>
        <div className="flex items-center gap-4">
          <StatusBadge status={socketStatus.connected ? 'active' : 'disconnected'} />
          <button
            onClick={() => setSettingsOpen(!settingsOpen)}
            className="rounded-lg border border-white/10 p-2 hover:bg-white/5"
          >
            <Settings className="h-5 w-5" />
          </button>
          <button
            onClick={() => auth.logout()}
            className="rounded-lg border border-white/10 p-2 hover:bg-white/5"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* Connection Status Banner */}
      <ConnectionStatus
        connected={socketStatus.connected}
        reconnecting={socketStatus.reconnecting}
        attemptCount={socketStatus.attemptCount}
      />

      {/* Main Content */}
      <div className="mx-auto max-w-6xl space-y-8">
        {/* Language Configuration */}
        <LanguageSelector
          sourceLang={sourceLang}
          targetLangs={targetLangs}
          onSourceChange={handleSourceLangChange}
          onTargetToggle={handleTargetLangToggle}
          languages={SUPPORTED_LANGUAGES}
          disabled={isRecording}
        />

        {/* Recording Controls */}
        <GlassPanel className="p-8" animated>
          <div className="flex flex-col items-center gap-8 sm:flex-row sm:justify-between">
            <div className="text-center sm:text-left">
              <div className="flex items-center gap-3">
                <LiveIndicator active={isRecording} />
                <SessionTimer seconds={sessionSeconds} maxSeconds={3600} />
              </div>
              <p className="mt-2 text-sm text-slate-400">
                {isRecording ? 'Recording in progress...' : 'Ready to start'}
              </p>
            </div>

            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <AnimatedMic
                active={isRecording}
                loading={speech.status.active && !speech.status.listening}
                audioLevel={audio.audioLevel.smoothed}
                onClick={handleStartRecording}
                onStop={handleStopRecording}
              />
            </div>
          </div>
        </GlassPanel>

        {/* Transcripts */}
        <LiveTranscriptPanel
          entries={transcripts}
          currentOriginal={currentOriginal}
          currentTranslation={currentTranslation}
          isRecording={isRecording}
          maxEntries={20}
        />

        {/* Current Translation Display */}
        {(currentOriginal || currentTranslation) && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="grid gap-6 lg:grid-cols-2"
          >
            {/* Source */}
            <GlassPanel className="p-6">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">
                {sourceLang.toUpperCase()} - Speaker
              </p>
              <p className="text-lg text-white">{currentOriginal}</p>
            </GlassPanel>

            {/* Translation */}
            <GlassPanel className="p-6">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-blue-400">
                {targetLangs[0].toUpperCase()} - Translation
              </p>
              <p className="text-lg text-blue-50">{currentTranslation}</p>
            </GlassPanel>
          </motion.div>
        )}
      </div>

      {/* Settings Panel */}
      <AnimatePresence>
        {settingsOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
            onClick={() => setSettingsOpen(false)}
          >
            <div onClick={(event: React.MouseEvent<HTMLDivElement>) => event.stopPropagation()}>
              <GlassPanel className="max-w-md p-6">
                <h3 className="mb-6 text-xl font-bold">Settings</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-300">
                      Microphone: {audio.stream?.getAudioTracks()?.[0]?.label || 'Default'}
                    </label>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-300">
                      WebSocket Status: {socketStatus.connected ? 'Connected' : socketStatus.reconnecting ? 'Reconnecting...' : 'Ready'}
                    </label>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-300">
                      Speech Recognition: {speech.status.active ? 'Ready' : 'Inactive'}
                    </label>
                  </div>
                </div>
              </GlassPanel>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
