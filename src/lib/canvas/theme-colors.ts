// Theme-aware color resolution for canvas surfaces (UI-audit round 2).
//
// Problem being solved: document/shape defaults are PERSISTED as concrete
// hexes ('#f8fafc' canvas background, '#e2e8f0' fills, '#0f172a' strokes) so
// existing documents render light-mode colors even when the app theme is
// dark. The token system in globals.css (--ac-canvas-bg etc.) already adapts,
// but the persisted data can't change retroactively.
//
// Resolution strategy — treat the legacy default hexes as "auto" sentinels:
//   - render-time: swap the sentinel for the live CSS token (var(--ac-…)),
//     so the canvas + its shapes follow the theme automatically;
//   - raster/export-time (needs a concrete color): probe the computed style
//     of the token via a hidden element and read back the resolved rgb().
//
// A user who explicitly sets a color (any value ≠ sentinel) keeps their exact
// hex — only the shipped defaults become theme-following.

/// Hex values that mean "the default" — the ones seeded by server.ts /
/// journal-fold.ts / api/agent/route.ts / sessions/store.ts.
const DEFAULT_CANVAS_BG = '#f8fafc';

export function isDefaultCanvasBackground(bg: string | undefined | null): boolean {
  return !bg || bg.trim().toLowerCase() === DEFAULT_CANVAS_BG;
}

/// Render-time background for the canvas world: the CSS token when the doc
/// carries the default, the explicit hex otherwise. Returned value is valid
/// for inline `style={{ background }}`.
export function resolveCanvasBackground(bg: string | undefined | null): string {
  return isDefaultCanvasBackground(bg) ? 'var(--ac-canvas-bg)' : (bg as string);
}

/// True when a stored color is a CSS token reference (e.g.
/// 'var(--ac-canvas-default-fill)' written by Toolbar SHAPE_DEFAULTS) rather
/// than a concrete hex. Token-valued fills adapt to the theme; the raw string
/// must never be shown in a color input.
export function isTokenColor(v: string | undefined | null): boolean {
  return !!v && v.trim().startsWith('var(');
}

const tokenCache = new Map<string, string>();

/// Resolve a CSS token (or any CSS color string) to a concrete hex, client
/// side only, by probing the computed style of a detached element. Cached —
/// tokens don't change without a theme flip, and the map is tiny.
/// Returns `fallback` when not in a browser or resolution fails.
export function tokenToHex(token: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const cached = tokenCache.get(token);
  if (cached) return cached;
  try {
    const probe = document.createElement('div');
    probe.style.display = 'none';
    probe.style.color = token;
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const m = computed.match(/rgba?\(([^)]+)\)/i);
    if (!m) return fallback;
    const parts = m[1].split(',').map((p) => parseFloat(p));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return fallback;
    const [r, g, b] = parts;
    const hex =
      '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
    tokenCache.set(token, hex);
    return hex;
  } catch {
    return fallback;
  }
}

/// Concrete background color for raster export (PNG) — resolves the default
/// sentinel to the CURRENT theme's canvas color so dark-mode exports are dark.
export function exportBackgroundColor(docBackground: string | undefined | null): string {
  if (!isDefaultCanvasBackground(docBackground)) return docBackground as string;
  return tokenToHex('var(--ac-canvas-bg)', DEFAULT_CANVAS_BG);
}

/// Display value for a stored color in an input: tokens resolve to their
/// concrete hex (so <input type="color"> works); sentinels/invalid values
/// fall back to a sane hex.
export function colorInputValue(v: string | undefined | null, tokenFallback: string): string {
  if (!v) return tokenFallback;
  if (isTokenColor(v)) return tokenToHex(v, tokenFallback);
  return /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : tokenFallback;
}
