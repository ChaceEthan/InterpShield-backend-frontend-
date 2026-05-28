import React from 'react';
import { motion } from 'motion/react';

interface GlassPanelProps {
  children: React.ReactNode;
  className?: string;
  animated?: boolean;
}

/**
 * Premium glassmorphism panel component
 */
export const GlassPanel: React.FC<GlassPanelProps> = ({ children, className = '', animated = false }) => {
  if (animated) {
    return (
      <motion.section
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className={`rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.04] shadow-2xl shadow-slate-950/40 backdrop-blur-2xl ${className}`}
      >
        {children}
      </motion.section>
    );
  }

  return (
    <section className={`rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.04] shadow-2xl shadow-slate-950/40 backdrop-blur-2xl ${className}`}>
      {children}
    </section>
  );
};

interface GradientTextProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Animated gradient text
 */
export const GradientText: React.FC<GradientTextProps> = ({ children, className = '' }) => (
  <span className={`bg-gradient-to-r from-blue-400 via-blue-300 to-cyan-300 bg-clip-text text-transparent ${className}`}>
    {children}
  </span>
);

interface AnimatedIconProps {
  icon: React.ReactNode;
  className?: string;
  pulse?: boolean;
  glow?: 'blue' | 'emerald' | 'none';
}

/**
 * Animated icon with optional glow
 */
export const AnimatedIcon: React.FC<AnimatedIconProps> = ({
  icon,
  className = '',
  pulse = false,
  glow = 'none',
}) => {
  const glowClasses = {
    blue: 'text-blue-400 drop-shadow-lg drop-shadow-blue-500/50',
    emerald: 'text-emerald-400 drop-shadow-lg drop-shadow-emerald-500/50',
    none: 'text-slate-300',
  };

  const animationClasses = pulse ? 'animate-pulse' : '';

  return (
    <motion.div
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.95 }}
      className={`${glowClasses[glow]} ${animationClasses} ${className}`}
    >
      {icon}
    </motion.div>
  );
};

interface StatusBadgeProps {
  status: 'active' | 'idle' | 'connecting' | 'error' | 'disconnected';
  label?: string;
  className?: string;
}

/**
 * Status indicator badge
 */
export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, label, className = '' }) => {
  const statusConfig = {
    active: {
      bg: 'bg-emerald-500/15',
      border: 'border-emerald-400/30',
      dot: 'bg-emerald-500',
      text: 'text-emerald-200',
      pulse: true,
    },
    idle: {
      bg: 'bg-slate-700/30',
      border: 'border-slate-600/30',
      dot: 'bg-slate-400',
      text: 'text-slate-300',
      pulse: false,
    },
    connecting: {
      bg: 'bg-blue-500/15',
      border: 'border-blue-400/30',
      dot: 'bg-blue-500',
      text: 'text-blue-200',
      pulse: true,
    },
    error: {
      bg: 'bg-red-500/15',
      border: 'border-red-400/30',
      dot: 'bg-red-500',
      text: 'text-red-200',
      pulse: true,
    },
    disconnected: {
      bg: 'bg-amber-500/15',
      border: 'border-amber-400/30',
      dot: 'bg-amber-500',
      text: 'text-amber-200',
      pulse: true,
    },
  };

  const config = statusConfig[status];

  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${config.bg} ${config.border} ${config.text} ${className}`}>
      <div className={`h-2 w-2 rounded-full ${config.dot} ${config.pulse ? 'animate-pulse' : ''}`} />
      {label || status.charAt(0).toUpperCase() + status.slice(1)}
    </div>
  );
};

interface DualLanguageDisplayProps {
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  targetText: string;
  sourceFlag?: string;
  targetFlag?: string;
}

/**
 * Side-by-side language display
 */
export const DualLanguageDisplay: React.FC<DualLanguageDisplayProps> = ({
  sourceLang,
  targetLang,
  sourceText,
  targetText,
  sourceFlag = '🌐',
  targetFlag = '🌐',
}) => (
  <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
    {/* Source */}
    <GlassPanel className="p-6">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-2xl">{sourceFlag}</span>
        <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Speaker</span>
        <span className="ml-auto font-mono text-sm font-black text-slate-300">{sourceLang.toUpperCase()}</span>
      </div>
      <div className="break-words text-lg leading-relaxed text-white">
        {sourceText || <span className="text-slate-500 italic">Waiting for speech...</span>}
      </div>
    </GlassPanel>

    {/* Target */}
    <GlassPanel className="p-6">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-2xl">{targetFlag}</span>
        <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Translation</span>
        <span className="ml-auto font-mono text-sm font-black text-blue-300">{targetLang.toUpperCase()}</span>
      </div>
      <div className="break-words text-lg leading-relaxed text-blue-50">
        {targetText || <span className="text-slate-600 italic">Translation will appear here...</span>}
      </div>
    </GlassPanel>
  </div>
);
