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
 */
export function validateCanvasBeforeComplete(shapes: Layer[]): ValidationResult {
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
  if (totalShapes < 5) {
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
        `Either call pen_update_shape on each text layer OR regenerate via pen_generate_wireframe (the wireframe generator now emits rich typography per role).`,
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
  if (autoLayoutContainers.length === 0 && totalShapes >= 5) {
    reasons.push(
      `No autoLayout detected on any shape. Add autoLayout=true to layout containers ` +
      `(cards, sidebars, topbars, tab bars) so children align automatically. ` +
      `The wireframe generator's post-processor adds autoLayout to these container types — ` +
      `if you scaffolded manually via pen_create_shape, you missed it. ` +
      `Call pen_update_shape with autoLayout={direction:"vertical", gap:8, padding:16, alignX:"min", alignY:"min"} on each card / sidebar / topbar.`,
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
