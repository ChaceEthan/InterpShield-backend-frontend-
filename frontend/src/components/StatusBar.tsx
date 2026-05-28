import type { ReactNode } from "react";
import { Activity, Clock3, Radio, Wifi, WifiOff } from "lucide-react";

interface StatusBarProps {
  isConnected: boolean;
  elapsedSeconds: number;
  chunkCount?: number;
  lastLatency?: number | null;
  sessionActive: boolean;
}

export function StatusBar({ isConnected, elapsedSeconds, chunkCount = 0, lastLatency, sessionActive }: StatusBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-xs font-medium text-gray-500">
      <StatusPill
        icon={isConnected ? <Wifi className="h-3.5 w-3.5 text-emerald-500" /> : <WifiOff className="h-3.5 w-3.5 text-red-500" />}
        label={isConnected ? "Connected" : "Disconnected"}
      />
      <StatusPill icon={<Clock3 className="h-3.5 w-3.5 text-gray-400" />} label={sessionActive ? formatTime(elapsedSeconds) : "00:00"} mono />
      <StatusPill icon={<Radio className="h-3.5 w-3.5 text-gray-400" />} label={chunkCount > 0 ? `${chunkCount} chunks` : "Ready"} />
      {typeof lastLatency === "number" && (
        <StatusPill icon={<Activity className="h-3.5 w-3.5 text-emerald-500" />} label={`${lastLatency}ms`} />
      )}
    </div>
  );
}

function StatusPill({ icon, label, mono = false }: { icon: ReactNode; label: string; mono?: boolean }) {
  return (
    <span className="inline-flex min-h-8 items-center gap-2 rounded-full border border-gray-200 bg-white px-3 shadow-sm">
      {icon}
      <span className={mono ? "font-mono text-gray-700" : ""}>{label}</span>
    </span>
  );
}

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  }

  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}
