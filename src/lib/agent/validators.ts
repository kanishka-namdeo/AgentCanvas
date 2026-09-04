// Pre-complete validation gate (Task 7-c P1.4 / T10).
//
// Runs BEFORE the agent's final message is committed. If the canvas fails
// validation, the runner re-prompts the agent with the failure reasons +
// "Fix these before declaring done." This catches the exact "wireframe-only"
// failure mode the Task 7-a VLM baseline exposed: agent scaffolded 39 bare
// shapes via pen_generate_wireframe, applied palette + shadows, but never
// set typography fields — the validation gate rejects that output and forces
// the agent to actually apply the system prompt's rules.

import type { Layer } from '../canvas/types';

// ---- Public API ------------------------------------------------------------

export interface ValidationResult {
  /** True if the canvas passes the gate (agent can declare done). */
  ok: boolean;
  /** Specific failure reasons (one per rule that failed). Empty when ok. */
  reasons: string[];
  /** Counts for telemetry / debug. */
  stats: {
    totalShapes: number;
    textShapes: number;
    cardShapes: number;
    textShapesWithWeight: number;
    cardShapesWithShadow: number;
    autoLayoutContainers: number;
  };
}

/**
 * Validate the canvas before allowing the agent to declare done.
 *
 * Rules (each produces a specific failure reason):
 *   1. Shape count: < 5 shapes → fail ("too sparse — looks like a wireframe").
 *   2. Typography: < 50% of text shapes have non-default fontWeight (≠ 400)
 *      → fail ("no typographic hierarchy — apply H1=700 / H2=600 / body=400
 *      per the LETTER SPACING RULES").
 *   3. Elevation: < 30% of card-shaped rectangles have shadow → fail
 *      ("most cards lack shadow — add shadow to all card containers per
 *      COMPONENT RECIPES").
 *   4. Layout: zero shapes with autoLayout set → fail
 *      ("no autoLayout — add autoLayout=true to layout containers (cards,
 *      sidebars, topbars)").
 *
 * The thresholds are deliberately lenient (50% / 30% / 1) so the gate
 * catches the wireframe-only failure mode without forcing perfection.
 * The mandatory critique loop (T2) handles higher-bar polish.
 *
 * `opts.relaxMinCount` skips rule 1 — used when the runner scopes validation
 * to a turn's NEW shapes only (multi-screen shared canvas): an edit turn that
 * legitimately adds only a few shapes must not be told to pad the canvas.
 */
export function validateCanvasBeforeComplete(
  shapes: Layer[],
  opts?: { relaxMinCount?: boolean },
): ValidationResult {
  const reasons: string[] = [];
  const totalShapes = shapes.length;

  // Count by category.
  const textShapes = shapes.filter((s) => s.type === 'text');
  const cardShapes = shapes.filter(
    (s) => s.type === 'rectangle' && isCardByName(s.name ?? ''),
  );
  const textShapesWithWeight = textShapes.filter(
    (s) => s.fontWeight !== undefined && s.fontWeight !== 400,
  );
  const cardShapesWithShadow = cardShapes.filter((s) => !!s.shadow);
  const autoLayoutContainers = shapes.filter((s) => !!s.autoLayout);

  // Rule 1: too few shapes.
  if (!opts?.relaxMinCount && totalShapes < 5) {
    reasons.push(
      `Too few shapes (<5). A real dashboard needs at least 5 components — ` +
      `you only have ${totalShapes}. Add more (KPI cards, chart, table, sidebar, topbar, buttons).`,
    );
  }

  // Rule 2: no typographic hierarchy.
  if (textShapes.length > 0) {
    const pct = textShapesWithWeight.length / textShapes.length;
    if (pct < 0.5) {
      reasons.push(
        `Most text shapes use default weight 400 (${textShapesWithWeight.length}/${textShapes.length} = ${Math.round(pct * 100)}% have non-default weight). ` +
        `Add typographic hierarchy per the LETTER SPACING RULES: page title=700 / section heading=600 / metric value=700 / metric label=500 / body=400. ` +
        `Also set letterSpacing (tighten headings -0.4 to -0.8, open labels +0.2 to +0.6) and textAlign. ` +
        `Either call pen_update_node on each text layer (changes: { fontWeight, letterSpacing, textAlign }) OR regenerate via pen_generate_wireframe (the wireframe generator now emits rich typography per role).`,
      );
    }
  }

  // Rule 3: missing card shadows.
  if (cardShapes.length > 0) {
    const pct = cardShapesWithShadow.length / cardShapes.length;
    if (pct < 0.3) {
      reasons.push(
        `Most card-shaped rectangles lack shadow (${cardShapesWithShadow.length}/${cardShapes.length} = ${Math.round(pct * 100)}% have shadow). ` +
        `Add shadow to all card containers per COMPONENT RECIPES — use pen_set_shadow with {x:0, y:4, blur:6, color:"#0000001a"} for resting cards, ` +
        `{x:0, y:8, blur:12, color:"#00000033"} for FABs/modals. ` +
        `A flat card with no shadow looks like a wireframe div, not a finished component.`,
      );
    }
  }

  // Rule 4: zero autoLayout containers.
  // Stress test 2026-08-30 exemption: chart/diagram frames are absolutely-
  // positioned geometry (bars, points, axes) — forcing autoLayout onto them
  // restacks the geometry into a vertical column and destroys the chart
  // (observed live: a working pen_create_chart bar chart was "fixed" into a
  // vertical stack by the critique fix-turn). Rule 4 exists for content
  // stacks (cards/sidebars/topbars), not hand-positioned geometry.
  const chartLike = shapes.some((s) => /chart|diagram|graph|plot\b/i.test(String((s as any).name ?? '')));
  if (autoLayoutContainers.length === 0 && totalShapes >= 5 && !chartLike) {
    reasons.push(
      `No autoLayout detected on any shape. Add autoLayout to layout containers ` +
      `(cards, sidebars, topbars, tab bars) so children align automatically. ` +
      `The wireframe generator's post-processor adds autoLayout to these container types — ` +
      `if you scaffolded manually via pen_create_node, you missed it. ` +
      `Call pen_update_node with changes: { autoLayout: { direction:"vertical", gap:8, padding:16, alignX:"min", alignY:"min" } } on each card / sidebar / topbar.`,
    );
  }

  // Rule 5: children spilling below their parent screen frame (multi-screen
  // stress-test finding). Frames don't clip, so overflowing layers render as
  // "broken boxes" below the screen. Direct children of frames only; 40px
  // tolerance for decorative bleeds.
  const framesById = new Map(
    shapes.filter((s) => s.type === 'frame').map((s) => [s.id, s] as const),
  );
  const overflowing: Array<{ name: string; over: number; frame: string }> = [];
  for (const s of shapes) {
    const parentId = (s as any).parentId as string | null | undefined;
    if (!parentId) continue;
    const frame = framesById.get(parentId);
    if (!frame) continue;
    const h = (s as any).height ?? 0;
    const over = s.y + h - (frame.y + frame.height);
    if (over > 40) {
      overflowing.push({ name: s.name ?? s.id, over: Math.round(over), frame: frame.name ?? frame.id });
    }
  }
  if (overflowing.length > 0) {
    const examples = overflowing
      .slice(0, 4)
      .map((o) => `"${o.name}" is ${o.over}px below frame "${o.frame}"`)
      .join('; ');
    reasons.push(
      `${overflowing.length} layer(s) extend below their parent screen frame (${examples}). ` +
      `Content spilling out of a frame renders as broken boxes below the screen. ` +
      `Compress the vertical layout (pen_update_node with changes: { y, height } to move/resize layers so everything fits inside the frame) ` +
      `or, if the screen genuinely needs more room, deliberately resize the frame with pen_update_node FIRST.`,
    );
  }

  // Rule 6: near-invisible text contrast (deterministic WCAG check — free,
  // catches the grey-on-grey defect class before any LLM critic runs).
  // Threshold 2.0:1 is intentionally lenient — the app's own text-subtle
  // token (#94a3b8 on #ffffff = 2.5:1) is a deliberate caption style; this
  // rule targets text the eye genuinely cannot read (ratio < 2), including
  // text whose color equals its container fill exactly.
  const byIdForContrast = new Map(shapes.map((s) => [s.id, s] as const));
  const lowContrast: Array<{ name: string; ratio: number; fg: string; bg: string }> = [];
  for (const s of shapes) {
    if (s.type !== 'text') continue;
    const tc = (s as { textColor?: string }).textColor;
    if (!isCheckableHex(tc)) continue; // token refs / unset → skip
    const bg = effectiveBackground(s, byIdForContrast);
    const ratio = contrastRatioOf(tc.slice(0, 7), bg);
    if (ratio !== null && ratio < 2) {
      lowContrast.push({
        name: s.name ?? s.id,
        ratio: Math.round(ratio * 10) / 10,
        fg: tc.slice(0, 7),
        bg,
      });
    }
  }
  if (lowContrast.length > 0) {
    const examples = lowContrast
      .slice(0, 4)
      .map((o) => `"${o.name}" ${o.fg} on ${o.bg} = ${o.ratio}:1`)
      .join('; ');
    reasons.push(
      `${lowContrast.length} text layer(s) are nearly invisible — contrast < 2:1 against their background (${examples}). ` +
      `This is the grey-on-grey defect class: the text renders but the eye cannot read it. ` +
      `Fix with pen_update_node changes: { textColor: "#0f172a" } (or another color with WCAG contrast — target 4.5:1 for body, ` +
      `3:1 for large text) on each flagged layer.`,
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    stats: {
      totalShapes,
      textShapes: textShapes.length,
      cardShapes: cardShapes.length,
      textShapesWithWeight: textShapesWithWeight.length,
      cardShapesWithShadow: cardShapesWithShadow.length,
      autoLayoutContainers: autoLayoutContainers.length,
    },
  };
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Identify a "card-shaped rectangle" by name pattern.
 *
 * Mirrors the wireframe generator's `applyHighFidelityStyling` card regex.
 * Returns true for shapes named like "Card", "Stat card", "Chart", "Panel",
 * "Tile", "Item", "Product" — the container-like rectangles the COMPONENT
 * RECIPES expect to have shadow.
 */
function isCardByName(name: string): boolean {
  return /\bcard\b|\bstat\b|\bchart\b|\bpanel\b|\btile\b|\bitem\b|\bproduct\b/i.test(name);
}

// ---- WCAG contrast utilities (local copies of tools.ts's private helpers) ----
// Same formulas (relative luminance per WCAG 2.x); duplicated here so the
// deterministic validation gate stays dependency-free and import-cycle-safe.

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}/.test(m)) return null;
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
  };
}

function luminanceOf(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

function contrastRatioOf(fg: string, bg: string): number | null {
  const l1 = luminanceOf(fg);
  const l2 = luminanceOf(bg);
  if (l1 === null || l2 === null) return null;
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/// Hex or token reference? Only hex (6-digit, optional alpha) can be checked
/// deterministically — token refs are resolved at bind time and skipped.
function isCheckableHex(c: unknown): c is string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c.trim());
}

/// Walk the parent chain to the first opaque fill (frames/rectangles).
/// Falls back to white — a light-bg assumption that matches the app's default
/// document background. Max depth 4 guards against cycles in malformed trees.
function effectiveBackground(
  start: Layer,
  byId: Map<string, Layer>,
): string {
  let cur: Layer | undefined = start;
  let depth = 0;
  while (cur && depth < 4) {
    const parentId = (cur as { parentId?: string | null }).parentId ?? null;
    if (!parentId) break;
    const parent = byId.get(parentId);
    if (!parent) break;
    const f = parent.fill;
    if (isCheckableHex(f) && !/^#([0-9a-fA-F]{2})?$/i.test(f)) {
      // Ignore (near-)transparent fills: an 8-digit hex with alpha <= 0x33
      // contributes ~nothing to the rendered backdrop.
      const alpha = f.length === 9 ? parseInt(f.slice(7, 9), 16) / 255 : 1;
      if (alpha > 0.2) return f.slice(0, 7);
    }
    cur = parent;
    depth++;
  }
  return '#ffffff';
}
