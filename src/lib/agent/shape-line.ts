// Shape-line formatting shared by the LLM prompt snapshot (runner-legacy's
// canvasSnapshot / canvasSnapshotDelta) and the pen_get_metadata detail mode
// (tools.ts). Extracted verbatim from canvasSnapshot's formatNode closure in
// Phase C (R9a) so the delta digest and the on-demand hydration tool speak
// the EXACT same line vocabulary — the model reads a collapsed line in the
// digest, calls pen_get_metadata(nodeId, {detail:true}), and gets the same
// fields expanded. Byte-stability matters: the snapshot is part of the
// prompt-cache prefix contract (see runner-legacy PROMPT_VERSION).
//
// This module is PURE (types + string math only) and must stay dependency-
// free apart from types — both importers sit in hot paths, and tools.ts
// cannot import runner-legacy (circular: runner-legacy imports tools).

import type { Shape } from '../canvas/types';

function roundNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

/// Context the full-detail line needs: parent lookup (for the
/// `(in frame "...")` attribution) and the browser-measured-bounds map
/// (for the ` measured=w×h` readback — spec §3.8/§5.5, M2-c).
export interface ShapeLineContext {
  byId: Map<string, Shape>;
  measured?: Record<string, { width: number; height: number }>;
}

/// The FULL-detail layer line — identical bytes to canvasSnapshot's
/// formatNode output (regression-guarded by snapshot tests). Figma v3
/// vocabulary (D9 closure): characters=, layoutMode=, itemSpacing=, modes=,
/// visible=false — no legacy shape=/token substrings.
export function formatShapeLine(s: Shape, depth: number, ctx: ShapeLineContext): string {
  const indent = '  '.repeat(depth + 1);
  const bullet = depth === 0 ? '•' : '◦';
  const parent = s.parentId ? ctx.byId.get(s.parentId) : null;
  const parentLabel = parent ? ` (in ${parent.type} "${parent.name}")` : '';
  const constraintsLabel = s.constraints
    ? ` constraints=${s.constraints.horizontal}/${s.constraints.vertical}`
    : '';
  // v3 vocabulary (D9): characters= for text content presence.
  const charactersLabel = s.characters ?? s.text ? ` characters="${s.characters ?? s.text}"` : '';
  const componentLabel = s.componentId ? ` component=${s.componentId}` : '';
  // v3: layoutMode= (VERTICAL/HORIZONTAL) + itemSpacing= when an auto layout
  // is set — the Layer's v3 mirrors (M3-a dual-field window) with a legacy
  // fallback derived from `autoLayout`.
  const layoutMode = s.layoutMode ?? (s.autoLayout
    ? (s.autoLayout.direction === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL')
    : null);
  const layoutModeLabel = layoutMode ? ` layoutMode=${layoutMode}` : '';
  const itemSpacingLabel = (s.itemSpacing ?? s.autoLayout?.gap) != null
    ? ` itemSpacing=${s.itemSpacing ?? s.autoLayout?.gap}`
    : '';
  // v3: explicit variable modes on this node (legacy `theme` field).
  const modesLabel = s.theme && Object.keys(s.theme).length > 0
    ? ` modes=${JSON.stringify(s.theme)}`
    : '';
  // v3: visible=false (not enabled=false) — only surfaced when hidden.
  const visibleLabel = s.visible === false ? ' visible=false' : '';
  // Figma ontology extension fields:
  const sectionLabel = s.type === 'section' && s.label ? ` label="${s.label}"` : '';
  const variantAxesLabel = s.type === 'component_set' && s.variantPropertyAxes
    ? ` variantAxes=[${s.variantPropertyAxes.join(',')}]`
    : '';
  const variantValuesLabel = s.variantPropertyValues
    ? ` variant=${Object.entries(s.variantPropertyValues).map(([k, v]) => `${k}=${v}`).join(',')}`
    : '';
  const componentPropsLabel = s.componentPropertyDefinitions
    ? ` componentProps=[${Object.keys(s.componentPropertyDefinitions).join(',')}]`
    : '';
  const instancePropsLabel = s.componentProperties
    ? ` instanceProps=${JSON.stringify(s.componentProperties)}`
    : '';
  const booleanTypeLabel = s.booleanOperationType
    ? ` boolean=${s.booleanOperationType}`
    : '';
  const starLabel = s.type === 'star' && s.pointCount ? ` points=${s.pointCount}` : '';
  const polygonLabel = s.type === 'polygon' && s.polygonCount ? ` sides=${s.polygonCount}` : '';
  const mb = ctx.measured?.[s.id];
  const measuredLabel = mb && Number.isFinite(mb.width) && Number.isFinite(mb.height)
    ? ` measured=${Math.round(mb.width)}×${Math.round(mb.height)}`
    : '';
  return `${indent}${bullet} ${s.id} | ${s.type} "${s.name}" | pos=(${roundNum(s.x)},${roundNum(s.y)}) size=${roundNum(s.width)}×${roundNum(s.height)}${measuredLabel} fill=${s.fill}${charactersLabel}${parentLabel}${componentLabel}${layoutModeLabel}${itemSpacingLabel}${modesLabel}${visibleLabel}${constraintsLabel}${sectionLabel}${variantAxesLabel}${variantValuesLabel}${componentPropsLabel}${instancePropsLabel}${booleanTypeLabel}${starLabel}${polygonLabel}`;
}

/// The COLLAPSED line used by the delta digest (R9a) for unchanged subtrees:
/// enough structure to navigate (id/type/name/geometry/parent attribution)
/// plus an explicit expansion pointer. `descendantCount` is the number of
/// nodes hidden below (0 = leaf — no pointer noise).
export function formatShapeCollapsed(s: Shape, depth: number, descendantCount: number): string {
  const indent = '  '.repeat(depth + 1);
  const bullet = depth === 0 ? '•' : '◦';
  const hidden = descendantCount > 0
    ? ` (+${descendantCount} descendants, unchanged — pen_get_metadata("${s.id}", {detail:true}) expands)`
    : '';
  return `${indent}${bullet} ${s.id} | ${s.type} "${s.name}" | pos=(${roundNum(s.x)},${roundNum(s.y)}) size=${roundNum(s.width)}×${roundNum(s.height)}${hidden}`;
}
