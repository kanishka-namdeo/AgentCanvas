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
    /** 2026-09-18 iter5: brand-string fidelity check (Rule 9). */
    promptStringsExtracted?: number;
    promptStringsFound?: number;
    promptStringsMisspelled?: number;
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
 *   3. Elevation: < 50% of card-shaped rectangles have shadow → fail
 *      ("most cards lack shadow — add shadow to all card containers per
 *      COMPONENT RECIPES"). Industry standard: >= 50% of elevated surfaces
 *      must carry a visible shadow (blur >= 8, alpha >= 0x33).
 *   4. Layout: zero shapes with autoLayout set → fail
 *      ("no autoLayout — add autoLayout=true to layout containers (cards,
 *      sidebars, topbars)").
 *   5. Child overflow: layers extending >40px below their parent frame → fail.
 *   6. Contrast: text with <4.5:1 contrast ratio against background → fail (WCAG AA).
 *   7. Root frame clipping: root frame with FIXED height whose children
 *      extend beyond it → fail ("use fit_content").
 *   8. Repeated structures: ≥3 siblings in one parent group sharing one
 *      structural signature → fail ("build ONE component and place
 *      instances"). Only evaluated when the runner threads
 *      `opts.repeatedStructures` AND neither exemption applies — see
 *      `RepeatedStructuresOpts`.
 *   9. 2026-09-18 iter5: Prompt-string fidelity. Extracts concrete strings
 *      the user mentioned in the prompt — quoted strings, brand names
 *      following "called X" / "named X", button labels before "button",
 *      field labels before "field", "$N" / "N%" numeric values. Each
 *      extracted string MUST appear verbatim in at least one text layer.
 *      Close matches (Levenshtein ≤ 2) trigger a "misspelled" defect with
 *      the close-match name surfaced — catches the agnes-3.0-flash
 *      "Vaultly" → "Vaultily" tokenization quirk exposed by iter4 VLM
 *      critique. Only evaluated when the runner threads `opts.prompt`.
 *
 * The thresholds are deliberately set to industry standards (50% / 50% / 1) so the gate
 * catches the wireframe-only failure mode without forcing perfection.
 * The mandatory critique loop (T2) handles higher-bar polish.
 *
 * `opts.relaxMinCount` skips rule 1 — used when the runner scopes validation
 * to a turn's NEW shapes only (multi-screen shared canvas): an edit turn that
 * legitimately adds only a few shapes must not be told to pad the canvas.
 */
export interface RepeatedStructuresOpts {
  /** True when a one-shot generator tool (pen_generate_wireframe / pen_create_card_grid / pen_create_landing_page / pen_create_table) ran this turn. */
  usedTemplateGeneration: boolean;
  /** True when the turn's LLM-visible toolset included a component-creation tool (figma_create_component or pen_convert_to_component). */
  componentToolsVisible: boolean;
}

export function validateCanvasBeforeComplete(
  shapes: Layer[],
  opts?: {
    relaxMinCount?: boolean;
    repeatedStructures?: RepeatedStructuresOpts;
    /** 2026-09-18 iter5: the user's prompt — Rule 9 extracts + verifies strings. */
    prompt?: string;
  },
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
    if (pct < 0.5) {
      reasons.push(
        `Most card-shaped rectangles lack shadow (${cardShapesWithShadow.length}/${cardShapes.length} = ${Math.round(pct * 100)}% have shadow — industry standard requires >= 50%). ` +
        `Add shadow to all card containers per COMPONENT RECIPES — use pen_set_shadow with {x:0, y:4, blur:8, color:"#00000033"} for resting cards, ` +
        `{x:0, y:12, blur:16, color:"#0000004d"} for FABs/modals. ` +
        `Every card, panel, modal, and elevated surface MUST have a visible shadow. No exceptions. ` +
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

  // Rule 6: insufficient text contrast (deterministic WCAG AA check — free,
  // catches low-contrast defects before any LLM critic runs).
  // Threshold 4.5:1 matches WCAG 2.x Level AA for normal text. Large text
  // (>=18pt bold or >=24pt regular) requires 3:1; we use the stricter 4.5:1
  // floor because the validator has no font-size awareness and the agent's
  // system prompt targets 4.5:1 universally.
  const byIdForContrast = new Map(shapes.map((s) => [s.id, s] as const));
  const lowContrast: Array<{ name: string; ratio: number; fg: string; bg: string }> = [];
  for (const s of shapes) {
    if (s.type !== 'text') continue;
    const tc = (s as { textColor?: string }).textColor;
    if (!isCheckableHex(tc)) continue; // token refs / unset → skip
    const bg = effectiveBackground(s, byIdForContrast);
    const ratio = contrastRatioOf(tc.slice(0, 7), bg);
    if (ratio !== null && ratio < 4.5) {
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
      `${lowContrast.length} text layer(s) have insufficient contrast (< 4.5:1 WCAG AA) against their background (${examples}). ` +
      `WCAG AA requires >= 4.5:1 for normal text and >= 3:1 for large text (bold >= 18pt or regular >= 24pt). ` +
      `Fix with pen_update_node changes: { textColor: "#0f172a" } (or another color meeting WCAG AA contrast) on each flagged layer.`,
    );
  }

  // Rule 7: root frame with FIXED height clipping children. A root/page frame
  // with a numeric (FIXED) height whose children extend beyond it creates a
  // visible artifact — the frame's background paints only up to its fixed
  // height while children flow further, producing a dark bar or clipped content.
  // The fix is always to use height:"fit_content" on the root frame.
  const allIds = new Set(shapes.map((s) => s.id));
  const rootFrames = shapes.filter(
    (s) =>
      s.type === 'frame' &&
      typeof s.height === 'number' && // FIXED height (not fit_content / fill_container)
      (!(s as any).parentId || !allIds.has((s as any).parentId)), // root-level
  );
  for (const root of rootFrames) {
    const rootBottom = root.y + (root.height as number);
    const overflowingChildren = shapes.filter((child) => {
      if ((child as any).parentId !== root.id) return false;
      const childH = (child as any).height ?? 0;
      return child.y + childH > rootBottom + 40; // 40px tolerance
    });
    if (overflowingChildren.length > 0) {
      const maxOverflow = Math.max(
        ...overflowingChildren.map((c) => {
          const cH = (c as any).height ?? 0;
          return c.y + cH - rootBottom;
        }),
      );
      reasons.push(
        `Root frame "${root.name ?? root.id}" has fixed height ${root.height}px but ${overflowingChildren.length} child(ren) ` +
        `extend up to ${Math.round(maxOverflow)}px beyond it — use height:"fit_content" instead of a fixed numeric height. ` +
        `Fixed-height root frames clip their children and create visible artifacts (dark bars, truncated content).`,
      );
    }
  }

  // Rule 8: repeated structures without components (designer-workflow-parity
  // spec §5.2 — component-first construction). ≥3 siblings under one parent
  // sharing one structural signature (node-type tree shape; child order
  // stabilized by x then y; text content, fills, names, and geometry values
  // ignored) means the agent hand-duplicated a subtree instead of building
  // ONE component + instances. DEFAULT-OFF: fires only when the runner
  // threads `repeatedStructures` AND neither exemption applies — template
  // output (a generator tool ran this turn) is exempt, and the rule stays
  // silent when no component-creation tool was in the turn's visible toolset
  // (the agent could not comply with the fix it would be told to make).
  const rs = opts?.repeatedStructures;
  if (rs && !rs.usedTemplateGeneration && rs.componentToolsVisible) {
    // Group siblings by parent ('root' for parentless shapes).
    const groups = new Map<string, Layer[]>();
    for (const s of shapes) {
      const key = (s as { parentId?: string | null }).parentId ?? 'root';
      const group = groups.get(key);
      if (group) group.push(s);
      else groups.set(key, [s]);
    }
    for (const members of groups.values()) {
      if (members.length < 3) continue;
      // Bucket by structural signature within the group.
      const buckets = new Map<string, Layer[]>();
      for (const member of members) {
        const sig = structuralSignature(member, shapes);
        const bucket = buckets.get(sig);
        if (bucket) bucket.push(member);
        else buckets.set(sig, [member]);
      }
      for (const [sig, bucket] of buckets) {
        if (bucket.length < 3) continue;
        // Exempt when ANY sibling (or one of its descendants) is a component
        // instance. NOTE: deliberately MORE LENIENT than the spec's
        // sibling-only wording ("none of those siblings is a component
        // instance") — descendants count too, so a partially-converted group
        // never trips the rule. Rationale: the stricter sibling-only reading
        // would false-fire on groups already following the component-first
        // model and demand re-conversion of instance-bearing subtrees,
        // causing fix loops. Lenient direction = no false positives.
        if (bucket.some((m) => subtreeHasComponentInstance(m, shapes))) continue;
        const sigPreview = sig.length > 96 ? `${sig.slice(0, 93)}...` : sig;
        reasons.push(
          `${bucket.length} repeated structures with identical layout (${sigPreview}) — build ONE component ` +
          `(figma_create_component or pen_convert_to_component) and place instances (pen_place_component_instance) ` +
          `instead of duplicating bespoke subtrees. Restyle the main component; instances inherit.`,
        );
      }
    }
  }

  // ---- Rule 9: prompt-string fidelity (iter5 — 2026-09-18) -----------------
  //
  // Extract concrete strings the user mentioned in the prompt and verify
  // each appears verbatim in a text layer. Close matches (Levenshtein ≤ 2)
  // produce a "misspelled" defect with the close-match name surfaced —
  // catches tokenization quirks like agnes-3.0-flash's "Vaultly" → "Vaultily".
  //
  // Extraction patterns (conservative — high-precision, low-recall):
  //   1. Quoted strings: "X" or 'X' → X
  //   2. Brand names: "called X" / "named X" / "app X" → X (first token)
  //   3. Button labels: "X button" → X (e.g. "Sign In button" → "Sign In")
  //   4. Field labels: "X field" → X (e.g. "email field" → "Email" — capitalized)
  //   5. Link labels: "X link" → X
  //   6. Tab labels: "X tab" → X
  //   7. Numeric values: "$N.NNK" / "N,NNN" / "N.N%" → the literal string
  //
  // For each extracted string, scan all text-layer `.text` / `.content` /
  // `.name` fields. If no exact match, scan for Levenshtein-close matches
  // (≤2 edits, case-insensitive). If found, the defect names the close
  // match so the agent can rename it.

  // ---- Rule 10: canvas-coverage (iter6-e — 2026-09-18) --------------------
  //
  // VLM critique of mwc-mindmap (VLM=1/5) identified: "content is crammed
  // into the top-left corner". The agent built 4 branches but spread them
  // across ~200px of width when the canvas has 1440+ available.
  //
  // This rule measures the bounding-box of all visible shapes against the
  // canvas's available area (computed from the largest layer's extent).
  // If coverage < 25%, the design is "crammed" — fire a defect.
  const allVisible = shapes.filter((s) => s.visible !== false);
  if (allVisible.length >= 6) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of allVisible) {
      const x = Number(s.x ?? 0), y = Number(s.y ?? 0);
      const w = Number(s.width ?? 0), h = Number(s.height ?? 0);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }
    if (Number.isFinite(minX) && Number.isFinite(maxX)) {
      const usedW = maxX - minX;
      const usedH = maxY - minY;
      // Heuristic: designs should span at least 480px wide (mobile + a bit)
      // and at least 320px tall. A 6+ layer design crammed into <480×320
      // is "canvas cramming".
      const tooNarrow = usedW < 480;
      const tooShort = usedH < 320;
      if (tooNarrow || tooShort) {
        reasons.push(
          `Canvas coverage too small (${Math.round(usedW)}×${Math.round(usedH)}px for ${allVisible.length} shapes — ` +
          `expected ≥480×320). The design is crammed into a corner of the available canvas. ` +
          `Redistribute the shapes across the full canvas width: use pen_update_node to spread them horizontally, ` +
          `or wrap them in a parent frame with autoLayout (direction:"horizontal", gap:24, padding:32) so the layout engine distributes them. ` +
          `Mindmaps should fan out radially; grids should use the full width; multi-step flows should sit side-by-side.`,
        );
      }
    }
  }

  // ---- Rule 11: sibling overlap (iter6-e — 2026-09-18) --------------------
  //
  // VLM critique of mwc-multistep-wizard (VLM=1/5) identified: "navigation
  // buttons overlap the progress bar". The agent placed siblings at
  // overlapping coordinates — a layout collision.
  //
  // This rule checks pairs of VISIBLE siblings (same parentId or both root)
  // for significant overlap (>50% of the smaller's area). Exempts:
  //   - Text-inside-frame (text is supposed to overlap its parent frame)
  //   - Same-name duplicates (likely an artifact, not a real overlap)
  //   - Decorative layers (icons, shadows — these legitimately overlap)
  if (allVisible.length >= 4) {
    const visibleRoot = allVisible.filter((s) => !(s as { parentId?: string | null }).parentId);
    const visibleFramed = allVisible.filter((s) => (s as { parentId?: string | null }).parentId);
    // Check root-level siblings
    const checkPairs = (group: Layer[]) => {
      const overlaps: Array<{ a: string; b: string; pct: number }> = [];
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          // Skip if either is text (text usually lives inside a frame)
          if (a.type === 'text' || b.type === 'text') continue;
          const ax = Number(a.x ?? 0), ay = Number(a.y ?? 0);
          const aw = Number(a.width ?? 0), ah = Number(a.height ?? 0);
          const bx = Number(b.x ?? 0), by = Number(b.y ?? 0);
          const bw = Number(b.width ?? 0), bh = Number(b.height ?? 0);
          if (!aw || !ah || !bw || !bh) continue;
          const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
          const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
          const intersection = ix * iy;
          if (intersection <= 0) continue;
          const smallerArea = Math.min(aw * ah, bw * bh);
          const pct = smallerArea > 0 ? intersection / smallerArea : 0;
          // >50% overlap of the smaller sibling = collision
          if (pct > 0.5) {
            overlaps.push({ a: a.name ?? a.id, b: b.name ?? b.id, pct: Math.round(pct * 100) });
          }
        }
      }
      return overlaps.slice(0, 3); // cap at 3 to avoid defect-list bloat
    };
    const rootOverlaps = checkPairs(visibleRoot);
    if (rootOverlaps.length > 0) {
      const examples = rootOverlaps.map((o) => `"${o.a}" overlaps "${o.b}" by ${o.pct}%`).join('; ');
      reasons.push(
        `${rootOverlaps.length} sibling layout collision(s) (${examples}). ` +
        `Elements at the same nesting level should not overlap by more than 50% of the smaller's area — ` +
        `reposition with pen_update_node (move one of them) or wrap them in a parent frame with autoLayout ` +
        `(direction:"vertical" or "horizontal", gap:16) so the layout engine spaces them.`,
      );
    }
  }

  // ---- Rule 12: position-fidelity (iter6-e — 2026-09-18) ------------------
  //
  // VLM critique of mwc-multistep-wizard (VLM=1/5) identified: "progress
  // bar should be at TOP, agent put it at the BOTTOM". The prompt said
  // "progress bar at the top" but the agent placed it at the bottom.
  //
  // This rule extracts positional phrases from the prompt ("at the top",
  // "at the bottom", "on the left", "on the right") and verifies the
  // referenced element appears in the correct region of the canvas.
  //
  // Implementation: scan text layers for the prompt-mentioned element
  // name; find the corresponding frame/shape; check its y (or x) position.
  const promptText12 = opts?.prompt;
  if (typeof promptText12 === 'string' && promptText12.length > 0 && allVisible.length >= 4) {
    const positionRules: Array<{ phrase: RegExp; element: string; axis: 'y' | 'x'; want: 'top' | 'bottom' | 'left' | 'right' }> = [
      { phrase: /\bprogress\s+bar\s+at\s+the\s+top\b/i, element: 'progress', axis: 'y', want: 'top' },
      { phrase: /\bprogress\s+bar\s+at\s+the\s+bottom\b/i, element: 'progress', axis: 'y', want: 'bottom' },
      { phrase: /\bsidebar\s+on\s+the\s+left\b/i, element: 'sidebar', axis: 'x', want: 'left' },
      { phrase: /\bsidebar\s+on\s+the\s+right\b/i, element: 'sidebar', axis: 'x', want: 'right' },
      { phrase: /\bnavbar\s+at\s+the\s+top\b/i, element: 'nav', axis: 'y', want: 'top' },
      { phrase: /\bheader\s+at\s+the\s+top\b/i, element: 'header', axis: 'y', want: 'top' },
      { phrase: /\bfooter\s+at\s+the\s+bottom\b/i, element: 'footer', axis: 'y', want: 'bottom' },
    ];
    for (const rule of positionRules) {
      if (!rule.phrase.test(promptText12)) continue;
      // Find the element on canvas — by name match (case-insensitive)
      // OR by structural heuristic (sidebar = narrow tall, progress bar = horizontal row of small circles).
      const namedElement = allVisible.find((l) => {
        const name = (l.name ?? '').toLowerCase();
        return name.includes(rule.element);
      });
      // Compute canvas bounds for position check.
      let cMin = Infinity, cMax = -Infinity;
      for (const s of allVisible) {
        const v = Number(s[rule.axis === 'y' ? 'y' : 'x'] ?? 0);
        const size = Number(s[rule.axis === 'y' ? 'height' : 'width'] ?? 0);
        if (v < cMin) cMin = v;
        if (v + size > cMax) cMax = v + size;
      }
      if (!Number.isFinite(cMin) || !Number.isFinite(cMax)) continue;
      const cMid = (cMin + cMax) / 2;
      if (namedElement) {
        const ePos = Number(namedElement[rule.axis === 'y' ? 'y' : 'x'] ?? 0);
        const eSize = Number(namedElement[rule.axis === 'y' ? 'height' : 'width'] ?? 0);
        const eMid = ePos + eSize / 2;
        const wrong =
          (rule.want === 'top' && eMid > cMid + (cMax - cMin) * 0.2) ||
          (rule.want === 'bottom' && eMid < cMid - (cMax - cMin) * 0.2) ||
          (rule.want === 'left' && eMid > cMid + (cMax - cMin) * 0.2) ||
          (rule.want === 'right' && eMid < cMid - (cMax - cMin) * 0.2);
        if (wrong) {
          reasons.push(
            `Position-fidelity defect: the prompt says "${rule.element} ${rule.want}" but the "${namedElement.name ?? namedElement.id}" ` +
            `element is positioned at ${rule.axis}=${Math.round(ePos)} (canvas ${rule.axis}-range ${Math.round(cMin)}–${Math.round(cMax)}, mid=${Math.round(cMid)}) — ` +
            `it should be in the ${rule.want.toUpperCase()} half. Call pen_update_node with changes: { ${rule.axis}: <new-position-in-the-${rule.want}-half> } ` +
            `to move it. The system prompt's CONTENT FIDELITY rule covers positional phrases too — the agent must honor them.`,
          );
        }
      }
    }
  }


  let promptStringsExtracted = 0;
  let promptStringsFound = 0;
  let promptStringsMisspelled = 0;
  const promptText = opts?.prompt;
  if (typeof promptText === 'string' && promptText.length > 0 && textShapes.length > 0) {
    const extracted = extractPromptStrings(promptText);
    promptStringsExtracted = extracted.length;
    if (extracted.length > 0 && extracted.length <= 24) {
      // Cap at 24 to avoid pathological prompts blowing up the defect list.
      const textLayerContents = textShapes.map((s) => ({
        id: s.id,
        text: String((s as { text?: string }).text ?? (s as { content?: string }).content ?? s.name ?? ''),
      }));
      const missing: Array<{ expected: string; closeMatch: string | null }> = [];
      for (const expected of extracted) {
        const exact = textLayerContents.some((t) => t.text.includes(expected));
        if (exact) {
          promptStringsFound++;
          continue;
        }
        // Look for a close match (Levenshtein ≤ 2, case-insensitive, on a
        // text-layer TOKEN or short content slice — not the whole layer).
        let closeMatch: string | null = null;
        const needle = expected.toLowerCase();
        for (const t of textLayerContents) {
          const haystack = t.text.toLowerCase();
          // Check token-level closeness (split on whitespace).
          const tokens = haystack.split(/\s+/);
          for (const tok of tokens) {
            if (Math.abs(tok.length - needle.length) <= 2 && levenshtein(tok, needle) <= 2) {
              closeMatch = t.text; // surface the original-case text
              break;
            }
          }
          if (closeMatch) break;
        }
        missing.push({ expected, closeMatch });
        if (closeMatch) promptStringsMisspelled++;
      }
      if (missing.length > 0) {
        const examples = missing
          .slice(0, 4)
          .map((m) =>
            m.closeMatch
              ? `"${m.expected}" → close match "${m.closeMatch.slice(0, 40)}" (likely misspelled — rename to exact)`
              : `"${m.expected}" not found in any text layer`,
          )
          .join('; ');
        reasons.push(
          `${missing.length} prompt-mentioned string(s) missing or misspelled on the canvas (${examples}). ` +
          `The system prompt's CONTENT FIDELITY rule says user-mentioned strings (brand names, button labels, ` +
          `field labels, numeric values) MUST appear as text layers, EXACTLY as written — never paraphrased, ` +
          `never misspelled. Call pen_update_node on the offending text layer(s) with changes: { text: "<exact string>" } ` +
          `(or pen_create_node with type:"text" if the layer doesn't exist yet). This is the #1 prompt-fidelity defect — ` +
          `flash models like agnes-3.0-flash occasionally tokenize brand names incorrectly (e.g. "Vaultly" → "Vaultily"); ` +
          `the deterministic post-build check catches it before the turn completes.`,
        );
      }
    }
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
      promptStringsExtracted,
      promptStringsFound,
      promptStringsMisspelled,
    },
  };
}

// ---- Rule 9 helpers -------------------------------------------------------

/** Extract concrete strings the user mentioned in the prompt. */
function extractPromptStrings(prompt: string): string[] {
  const out = new Set<string>();

  // 1. Quoted strings ("X" or 'X') — strip surrounding quotes, min length 2.
  const quoted = prompt.match(/["'"]([^"'"\n]{2,40})["'"]/g);
  if (quoted) {
    for (const q of quoted) {
      const stripped = q.replace(/^["'"]/, '').replace(/["'"]$/, '').trim();
      if (stripped.length >= 2 && !/^\d+$/.test(stripped)) out.add(stripped);
    }
  }

  // 2. Brand names: "called X" / "named X" / "app called X"
  // Take the next 1-3 tokens until sentence punctuation.
  const brandMatch = prompt.match(/\b(?:called|named)\s+(['"]?)([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,2})\1/g);
  if (brandMatch) {
    for (const m of brandMatch) {
      const name = m.replace(/^.*\b(?:called|named)\s+/, '').replace(/['"]/g, '').trim();
      if (name.length >= 2) out.add(name);
    }
  }

  // 3. Button labels: "X button" → X (1-3 capitalized words before "button")
  const btnMatch = prompt.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s+button\b/g);
  if (btnMatch) {
    for (const m of btnMatch) {
      const label = m.replace(/\s+button\b/, '').trim();
      if (label.length >= 2) out.add(label);
    }
  }

  // 4. Field labels: "X field" → X (capitalize first letter)
  const fieldMatch = prompt.match(/\b([a-zA-Z]+)\s+field\b/g);
  if (fieldMatch) {
    for (const m of fieldMatch) {
      const label = m.replace(/\s+field\b/, '');
      const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
      if (capitalized.length >= 2) out.add(capitalized);
    }
  }

  // 5. Link labels: "X link" → X (capitalize first letter)
  const linkMatch = prompt.match(/\b([a-zA-Z]+)\s+link\b/g);
  if (linkMatch) {
    for (const m of linkMatch) {
      const label = m.replace(/\s+link\b/, '');
      const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
      if (capitalized.length >= 2) out.add(capitalized);
    }
  }

  // 6. Tab labels: "X tab" → X
  const tabMatch = prompt.match(/\b([a-zA-Z]+)\s+tab\b/g);
  if (tabMatch) {
    for (const m of tabMatch) {
      const label = m.replace(/\s+tab\b/, '');
      const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
      if (capitalized.length >= 2) out.add(capitalized);
    }
  }

  // 7. Numeric values: "$128.4K" / "8,421" / "2.1%" / "$9" / "$19"
  const numMatch = prompt.match(/\$?\d[\d,]*\.?\d*\s*(?:K|M|B)?%?/g);
  if (numMatch) {
    for (const n of numMatch) {
      const cleaned = n.trim();
      if (cleaned.length >= 2 && /\d/.test(cleaned)) out.add(cleaned);
    }
  }

  // Filter out generic stopwords that aren't real content.
  const STOPWORDS = new Set([
    'Sign', 'Click', 'Get', 'Set', 'Add', 'New', 'Open', 'Close',
    'Submit', 'Cancel', 'Save', 'Edit', 'Delete', 'Update', 'Create',
    'Welcome', 'Hello', 'Home', 'Back', 'Next', 'Previous', 'Continue',
    // The "field" extractor above produces "Email" / "Password" — those
    // ARE real content (the user said "email field" / "password field").
    // Don't filter them.
  ]);
  return Array.from(out).filter((s) => !STOPWORDS.has(s));
}

/** Iterative Levenshtein distance (≤ 2 — short-circuit on early threshold). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > 2) return 99; // bail early — can't be ≤ 2
  if (al === 0) return bl;
  if (bl === 0) return al;
  // Two-row DP — O(al * bl) but bounded by |al - bl| ≤ 2 so it's tight.
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  const dist = prev[bl];
  return dist;
}

// ---- Rule 8: structural signature ------------------------------------------

/**
 * Ordered node-type tree shape of `node`'s subtree — the Rule 8
 * repeated-structure signature. Children are looked up in `shapes` by
 * `parentId` and ordered by x then y (position-stabilized); text content,
 * fills, names, and exact geometry values are ignored, so two subtrees with
 * the same type tree share one signature regardless of styling or copy.
 * `depth` caps how many descendant levels contribute (default 4).
 */
export function structuralSignature(node: Layer, shapes: Layer[], depth = 4): string {
  const childrenOf = (id: string) =>
    shapes
      .filter((s) => (s as { parentId?: string | null }).parentId === id)
      .sort((a, b) => a.x - b.x || a.y - b.y);
  const walk = (n: Layer, d: number): string => {
    const kids = d <= 0 ? [] : childrenOf(n.id);
    return `${n.type}(${kids.map((k) => walk(k, d - 1)).join(',')})`;
  };
  return walk(node, depth);
}

/**
 * True when `node` or any of its descendants (looked up in `shapes` by
 * `parentId`) is a component instance (`componentId` set). Depth-capped like
 * `structuralSignature` to guard against cycles in malformed trees.
 */
function subtreeHasComponentInstance(node: Layer, shapes: Layer[], depth = 8): boolean {
  if ((node as { componentId?: string | null }).componentId) return true;
  if (depth <= 0) return false;
  return shapes
    .filter((s) => (s as { parentId?: string | null }).parentId === node.id)
    .some((c) => subtreeHasComponentInstance(c, shapes, depth - 1));
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
