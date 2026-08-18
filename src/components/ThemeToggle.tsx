'use client';

// Theme toggle — flips between light, dark, and system by adding/removing the
// `.dark` class on <html>. Cycles through the three modes on click.
//
// Source of truth: the settings store (`useSettings.themePreference`). The
// toggle subscribes to that field so it stays in sync when the theme is
// changed via Settings → Appearance.
//
// Icon convention: shows the icon for the CURRENT state (Sun in light, Moon
// in dark, Monitor in system) — matches GitHub, Linear, Vercel.
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
  // Subscribe to the settings store so the icon + click cycle stay in sync
  // when the theme is changed via Settings → Appearance or "Reset to defaults".
  const themePreference = useSettings((s) => s.themePreference);
  const setSetting = useSettings((s) => s.set);
  const [mounted, setMounted] = useState(false);

  // Hydrate from localStorage on mount (avoids SSR flash). If the settings
  // store already has a value, use it; otherwise read from legacy key.
  useEffect(() => {
    const initial = getInitialTheme();
    // If the settings store hasn't been hydrated yet (e.g. first load),
    // seed it with the value we just read.
    if (useSettings.getState().themePreference !== initial) {
      setSetting('themePreference', initial);
    }
    applyTheme(initial);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, [setSetting]);

  // Subscribe to OS prefers-color-scheme changes when in 'system' mode.
  useEffect(() => {
    if (themePreference !== 'system') {
      applyTheme(themePreference);
      return;
    }
    applyTheme('system');
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themePreference]);

  // Cycle: system → light → dark → system.
  const toggle = () => {
    const next: ThemePreference =
      themePreference === 'system' ? 'light' :
      themePreference === 'light'  ? 'dark'  : 'system';
    setSetting('themePreference', next);
    // Also write to legacy key for backward compat with any code that still
    // reads it directly.
    localStorage.setItem(LEGACY_STORAGE_KEY, resolveDark(next) ? 'dark' : 'light');
  };

  // Icon shows the CURRENT state (not the next state).
  const Icon = !mounted ? Monitor :
    themePreference === 'light'  ? Sun   :
    themePreference === 'dark'   ? Moon  :
                                   Monitor;
  const label = !mounted ? 'Toggle theme' :
    themePreference === 'system' ? 'Theme: system (click for light)' :
    themePreference === 'light'  ? 'Theme: light (click for dark)'   :
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
