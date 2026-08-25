// .pen alias normalizer (spec Phase 6, §9.3 / Appendix G §G.2 + §G.4).
//
// The single parse-boundary canonicalizer: every place where EXTERNAL
// vocabulary enters the model — .pen import (penToCanvas), patch application
// (applyPatchToCanvas), and (part 2) tool-parameter execution — runs these
// functions so legacy spellings never produce an error, only canonical
// storage/projection.
//
// CONTRACT (all exported functions):
//   - PURE: no side effects, no I/O, no clock/random.
//   - TOTAL: never throws for unknown values — unknown inputs pass through
//     unchanged (callers flag via metadata when cheap). The `strict: true`
//     option flips that for tests: unknown values throw loudly instead of
//     silently defaulting (spec §10.2 #3).
//   - Dual-carry: `normalizePenNode` ADDS canonical v3 fields derived from
//     legacy spellings; it NEVER removes or rewrites the legacy fields (the
//     runtime resolver/panels/tools read legacy during the Phase 6 window).

import type { PenChild, PenFill, PenFills, PenEffect, FigmaPaint, FigmaEffect } from './types';
import { normalizeEnum, FIGMA_ENUM_ALIASES, type FigmaEnumDomain, type FigmaScaleMode } from './figma-ontology';

// ---- Per-domain enum normalizers -------------------------------------------

export interface NormalizeOpts {
  /** Throw on unknown values instead of passing them through (tests). */
  strict?: boolean;
}

function makeNormalizer(domain: FigmaEnumDomain) {
  return (v: unknown, opts?: NormalizeOpts): string => {
    const out = normalizeEnum(domain, v);
    if (out !== null) return out;
    if (opts?.strict) {
      throw new Error(`[pen/normalize] unknown ${domain} value: ${JSON.stringify(v)}`);
    }
    return v as string;
  };
}

/** layout: none|vertical|horizontal (+ legacy-cased layoutMode) → NONE|VERTICAL|HORIZONTAL */
export const normalizeLayoutMode = makeNormalizer('layoutMode');
/** start|center|end|space_between|space_around → MIN|CENTER|MAX|SPACE_BETWEEN|SPACE_AROUND */
export const normalizeAxisAlign = makeNormalizer('axisAlign');
/** fit_content|fill_container → HUG|FILL */
export const normalizeLayoutSizing = makeNormalizer('layoutSizing');
/** auto|absolute → AUTO|ABSOLUTE */
export const normalizeLayoutPositioning = makeNormalizer('layoutPositioning');
/** color|linear|radial|angular|image (+ canonical) → SOLID|GRADIENT_*|IMAGE */
export const normalizePaintType = makeNormalizer('paintType');
/** stretch|fill|fit (+ canonical) → STRETCH|FILL|FIT|TILE */
export const normalizeScaleMode = makeNormalizer('scaleMode');
/** inner|outer|blur|background_blur (+ canonical) → *_SHADOW|*_BLUR */
export const normalizeEffectType = makeNormalizer('effectType');
/** auto|fixed-width|fixed-width-height → WIDTH_AND_HEIGHT|NONE|HEIGHT */
export const normalizeTextAutoResize = makeNormalizer('textAutoResize');
/** left|right|center|scale|left_right → LEFT|RIGHT|CENTER|SCALE|LEFT_RIGHT */
export const normalizeConstraintsH = makeNormalizer('constraintsH');
/** top|bottom|center|scale|top_bottom → TOP|BOTTOM|CENTER|SCALE|TOP_BOTTOM */
export const normalizeConstraintsV = makeNormalizer('constraintsV');
/** color|number|string|boolean → COLOR|FLOAT|STRING|BOOLEAN */
export const normalizeVariableType = makeNormalizer('variableType');
/** legacy camelCase / lowercase blend modes → SCREAMING_SNAKE */
export const normalizeBlendMode = makeNormalizer('blendMode');
/** left|center_h|right|top|center_v|bottom|distribute_* → canonical align kinds */
export const normalizeAlignKind = makeNormalizer('alignKind');
/** left|center|right|justify → LEFT|CENTER|RIGHT|JUSTIFIED */
export const normalizeTextAlign = makeNormalizer('textAlign');

/**
 * Canonical → legacy storage spelling for a domain (the dual-field window's
 * down-map). Used where a canonical INPUT must be stored in the legacy field
 * shape legacy readers consume (patch `constraints`, `variableType`) —
 * acceptance without storage divergence. Deterministic: the FIRST legacy
 * alias (table order) that maps to the canonical value wins; a canonical
 * value with no legacy alias (e.g. TIDY) passes through unchanged.
 */
export function canonicalToAlias(domain: FigmaEnumDomain, canonical: string): string {
  for (const [legacy, canon] of Object.entries(FIGMA_ENUM_ALIASES[domain])) {
    if (canon === canonical) return legacy;
  }
  return canonical;
}

// ---- Fill / stroke / effect conversion (legacy .pen → v3 typed entries) ----

/** Derive normalized object-space gradient handles from a legacy angle (deg).
 *  start=(0.5−cos/2, 0.5−sin/2), end=(0.5+cos/2, 0.5+sin/2) — spec G.1 row 24. */
export function gradientAngleToHandles(angleDeg: number): Array<{ x: number; y: number }> {
  const theta = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [
    { x: 0.5 - cos / 2, y: 0.5 - sin / 2 },
    { x: 0.5 + cos / 2, y: 0.5 + sin / 2 },
  ];
}

function num(v: unknown, def: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return def;
}

/** One legacy fill entry → one v3 paint entry (unknown types pass through). */
export function fillToFigmaPaint(fill: PenFill | string): FigmaPaint {
  if (typeof fill === 'string') {
    // Plain hex / $variable string → SOLID paint.
    return { type: 'SOLID', color: fill };
  }
  const f = fill as Record<string, any>;
  const visible = f.enabled === false ? false : undefined;
  const blendMode = f.blendMode !== undefined ? normalizeBlendMode(f.blendMode) : undefined;
  switch (f.type) {
    case 'color':
      return { type: 'SOLID', color: f.color, visible, blendMode, ...(f.opacity !== undefined ? { opacity: num(f.opacity, 1) } : {}) };
    case 'gradient': {
      const gtype = normalizePaintType(f.gradientType ?? 'linear');
      const type = (gtype.startsWith('GRADIENT_') ? gtype : 'GRADIENT_LINEAR') as
        'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
      return {
        type,
        gradientStops: (f.colors ?? []).map((c: any) => ({
          position: num(c.position, 0),
          color: c.color,
        })),
        gradientHandlePositions: gradientAngleToHandles(num(f.rotation, 90)),
        visible,
        blendMode,
        ...(f.opacity !== undefined ? { opacity: num(f.opacity, 1) } : {}),
      };
    }
    case 'image':
      return {
        type: 'IMAGE',
        scaleMode: (f.mode !== undefined ? normalizeScaleMode(f.mode) : 'FILL') as FigmaScaleMode,
        imageRef: f.url,
        ...(f.url !== undefined ? { url: f.url } : {}),
        visible,
        blendMode,
        ...(f.opacity !== undefined ? { opacity: num(f.opacity, 1) } : {}),
      };
    default:
      // shader / mesh_gradient / future superset types pass through verbatim
      // (§9.1 rule (e): extensions are supersets).
      return fill as FigmaPaint;
  }
}

/** Legacy `fill`/`stroke` value (string | entry | array) → v3 paint array. */
export function fillsToFigmaPaints(fills: PenFills | undefined): FigmaPaint[] | undefined {
  if (fills === undefined || fills === null) return undefined;
  const arr = Array.isArray(fills) ? fills : [fills];
  return arr.map((f) => fillToFigmaPaint(f as PenFill));
}

/** One legacy effect entry → one v3 effect entry (unknown types pass through). */
export function effectToFigmaEffect(effect: PenEffect): FigmaEffect {
  const e = effect as Record<string, any>;
  const visible = e.enabled === false ? false : undefined;
  if (e.type === 'shadow') {
    const type = e.shadowType === 'inner' ? 'INNER_SHADOW' : 'DROP_SHADOW';
    return {
      type,
      offset: { x: num(e.offset?.x, 0), y: num(e.offset?.y, 0) },
      radius: num(e.blur, 0),
      spread: num(e.spread, 0),
      color: e.color ?? '#000000',
      visible,
      ...(e.blendMode !== undefined ? { blendMode: normalizeBlendMode(e.blendMode) as any } : {}),
    };
  }
  if (e.type === 'blur' || e.type === 'background_blur') {
    const t = normalizeEffectType(e.type);
    return { type: (t === 'BACKGROUND_BLUR' ? 'BACKGROUND_BLUR' : 'LAYER_BLUR') as any, radius: num(e.radius, 0), visible };
  }
  // Already-canonical or superset entry — normalize the type spelling when
  // recognized, otherwise pass through.
  const t = normalizeEffectType(e.type);
  if (typeof t === 'string' && t !== e.type) return { ...(e as object), type: t } as FigmaEffect;
  return e as unknown as FigmaEffect;
}

/** Legacy `effect` value (entry | array) → v3 effect array. */
export function effectsToFigmaEffects(effects: PenEffect | PenEffect[] | undefined): FigmaEffect[] | undefined {
  if (effects === undefined || effects === null) return undefined;
  const arr = Array.isArray(effects) ? effects : [effects];
  return arr.map((e) => effectToFigmaEffect(e as PenEffect));
}

// ---- Node-level dual-carry normalizer --------------------------------------

function paddingToSides(padding: unknown): { top: number; right: number; bottom: number; left: number } | null {
  if (padding === undefined || padding === null) return null;
  if (typeof padding === 'number') {
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  if (Array.isArray(padding)) {
    if (padding.length === 2) {
      const v = num(padding[0], 0);
      const h = num(padding[1], 0);
      return { top: v, bottom: v, left: h, right: h };
    }
    if (padding.length === 4) {
      return { top: num(padding[0], 0), right: num(padding[1], 0), bottom: num(padding[2], 0), left: num(padding[3], 0) };
    }
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

function sizingFromString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.startsWith('fit_content')) return 'HUG';
  if (v.startsWith('fill_container')) return 'FILL';
  return null;
}

/**
 * Normalize ONE .pen node (legacy spellings in → canonical v3 fields
 * populated out; legacy fields kept — dual-carry, single object).
 *
 * Idempotent: v3 fields already present are left alone (a divergent v3 value
 * wins over a re-derived legacy one), so
 * normalizePenNode(normalizePenNode(n)) deep-equals normalizePenNode(n).
 * Recurses into `children` and `descendants`.
 *
 * Constraints VALUE casing is deliberately NOT rewritten here (legacy readers
 * — the resolver's constraint application — match on the legacy spelling;
 * canonical casing is written by migrate.ts for the serialized v3 form and
 * accepted, never forced, at patch boundaries).
 */
export function normalizePenNode(node: PenChild): PenChild {
  if (!node || typeof node !== 'object') return node;
  const n = node as Record<string, any>;
  const out: Record<string, any> = { ...n };

  // layoutMode (from `layout` or a legacy-cased layoutMode)
  if (out.layoutMode === undefined) {
    if (n.layout !== undefined) out.layoutMode = normalizeLayoutMode(n.layout);
  } else {
    out.layoutMode = normalizeLayoutMode(out.layoutMode);
  }

  // itemSpacing (from `gap`)
  if (out.itemSpacing === undefined && n.gap !== undefined) {
    out.itemSpacing = n.gap;
  }

  // per-side padding (from `padding` scalar/tuple)
  const hasV3Padding =
    n.paddingLeft !== undefined || n.paddingRight !== undefined ||
    n.paddingTop !== undefined || n.paddingBottom !== undefined;
  if (!hasV3Padding && n.padding !== undefined) {
    const sides = paddingToSides(n.padding);
    if (sides) {
      out.paddingLeft = sides.left;
      out.paddingRight = sides.right;
      out.paddingTop = sides.top;
      out.paddingBottom = sides.bottom;
    }
  }

  // primaryAxisAlignItems / counterAxisAlignItems
  if (out.primaryAxisAlignItems === undefined && n.justifyContent !== undefined) {
    out.primaryAxisAlignItems = normalizeAxisAlign(n.justifyContent);
  }
  if (out.counterAxisAlignItems === undefined && n.alignItems !== undefined) {
    out.counterAxisAlignItems = normalizeAxisAlign(n.alignItems);
  }

  // layoutSizing* (from sizing strings / explicit numbers)
  if (out.layoutSizingHorizontal === undefined && n.width !== undefined) {
    const s = sizingFromString(n.width);
    out.layoutSizingHorizontal = s ?? (typeof n.width === 'number' ? 'FIXED' : undefined);
  }
  if (out.layoutSizingVertical === undefined && n.height !== undefined) {
    const s = sizingFromString(n.height);
    out.layoutSizingVertical = s ?? (typeof n.height === 'number' ? 'FIXED' : undefined);
  }

  // layoutPositioning (from `layoutPosition`)
  if (out.layoutPositioning === undefined && n.layoutPosition !== undefined) {
    out.layoutPositioning = normalizeLayoutPositioning(n.layoutPosition);
  }

  // fills / strokes / strokeWeight / effects
  if (out.fills === undefined && n.fill !== undefined) {
    out.fills = fillsToFigmaPaints(n.fill);
  }
  if (out.strokes === undefined && n.stroke !== undefined) {
    out.strokes = fillsToFigmaPaints(n.stroke);
  }
  if (out.strokeWeight === undefined && n.strokeWidth !== undefined) {
    out.strokeWeight = n.strokeWidth;
  }
  if (out.effects === undefined && n.effect !== undefined) {
    out.effects = effectsToFigmaEffects(n.effect);
  }

  // rectangleCornerRadii (from 4-tuple cornerRadius — tuple kept verbatim)
  if (out.rectangleCornerRadii === undefined && Array.isArray(n.cornerRadius) && n.cornerRadius.length === 4) {
    out.rectangleCornerRadii = [
      num(n.cornerRadius[0], 0),
      num(n.cornerRadius[1], 0),
      num(n.cornerRadius[2], 0),
      num(n.cornerRadius[3], 0),
    ];
  }

  // characters (from `content`)
  if (out.characters === undefined && n.content !== undefined) {
    out.characters = n.content;
  }

  // textAutoResize (from `textGrowth`)
  if (out.textAutoResize === undefined && n.textGrowth !== undefined) {
    out.textAutoResize = normalizeTextAutoResize(n.textGrowth);
  }

  // visible (from `enabled`)
  if (out.visible === undefined && n.enabled !== undefined) {
    out.visible = n.enabled;
  }

  // explicitVariableModes (from `theme` {axis:value})
  if (out.explicitVariableModes === undefined && n.theme && typeof n.theme === 'object') {
    const modes: Record<string, string> = {};
    for (const [axis, value] of Object.entries(n.theme)) {
      modes[`col:${axis}`] = `mode:${axis}:${value}`;
    }
    out.explicitVariableModes = modes;
  }

  // boundVariables (from `tokenBinding`)
  if (out.boundVariables === undefined && n.tokenBinding && typeof n.tokenBinding === 'object') {
    const bv: Record<string, Array<{ type: 'VARIABLE_ALIAS'; id: string }>> = {};
    if (n.tokenBinding.fillToken) bv.fills = [{ type: 'VARIABLE_ALIAS', id: `var:${n.tokenBinding.fillToken}` }];
    if (n.tokenBinding.strokeToken) bv.strokes = [{ type: 'VARIABLE_ALIAS', id: `var:${n.tokenBinding.strokeToken}` }];
    if (n.tokenBinding.textToken) bv.characters = [{ type: 'VARIABLE_ALIAS', id: `var:${n.tokenBinding.textToken}` }];
    out.boundVariables = bv;
  }

  // componentId (from `ref`)
  if (out.componentId === undefined && n.ref !== undefined) {
    out.componentId = n.ref;
  }

  // Recurse into children (containers) and descendants (ref overrides).
  if (Array.isArray(n.children)) {
    out.children = n.children.map((c: PenChild) => normalizePenNode(c));
  }
  if (n.descendants && typeof n.descendants === 'object') {
    const desc: Record<string, any> = {};
    for (const [path, override] of Object.entries(n.descendants as Record<string, any>)) {
      desc[path] = override && typeof override === 'object' && !Array.isArray(override)
        ? normalizePenNode(override as PenChild)
        : override;
    }
    out.descendants = desc;
  }

  return out as PenChild;
}

// ---- Patch payload normalizer (Appendix G §G.4) ----------------------------

// The patch op set and payload FIELD names are FROZEN (spec §5.1) — only
// enum VALUES normalize. Canonical values are accepted everywhere; values
// that must be stored in a legacy-shaped field during the dual-field window
// are down-mapped to their legacy spelling (acceptance without divergence).

type PatchLike = Record<string, any>;

/**
 * Normalize a CanvasPatch's enum VALUES (Appendix G §G.4):
 *   - `alignKind` → canonical spelling (LEFT/RIGHT/HCENTER/…/TIDY); the align
 *     op handler understands both spellings.
 *   - `constraints` → both casings accepted; stored in the LEGACY spelling
 *     (legacy readers — resolver constraint application, PropertiesPanel —
 *     match on legacy; canonical input is down-mapped, never an error).
 *   - `variableType` → both spellings accepted; stored legacy ('COLOR' →
 *     'color') because PenVariableDef.type keeps its 2.17 union during the
 *     window.
 *   - `themeAxis` semantics untouched (frozen op vocabulary).
 * Payload field NAMES (shapeId/shapeIds/…) stay exactly as sent (§5.1).
 */
export function normalizePatchPayload(patch: PatchLike): PatchLike {
  if (!patch || typeof patch !== 'object') return patch;
  const out: PatchLike = { ...patch };

  // alignKind: canonicalize UP (op handler handles both spellings + TIDY).
  if (typeof out.alignKind === 'string') {
    out.alignKind = normalizeAlignKind(out.alignKind);
  }

  // constraints: accept both casings; store the legacy spelling.
  if (out.constraints && typeof out.constraints === 'object' && !Array.isArray(out.constraints)) {
    const c = out.constraints as { horizontal?: string; vertical?: string };
    const next: { horizontal?: string; vertical?: string } = { ...c };
    if (typeof c.horizontal === 'string') {
      next.horizontal = canonicalToAlias('constraintsH', normalizeConstraintsH(c.horizontal));
    }
    if (typeof c.vertical === 'string') {
      next.vertical = canonicalToAlias('constraintsV', normalizeConstraintsV(c.vertical));
    }
    out.constraints = next;
  }

  // variableType: accept canonical COLOR/FLOAT/…; store legacy lowercase.
  if (typeof out.variableType === 'string') {
    out.variableType = canonicalToAlias('variableType', normalizeVariableType(out.variableType));
  }

  return out;
}
