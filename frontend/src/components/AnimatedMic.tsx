import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Mic, Square } from 'lucide-react';

interface AnimatedMicProps {
  active: boolean;
  loading?: boolean;
  audioLevel?: number;
  onClick?: () => void;
  onStop?: () => void;
}

/**
 * Premium animated microphone button with waveform glow
 */
export const AnimatedMic: React.FC<AnimatedMicProps> = ({
  active,
  loading = false,
  audioLevel = 0,
  onClick,
  onStop,
}) => {
  const [glowIntensity, setGlowIntensity] = useState(0);

  // Animate glow based on audio level
  useEffect(() => {
    const interval = setInterval(() => {
      setGlowIntensity((prev) => {
        const target = active ? Math.max(audioLevel, 0.3) : 0.1;
        return prev * 0.8 + target * 0.2;
      });
    }, 50);

    return () => clearInterval(interval);
  }, [active, audioLevel]);

  const handleClick = () => {
    if (active && onStop) {
      onStop();
    } else if (!active && onClick) {
      onClick();
    }
  };

  return (
    <div className="relative inline-flex items-center justify-center">
      {/* Outer glow ring */}
      {active && (
        <motion.div
          className="absolute inset-0 rounded-full border-2 border-blue-500/20"
          style={{
            width: 'calc(100% + 16px)',
            height: 'calc(100% + 16px)',
            boxShadow: `0 0 ${24 + glowIntensity * 16}px rgba(59, 130, 246, ${0.3 + glowIntensity * 0.4})`,
          }}
          animate={{
            scale: [1, 1.1, 1],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
          }}
        />
      )}

      {/* Middle ring */}
      {active && (
        <motion.div
          className="absolute inset-0 rounded-full border border-blue-400/30"
          style={{
            width: 'calc(100% + 8px)',
            height: 'calc(100% + 8px)',
          }}
          animate={{
            scale: [1, 1.05, 1],
          }}
          transition={{
            duration: 1.5,
            repeat: Infinity,
            delay: 0.2,
          }}
        />
      )}

      {/* Main button */}
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={handleClick}
        disabled={loading}
        className={`relative z-10 flex h-20 w-20 items-center justify-center rounded-full font-bold text-white shadow-2xl transition-all ${
          active
            ? 'bg-gradient-to-br from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 shadow-red-950/50'
            : 'bg-gradient-to-br from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 shadow-blue-950/50'
        } ${loading ? 'cursor-wait opacity-75' : ''}`}
      >
        {loading ? (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
          >
            <Mic className="h-8 w-8" />
          </motion.div>
        ) : active ? (
          <motion.div animate={{ scale: [1, 1.1, 1] }} transition={{ duration: 0.5, repeat: Infinity }}>
            <Square className="h-8 w-8 fill-current" />
          </motion.div>
        ) : (
          <Mic className="h-8 w-8" />
        )}
      </motion.button>

      {/* Audio level indicator bars */}
      {active && (
        <div className="absolute inset-0 flex items-center justify-center gap-1">
          {[...Array(5)].map((_, i) => (
            <motion.div
              key={i}
              className="w-1 rounded-full bg-gradient-to-t from-blue-400 to-blue-300"
              style={{
                height: '8px',
              }}
              animate={{
                height: [8, 4 + glowIntensity * 12, 8],
              }}
              transition={{
                duration: 0.3,
                delay: i * 0.05,
                repeat: Infinity,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface LiveIndicatorProps {
  active: boolean;
  label?: string;
}

/**
 * Live recording indicator
 */
export const LiveIndicator: React.FC<LiveIndicatorProps> = ({ active, label = 'LIVE' }) => (
  <motion.div
    className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-black uppercase tracking-widest ${
      active
        ? 'bg-red-500/20 text-red-300 border border-red-400/30'
        : 'bg-slate-700/20 text-slate-400 border border-slate-600/30'
    }`}
  >
    {active && (
      <motion.div
        className="h-2 w-2 rounded-full bg-red-500"
        animate={{ scale: [1, 1.3, 1] }}
        transition={{ duration: 0.8, repeat: Infinity }}
      />
    )}
    {label}
  </motion.div>
);

interface SessionTimerProps {
  seconds: number;
  maxSeconds?: number;
}

/**
 * Session timer display
 */
export const SessionTimer: React.FC<SessionTimerProps> = ({ seconds, maxSeconds }) => {
  const formatTime = (totalSeconds: number) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const isNearLimit = maxSeconds && seconds > maxSeconds * 0.9;

  return (
    <div className={`font-mono text-lg font-black tracking-wider ${isNearLimit ? 'text-red-400' : 'text-blue-300'}`}>
      {formatTime(seconds)}
    </div>
  );
};
