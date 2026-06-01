import { HeroSection } from "./HeroSection";
import { LanguageSelector } from "./LanguageSelector";
import { ModeTabs, type PrivacyMode } from "./ModeTabs";
import { Navbar } from "./Navbar";
import { ToolTabs, type ToolType } from "./ToolTabs";
import { TranslationOptions } from "./TranslationOptions";
import { TranslationPanel } from "./TranslationPanel";
import { LANGUAGE_CATALOG } from "../../../shared/languages.mjs";

interface DashboardProps {
  user?: { name: string; email: string; plan: string } | null;
  isAuthed?: boolean;
  isConnected: boolean;
  isRecording: boolean;
  isConnecting?: boolean;
  originalText: string;
  translatedText: string;
  elapsedSeconds: number;
  sourceLanguage: string;
  targetLanguage: string;
  mode: PrivacyMode;
  tool: ToolType;
  twoWayEnabled: boolean;
  threeWayEnabled?: boolean;
  onMicClick: () => void;
  onSourceLanguageChange: (language: string) => void;
  onTargetLanguageChange: (language: string) => void;
  onSwapLanguages: () => void;
  onTwoWayToggle: (enabled: boolean) => void;
  onThreeWayToggle?: (enabled: boolean) => void;
  onToolChange: (tool: ToolType) => void;
  onModeChange: (mode: PrivacyMode) => void;
  onNavigate?: (target: "dashboard" | "help" | "pricing" | "settings" | "login") => void;
  onLogout?: () => void;
}

const DASHBOARD_LANGUAGES = LANGUAGE_CATALOG.map(({ code, name }) => ({ code, name }));

export function Dashboard({
  user,
  isAuthed = false,
  isConnected,
  isRecording,
  isConnecting = false,
  originalText,
  translatedText,
  elapsedSeconds,
  sourceLanguage,
  targetLanguage,
  mode,
  tool,
  twoWayEnabled,
  threeWayEnabled = false,
  onMicClick,
  onSourceLanguageChange,
  onTargetLanguageChange,
  onSwapLanguages,
  onTwoWayToggle,
  onThreeWayToggle = () => undefined,
  onToolChange,
  onModeChange,
  onNavigate = () => undefined,
  onLogout
}: DashboardProps) {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-950">
      <Navbar user={user} isAuthed={isAuthed} onNavigate={onNavigate} onLogout={onLogout} />
      <main className="mx-auto w-full max-w-5xl space-y-8 px-4 pb-16">
        <HeroSection />
        <ModeTabs activeMode={mode} onChange={onModeChange} disabled={isRecording} />
        <ToolTabs activeTool={tool} onChange={onToolChange} disabled={isRecording} />
        <LanguageSelector
          languages={DASHBOARD_LANGUAGES}
          sourceLanguage={sourceLanguage}
          targetLanguage={targetLanguage}
          disabled={isRecording}
          onSourceChange={onSourceLanguageChange}
          onTargetChange={onTargetLanguageChange}
          onSwap={onSwapLanguages}
        />
        <TranslationOptions
          twoWayEnabled={twoWayEnabled}
          threeWayEnabled={threeWayEnabled}
          disabled={isRecording}
          onTwoWayToggle={onTwoWayToggle}
          onThreeWayToggle={onThreeWayToggle}
        />
        <TranslationPanel
          mode={tool}
          status={isConnecting ? "connecting" : isRecording ? "listening" : "idle"}
          statusLabel={isRecording ? "Live" : "Ready"}
          sourceLabel={sourceLanguage.toUpperCase()}
          targetLabel={targetLanguage.toUpperCase()}
          originalText={originalText}
          translations={[{ language: targetLanguage, label: targetLanguage.toUpperCase(), text: translatedText, state: translatedText ? "done" : "ready" }]}
          isConnected={isConnected}
          isRecording={isRecording || isConnecting}
          sessionSeconds={elapsedSeconds}
          chunkCount={0}
          lastLatency={null}
          historyCount={0}
          onMicClick={onMicClick}
          onClear={() => undefined}
          onSave={() => undefined}
        />
      </main>
    </div>
  );
}
