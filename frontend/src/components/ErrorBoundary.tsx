import type { ErrorInfo, ReactNode } from "react";
import React from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<any, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[InterpShield render error]", error, info);
  }

  render() {
    if (!this.state.error) return (this as any).props.children;

    return (
      <main className="grid min-h-screen place-items-center bg-gray-50 px-4 py-10 text-gray-900">
        <section className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-md shadow-gray-200/70">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-red-50 text-red-600">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold text-gray-950">InterpShield could not render</h1>
          <p className="mt-2 text-sm leading-6 text-gray-500">
            The app caught a frontend error instead of showing a blank screen. Refresh after the latest build finishes.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-xl bg-gray-50 p-3 text-left text-xs text-gray-600">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-200 transition hover:bg-blue-700"
          >
            <RefreshCcw className="h-4 w-4" />
            Reload
          </button>
        </section>
      </main>
    );
  }
}
