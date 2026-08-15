'use client';

// Theme toggle — flips between light and dark by adding/removing the `.dark`
// class on <html>. Persists to localStorage so reloads preserve the choice.
//
// The dark-mode token variant is defined in `src/app/globals.css` under the
// `.dark` selector — it redefines every `--ac-*` token, so all components
// that consume the tokens via `.ac-text-*` / `.ac-border-*` / `.ac-surface-*`
// utility classes pick up the dark values automatically.

import { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';

const STORAGE_KEY = 'agentcanvas-theme';

type Theme = 'light' | 'dark';

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  // Respect OS preference on first visit.
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  const [mounted, setMounted] = useState(false);

  // Hydrate from localStorage on mount (avoids SSR flash).
  useEffect(() => {
    const initial = getInitialTheme();
    setTheme(initial);
    applyTheme(initial);
    setMounted(true);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    applyTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
  };

  // Avoid hydration mismatch: render a stable placeholder until mounted.
  const icon = !mounted
    ? <Sun className="h-3.5 w-3.5" />
    : theme === 'light'
      ? <Moon className="h-3.5 w-3.5" />
      : <Sun className="h-3.5 w-3.5" />;

  return (
    <button
      onClick={toggle}
      title={mounted ? `Switch to ${theme === 'light' ? 'dark' : 'light'} mode` : 'Toggle theme'}
      aria-label="Toggle color theme"
      className="flex items-center justify-center h-7 w-7 rounded-md ac-surface-1 ac-text-3 hover:ac-text-1 hover:ac-surface-2 border ac-border-subtle hover:ac-border-default ac-transition ac-focus-ring"
    >
      {icon}
    </button>
  );
}
