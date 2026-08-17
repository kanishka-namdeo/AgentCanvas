'use client';

// Theme toggle — flips between light, dark, and system by adding/removing the
// `.dark` class on <html>. Cycles through the three modes on click.
//
// Source of truth: the settings store (`useSettings.themePreference`).
// Falls back to the legacy `agentcanvas-theme` localStorage key for backward
// compat with sessions saved before the settings workflow existed.
//
// The dark-mode token variant is defined in `src/app/globals.css` under the
// `.dark` selector — it redefines every `--ac-*` token, so all components
// that consume the tokens via `.ac-text-*` / `.ac-border-*` / `.ac-surface-*`
// utility classes pick up the dark values automatically.

import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useSettings } from '@/lib/settings/store';
import type { ThemePreference } from '@/lib/settings/types';

const LEGACY_STORAGE_KEY = 'agentcanvas-theme';

function getInitialTheme(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  // Prefer the settings store's persisted value.
  try {
    const raw = localStorage.getItem('agentcanvas.settings.v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      const t = parsed?.state?.themePreference;
      if (t === 'system' || t === 'light' || t === 'dark') return t;
    }
  } catch { /* ignore parse errors */ }
  // Fall back to the legacy key (pre-settings-workflow).
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy === 'light' || legacy === 'dark') return legacy;
  // First visit — follow OS preference.
  return 'system';
}

function resolveDark(theme: ThemePreference): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  // 'system' — follow OS preference.
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(theme: ThemePreference) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', resolveDark(theme));
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference>('system');
  const [mounted, setMounted] = useState(false);
  const setSetting = useSettings((s) => s.set);

  // Hydrate from localStorage on mount (avoids SSR flash).
  useEffect(() => {
    const initial = getInitialTheme();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initial);
    applyTheme(initial);
    setMounted(true);
  }, []);

  // Subscribe to OS prefers-color-scheme changes when in 'system' mode.
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Cycle: system → light → dark → system.
  const toggle = () => {
    const next: ThemePreference =
      theme === 'system' ? 'light' :
      theme === 'light'  ? 'dark'  : 'system';
    setTheme(next);
    applyTheme(next);
    // Persist to both the settings store and the legacy key (for pre-settings
    // hydration on next reload).
    setSetting('themePreference', next);
    // For 'system', store the currently-resolved value in the legacy key so
    // getInitialTheme() picks the right starting point if the settings store
    // isn't yet hydrated.
    localStorage.setItem(LEGACY_STORAGE_KEY, resolveDark(next) ? 'dark' : 'light');
  };

  const Icon = !mounted ? Monitor : theme === 'light' ? Moon : theme === 'dark' ? Sun : Monitor;
  const label = !mounted ? 'Toggle theme' :
    theme === 'system' ? 'Theme: system (click for light)' :
    theme === 'light'  ? 'Theme: light (click for dark)'   :
                         'Theme: dark (click for system)';

  return (
    <button
      onClick={toggle}
      title={label}
      aria-label="Toggle color theme"
      className="flex items-center justify-center h-7 w-7 rounded-md ac-surface-1 ac-text-3 hover:ac-text-1 hover:ac-surface-2 border ac-border-subtle hover:ac-border-default ac-transition ac-focus-ring"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
