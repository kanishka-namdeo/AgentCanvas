// variables.ts — document variables → CSS custom properties (spec §3.6,
// Phase 2 "variable publishing", scoped to the paint level).
//
// The DOM renderer publishes every document variable as a CSS custom property
// on the WORLD container (both layout modes — this is paint-level, not
// layout-level):
//
//     --acv-<sanitized-key>: <resolved value under the document-default theme>;
//
// Nodes carrying a `tokenBinding` then emit `var(--acv-<key>, <resolved>)` in
// styleFor.ts — the resolver-resolved color stays as the fallback, so SVG
// mode / server-side renders (which never see the custom properties) are
// unaffected. Consequences per the spec: a `set_variable` patch repaints
// bound nodes via the cascade (the custom property participates natively in
// width/gap/padding too — the exact operation the resolver cannot do because
// variable resolution there runs after layout).
//
// Themed values resolve at PUBLISH time under the document-default theme
// (empty theme — the first value wins). Per-node themed overrides
// (`set_node_theme`) still resolve inside the resolver as today; publishing
// them as scoped inline `--acv-*` overrides is future work (spec §3.6
// paragraph 3).
//
// Pure functions: no React state, no DOM reads, safe in jsdom tests.

import type { CanvasDocument } from '@/lib/canvas/types';
import type { PenTheme, PenVariableDef } from '@/lib/pen/types';
import { resolveThemedValue } from '@/lib/pen/resolve';

/// Sanitize a variable key into a CSS-custom-property identifier segment:
/// every character outside [a-zA-Z0-9-] becomes '-' (e.g. "color.primary"
/// → "color-primary"). Custom property names are case-sensitive and allow
/// this character set after the leading `--`.
export function sanitizeVarKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9-]/g, '-');
}

/// The full custom-property name for a variable key: `--acv-<sanitized>`.
export function cssVarName(key: string): `--acv-${string}` {
  return `--acv-${sanitizeVarKey(key)}`;
}

/**
 * Compute the CSS custom properties for a document's variables, resolved
 * under the document-default theme (the base value — the same semantics the
 * resolver's `resolveThemedValue(def, {})` gives for an empty theme).
 *
 * Returns a style object suitable for React's `style` prop — custom
 * properties pass through to `style.setProperty` verbatim.
 */
export function cssVariablesFor(doc: CanvasDocument): React.CSSProperties {
  const out: Record<string, string> = {};
  const variables = doc?.variables;
  if (!variables) return out;
  for (const [key, def] of Object.entries(variables)) {
    const value = resolveVariableUnderDefaultTheme(def);
    if (value === undefined || value === null) continue;
    out[cssVarName(key)] = String(value);
  }
  return out;
}

function resolveVariableUnderDefaultTheme(def: PenVariableDef): string | number | boolean | undefined {
  if (!def || typeof def !== 'object') return undefined;
  return resolveThemedValue(def, {} as PenTheme);
}

/**
 * The `data-ac-theme` attribute value for the world container: the active
 * document-level theme serialized (JSON of axis→value), or 'default' when
 * none is active. The .pen model carries theme state per-NODE (resolved
 * during resolvePenTree) — there is no document-level active theme today,
 * so this publishes 'default' until one exists; the attribute is the stable
 * hook for CSS-side theme targeting (`[data-ac-theme="…"]`) per spec §3.6.
 */
export function worldThemeAttr(doc: CanvasDocument): string {
  // No document-level active theme in the .pen model (themes are per-node;
  // `doc.themes` only DEFINES axes + their available values). Publish the
  // documented 'default' sentinel.
  void doc;
  return 'default';
}
