'use client';

// Re-export the active-pack helpers as a hook + a small badge that
// shows which pack is currently active in the top bar.

import { useSyncExternalStore } from 'react';
import { getActivePack, setActivePack, clearActivePack } from './use-design-systems';

const KNOWN_LABELS: Record<string, string> = {
  'shadcn-default': 'shadcn/ui',
  'vercel-geist': 'Vercel Geist',
  'mantine-default': 'Mantine',
};

export function humanifyPackName(name: string | null): string {
  if (!name) return 'Auto';
  return KNOWN_LABELS[name] ?? name;
}

// ── useSyncExternalStore for cross-component, cross-tab sync ────────
//
// We can't use a normal useEffect+setState here because the lint rule
// `react-hooks/set-state-in-effect` flags it. useSyncExternalStore is
// the canonical pattern for "subscribe to an external store" — which
// is exactly what localStorage is.

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('design-system:change', callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener('design-system:change', callback);
    window.removeEventListener('storage', callback);
  };
}

function getSnapshot(): string | null {
  if (typeof window === 'undefined') return null;
  return getActivePack();
}

function getServerSnapshot(): string | null {
  return null;
}

/**
 * Subscribe to the active pack. Re-renders on `design-system:change`
 * events (fired by `setActivePack` / `clearActivePack`) and on
 * cross-tab `storage` events.
 */
export function useActivePack(): {
  pack: string | null;
  label: string;
  set: (name: string) => void;
  clear: () => void;
} {
  const pack = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    pack,
    label: humanifyPackName(pack),
    set: (name: string) => setActivePack(name),
    clear: () => clearActivePack(),
  };
}

