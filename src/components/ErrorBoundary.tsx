'use client';

// App-level error boundary (2026-09-07 UI hardening) — the ENTIRE app had no
// boundary anywhere in src/: any render-time crash (a malformed store state
// from a poisoned localStorage blob, a malformed agent event slipping past
// the ingest guards, a bad persisted setting) unmounted the whole React tree
// = white screen, recoverable only by clearing site data. This boundary
// catches, logs, and offers a one-click reload. Local UI state is lost, but
// the canvas + transcripts live server-side (journal + snapshots) and come
// back on reload — the user gets a door back in instead of a blank tab.
import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Console only — the app's observability lane (console + toasts) has no
    // remote sink, and a boundary failure must never itself throw.
    console.error('[ErrorBoundary] UI crash:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const message = String(this.state.error.message ?? this.state.error);
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 p-8 text-neutral-100">
          <div className="max-w-md space-y-4 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10 text-xl">
              !
            </div>
            <h1 className="text-lg font-semibold">Something broke</h1>
            <p className="text-sm text-neutral-400">
              The interface hit an unexpected error. Reloading usually fixes it — your canvas
              and chats live on the server and come back with the reload.
            </p>
            <pre className="max-h-32 overflow-auto rounded-md bg-neutral-900 p-2 text-left text-[10px] text-neutral-500">
              {message}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-neutral-700 transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
