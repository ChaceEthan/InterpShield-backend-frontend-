import { Crown, HelpCircle, LogIn, LogOut, Settings, Shield, Sparkles } from "lucide-react";
import { isAdminRole } from "../auth/roles.mjs";

export type NavTarget = "dashboard" | "help" | "pricing" | "settings" | "login" | "admin";

interface NavbarProps {
  user?: { name: string; email: string; plan: string; role?: string } | null;
  isAuthed?: boolean;
  onNavigate: (target: NavTarget) => void;
  onLogout?: () => void;
}

export function Navbar({ user, isAuthed = false, onNavigate, onLogout }: NavbarProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-gray-100 bg-white/90 backdrop-blur-xl">
      <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <button
          type="button"
          onClick={() => onNavigate("dashboard")}
          className="flex min-w-0 items-center gap-2 rounded-xl px-1 py-2 text-left transition hover:opacity-80"
          aria-label="Go to InterpShield live translate"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-200">
            <Shield className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-base font-semibold text-gray-950">InterpShield</span>
          </span>
        </button>

        <nav className="hidden items-center gap-1 text-sm font-medium text-gray-600 md:flex">
          <button type="button" onClick={() => onNavigate("help")} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 transition hover:bg-gray-50 hover:text-gray-950">
            <HelpCircle className="h-4 w-4" />
            Help
          </button>
          <button type="button" onClick={() => onNavigate("pricing")} className="rounded-xl px-3 py-2 transition hover:bg-gray-50 hover:text-gray-950">
            Pricing
          </button>
          <button type="button" onClick={() => onNavigate("settings")} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 transition hover:bg-gray-50 hover:text-gray-950">
            <Settings className="h-4 w-4" />
            Settings
          </button>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {user?.plan === "pro" && (
            <span className="hidden items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 sm:inline-flex">
              <Crown className="h-3.5 w-3.5" />
              Pro
            </span>
          )}

          {isAuthed ? (
            <>
              <button
                type="button"
                onClick={() => onNavigate("settings")}
                className="hidden rounded-full bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 sm:block"
              >
                {user?.name?.split(" ")[0] || "Account"}
              </button>
              <button
                type="button"
                onClick={onLogout}
                className="grid h-9 w-9 place-items-center rounded-full border border-gray-200 bg-white text-gray-500 transition hover:bg-gray-50 hover:text-gray-900"
                aria-label="Log out"
                title="Log out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate("login")}
              className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 hover:text-gray-950"
            >
              <LogIn className="h-4 w-4" />
              Login
            </button>
          )}

          {!isAdminRole(user?.role) && <button
            type="button"
            onClick={() => onNavigate("pricing")}
            className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-200 transition hover:bg-blue-700"
          >
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">Get Pro</span>
            <span className="sm:hidden">Pro</span>
          </button>}
        </div>
      </div>
    </header>
  );
}
