# Design-consistency standards digest (2026-09-06)

Sources: shadcn/ui Theming + Colors docs (current), W3C DTCG Design Tokens Format
2025.10 (first stable), WCAG 2.2 Understanding docs (1.4.3 / 1.4.11), Radix
Colors docs, Stephanie Walter (min font size for dense data apps), Design
Systems Collective (color token naming), 4px/8pt baseline grid references.

## What the standards say

1. **Semantic token layering (shadcn / DTCG)**: color = semantic
   background/foreground pairs; dark mode overrides the SAME tokens under
   `.dark`. Component code never hardcodes raw palette values. Our `--ac-*`
   role-based layer (surface/text/border/status) matches the recommended
   "functional role-based" naming family. Anti-pattern: component-specific
   ad-hoc hex values in component code.
2. **Radius (shadcn current)**: ONE `--radius` primitive; all steps derived by
   calc(). We already do this (sm/md/lg/xl).
3. **WCAG 1.4.11 Non-text Contrast (AA)**: borders, icons, focus indicators,
   and state indicators need >= 3:1 against ADJACENT colors. Focus indicator
   must contrast with the background the component sits on. Inactive
   components are exempt (our .ac-busy opacity .4 pattern is fine).
4. **WCAG 1.4.3**: text >= 4.5:1 (normal) / 3:1 (large). Our --ac-text ramp
   was previously AA-verified; keep tertiary/quaternary as-is.
5. **Min font size for dense data UI (S. Walter)**: 10–12px is small but
   workable for dense metadata; primary content should be >= 12px; 9px only
   for auxiliary micro-badges; never 8px. => kill the 8px outlier; keep the
   9px micro tier (dense canvas-tool convention, compact-density remap
   deliberately leaves it alone), converge 10px as the overline-label size.
6. **Spacing (8pt grid / 4px baseline)**: all spacing multiples of 4px (2px
   half-steps allowed in micro-dense UI). Tailwind's scale is 4px-based =>
   arbitrary p-[1px]/p-[3px] are the only violations to normalize (to 2px
   steps via p-0.5 where visually equivalent, or keep if truly 1px hairline
   indicators — inspect context).
7. **One recipe per semantic role** (internal consistency, the core of this
   audit): kbd chips, overline labels, section headings, icon-button tiers.
8. **Radix Colors dark-mode pattern**: soft backgrounds + readable fg pair;
   dark mode swaps the palette, not just lightness of the solid color. Our
   status soft/fg/main/border tokens already follow this.
9. **DTCG 2025.10**: token format now stable; the web convention (CSS custom
   properties + @theme mapping) we use is the standard bridge.

## Violations found (codebase)

- kbd: 6 different recipes (page.tsx, LayersPanel 9px no-mono, ShortcutsReference,
  CommandPalette x2, Canvas).
- Overline labels: 3 competing recipes (9px / 10px semibold / 10px-11px medium).
- SettingsDialog: 1 heading off-scale (14px + mb-1.5 vs seven 13px + mb-1).
- SessionSidebar: text-[8px] (below micro floor).
- Brand gradient duplicated as raw Tailwind palette (from-violet-500
  to-fuchsia-500 x2: page.tsx, AgentPanel).
- MeasureOverlay: hardcoded #ff6b6b + white pill fill => GLARING white pill in
  dark mode; hardcoded monospace font stack bypasses the app font tokens.
- Rulers: #f24822 hardcoded on stroke attrs (no dark adaptation); stale light
  fallbacks on var() calls.
- AgentPanel L2578: stale hsl() fallback for --ac-warning-soft.
- PackShowcase: fallback #e4e4e7 (zinc) mismatches slate-based token.
- Two arbitrary paddings p-[1px]/p-[3px] (inspect: likely 1px focus offsets).

## Fixes

1. globals.css: add `.ac-kbd`, `.ac-label`, `.ac-brand-gradient` utilities +
   `--ac-canvas-measure` + `--ac-canvas-guide` tokens (with dark variants).
2. Replace all kbd recipes with .ac-kbd (single chip: mono 10px, text-3,
   surface-2 fill, hairline subtle border, px-1.5 py-0.5, rounded).
3. Converge pure overline labels to .ac-label (10px semibold tracking-wide
   ac-text-4). Chips/badges with surface bg are a different role — untouched.
4. SettingsDialog heading 14px->13px, mb-1.5->mb-1; SessionSidebar 8px->9px.
5. MeasureOverlay: style-prop var() colors (pill = --ac-canvas-bg, red =
   --ac-canvas-measure), font stack = var(--font-geist-mono).
6. Brand gradient x2 -> .ac-brand-gradient (tokenized from/to).
7. Rulers: tokenize origin-marker red via --ac-canvas-guide; refresh stale
   fallbacks to current token values.
8. AgentPanel: refresh stale hsl fallback. PackShowcase: fix zinc fallback.
