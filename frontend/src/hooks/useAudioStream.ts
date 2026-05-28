import { useCallback, useRef, useState } from 'react';

interface AudioStreamOptions {
  microphoneId?: string;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

interface AudioLevel {
  current: number;
  peak: number;
  smoothed: number;
}

/**
 * Audio stream utilities with Web Audio API enhancements
 */
export const useAudioStream = () => {
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const [audioLevel, setAudioLevel] = useState<AudioLevel>({
    current: 0,
    peak: 0,
    smoothed: 0,
  });
  const smoothedLevelRef = useRef(0);

  // Build audio constraints
  const buildConstraints = useCallback(
    (options: AudioStreamOptions): MediaTrackConstraints => {
      const supportedConstraints =
        typeof navigator !== 'undefined' && navigator.mediaDevices?.getSupportedConstraints
          ? navigator.mediaDevices.getSupportedConstraints()
          : {};

      const audio: MediaTrackConstraints = {};

      if (supportedConstraints.echoCancellation) audio.echoCancellation = options.echoCancellation ?? true;
      if (supportedConstraints.noiseSuppression) audio.noiseSuppression = options.noiseSuppression ?? true;
      if (supportedConstraints.autoGainControl) audio.autoGainControl = options.autoGainControl ?? true;
      if (supportedConstraints.sampleRate) audio.sampleRate = { ideal: 48000 };
      if (supportedConstraints.channelCount) audio.channelCount = { ideal: 1 };
      if (supportedConstraints.sampleSize) audio.sampleSize = { ideal: 16 };

      if (options.microphoneId && options.microphoneId !== 'default') {
        audio.deviceId = { exact: options.microphoneId };
      }

      return audio;
    },
    []
  );

  // Request microphone access
  const requestMicrophone = useCallback(
    async (options: AudioStreamOptions = {}): Promise<MediaStream> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: buildConstraints(options),
        });

        streamRef.current = stream;
        return stream;
      } catch (error) {
        throw new Error(`Microphone access denied: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
    [buildConstraints]
  );

  // Create enhanced audio context with processing
  const createEnhancedStream = useCallback(
    (stream: MediaStream): MediaStream => {
      const AudioContextCtor =
        typeof window !== 'undefined'
          ? (window as any).AudioContext || (window as any).webkitAudioContext
          : null;

      if (!AudioContextCtor) {
        return stream;
      }

      try {
        const audioContext = new AudioContextCtor();
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        const highPass = audioContext.createBiquadFilter();
        const lowPass = audioContext.createBiquadFilter();
        const gainNode = audioContext.createGain();
        const compressor = audioContext.createDynamicsCompressor();
        const analyser = audioContext.createAnalyser();
        const destination = audioContext.createMediaStreamDestination();

        // High-pass filter (remove low rumble)
        highPass.type = 'highpass';
        highPass.frequency.value = 85;
        highPass.Q.value = 0.7;

        // Low-pass filter (remove high noise)
        lowPass.type = 'lowpass';
        lowPass.frequency.value = 7600;
        lowPass.Q.value = 0.8;

        // Gentle gain boost
        gainNode.gain.value = 1.35;

        // Dynamic range compression
        compressor.threshold.value = -30;
        compressor.knee.value = 28;
        compressor.ratio.value = 4.5;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.22;

        // Analyser for level detection
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.72;
        analyserRef.current = analyser;

        // Chain: source -> highPass -> lowPass -> compressor -> gain -> analyser -> destination
        source.connect(highPass);
        highPass.connect(lowPass);
        lowPass.connect(compressor);
        compressor.connect(gainNode);
        gainNode.connect(analyser);
        analyser.connect(destination);

        return destination.stream;
      } catch {
        return stream;
      }
    },
    []
  );

  // Get current audio level
  const getAudioLevel = useCallback((): AudioLevel => {
    if (!analyserRef.current) {
      return { current: 0, peak: 0, smoothed: 0 };
    }

    const timeDomainData = new Uint8Array(analyserRef.current.fftSize);
    analyserRef.current.getByteTimeDomainData(timeDomainData);

    let sumSquares = 0;
    for (let i = 0; i < timeDomainData.length; i++) {
      const centeredSample = (timeDomainData[i] - 128) / 128;
      sumSquares += centeredSample * centeredSample;
    }

    const rms = Math.sqrt(sumSquares / timeDomainData.length);
    smoothedLevelRef.current = smoothedLevelRef.current * 0.75 + rms * 0.25;

    const level: AudioLevel = {
      current: rms,
      peak: rms > smoothedLevelRef.current ? rms : smoothedLevelRef.current,
      smoothed: smoothedLevelRef.current,
    };

    setAudioLevel(level);
    return level;
  }, []);

  // Stop and cleanup
  const stop = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    analyserRef.current = null;
    smoothedLevelRef.current = 0;
  }, []);

  return {
    stream: streamRef.current,
    audioLevel,
    requestMicrophone,
    createEnhancedStream,
    getAudioLevel,
    stop,
  };
};

// Get supported mime types for audio recording
export const getSupportedAudioMimeType = (): string => {
  if (typeof window === 'undefined' || !('MediaRecorder' in window)) return '';

  const mimeTypes = [
    'audio/webm',
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];

  for (const mimeType of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return '';
};
