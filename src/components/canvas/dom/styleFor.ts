// styleFor — the pure .pen Layer → CSSProperties mapping (spec Phase 1,
// docs/html-dom-renderer.md Appendix B). The shared paint vocabulary for the
// DOM renderer: parity mode renders every node absolutely positioned with
// resolver-computed geometry, so the emitted CSS is a strict translation of
// the same Layer fields the SVG renderer consumes.
//
// Design notes (divergences from the SVG renderer are intentional + documented):
//   - `visible === false` → `visibility: hidden` (NOT display:none and NOT
//     the SVG renderer's "return null"). The subtree stays MOUNTED so a
//     future re-show (or an agent patching `visible: true` on a descendant)
//     does not remount it, and DOM measurement/nesting stays stable. Children
//     inherit the hidden visibility; hidden elements are excluded from
//     hit-testing, so interaction parity with SVG mode is preserved.
//   - Text nodes: the SVG renderer paints the first baseline at y + fontSize.
//     A DOM text block positions glyphs by its line box, which differs by
//     roughly (lineHeight - fontSize) / 2 ≈ 10% of fontSize at default
//     metrics. Documented, acceptable parity-mode divergence (spec Phase 2
//     measured-bounds readback tightens this).
//   - `line` nodes render as a rotated pill (width = hypot(w,h), height =
//     max(2, strokeWidth), round caps via border-radius: 9999px). SVG uses a
//     <line> with strokeLinecap="round"; the pill is the CSS equivalent.
//   - Vector types (path/star/polygon) get no fill/stroke CSS here — their
//     geometry is painted by SVG islands (./islands.tsx); the node div is the
//     positioning/hit box.
//
// Pure function: no React state, no DOM reads, safe in jsdom tests.

import type { GradientFill, Layer } from '@/lib/canvas/types';
import type { PenChild, PenLayout } from '@/lib/pen/types';
import { cssVarName } from './variables';

export interface StyleForOpts {
  /// Position of this node relative to its parent's absolute position
  /// (layer.x - parent.x). Root nodes pass parent 0,0 — i.e. relX = layer.x.
  relX: number;
  relY: number;
  /// Native layout mode (spec §3.4, Phase 2): when present, this node renders
  /// as a CSS FLEX CONTAINER (its .pen `layout` is vertical/horizontal) —
  /// display:flex + direction/gap/padding/justify/align per the §3.4 table.
  /// Its children then flow per the browser instead of absolute positioning.
  nativeLayout?: NativeLayoutOpts;
  /// Native layout mode: when present, this node is a FLOW child of a flex
  /// parent — geometry comes from `flexChildStyle` (its own .pen sizing
  /// modes) instead of the resolver's predicted absolute box; no
  /// left/top are emitted. Absent → absolute positioning (parity behavior).
  flowChild?: FlowChildOpts;
}

/// Flex-container emission options derived from a .pen node's layout fields
/// (see `nativeLayoutOptsFor`).
export interface NativeLayoutOpts {
  direction: 'vertical' | 'horizontal';
  gap: number;
  padding?: PaddingTuple;
  justifyContent?: string;
  alignItems?: string;
}

/// The .pen padding shapes: all sides | [vertical, horizontal] |
/// [top, right, bottom, left] (numbers may arrive as strings from patch
/// payloads — coerced per-side by `expandPadding`).
export type PaddingTuple = number | [number | string, number | string] | [number | string, number | string, number | string, number | string];

/// A node's own flex-item sizing inputs (its .pen width/height) + the
/// parent's flex direction.
export interface FlowChildOpts {
  penWidth: unknown;
  penHeight: unknown;
  parentDirection: 'vertical' | 'horizontal';
}

/// The container types whose `clip: true` clips their children (spec §3.5).
const CLIPPABLE_TYPES = new Set(['frame', 'component', 'instance', 'group', 'section']);

/// .pen justifyContent → CSS justify-content (spec §3.4 table).
const JUSTIFY_MAP: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  space_between: 'space-between',
  space_around: 'space-around',
};

/// .pen alignItems → CSS align-items (spec §3.4 table).
const ALIGN_MAP: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
};

/// `fit_content` / `fit_content(n)` — the optional paren fallback is the
/// minimum size until real content (or measured bounds) says otherwise.
const FIT_CONTENT_RE = /^fit_content(?:\((\d+)\))?$/;

function toPxNum(v: unknown, def = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return def;
}

/**
 * Derive the flex-container emission options from a .pen node's layout
 * fields (spec §3.4 table). Returns null when the node is NOT a flex
 * container (`layout` undefined / 'none' / unparseable) — callers then keep
 * absolute positioning.
 */
export function nativeLayoutOptsFor(pen: PenChild | undefined | null): NativeLayoutOpts | null {
  if (!pen) return null;
  const l = pen as PenLayout;
  if (l.layout !== 'vertical' && l.layout !== 'horizontal') return null;
  return {
    direction: l.layout,
    gap: toPxNum(l.gap, 0),
    padding: l.padding as PaddingTuple | undefined,
    justifyContent: l.justifyContent,
    alignItems: l.alignItems,
  };
}

/**
 * Expand a .pen padding (1 number | [v,h] | [t,r,b,l]) to per-side px values.
 * Port of the resolver's `resolvePadding` (resolve.ts) — the same shapes the
 * flexbox engine consumes — so parity mode and native mode agree on padding
 * semantics. Non-numeric entries coerce to 0.
 */
export function expandPadding(pad?: PaddingTuple | null): { top: number; right: number; bottom: number; left: number } {
  if (pad === undefined || pad === null) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof pad === 'number') return { top: pad, right: pad, bottom: pad, left: pad };
  if (Array.isArray(pad)) {
    if (pad.length === 2) {
      const v = toPxNum(pad[0], 0);
      const h = toPxNum(pad[1], 0);
      return { top: v, bottom: v, left: h, right: h };
    }
    if (pad.length >= 4) {
      return { top: toPxNum(pad[0], 0), right: toPxNum(pad[1], 0), bottom: toPxNum(pad[2], 0), left: toPxNum(pad[3], 0) };
    }
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

/**
 * The flex-ITEM sizing rule for one .pen node inside a flex parent
 * (spec §3.4 table — pure, exported for unit tests):
 *
 *   number (or numeric string)      → explicit px on that dimension (fixed)
 *   'fill_container'                → main axis `flex: 1 1 0`, cross axis
 *                                     `align-self: stretch`; the dimension
 *                                     itself is omitted (browser-driven)
 *   'fit_content' / 'fit_content(n)'→ auto size (dimension omitted); main
 *                                     axis `flex: 0 0 auto`, cross axis
 *                                     `align-self: auto`; the paren fallback
 *                                     n becomes min-width/min-height
 *   unspecified / $variable         → treated as fit_content without a
 *                                     fallback (auto) — variables cannot be
 *                                     resolved here (no document context)
 *
 * Main axis = the parent's flex direction (vertical → height, horizontal →
 * width); cross axis is the other one.
 *
 * NOTE: the main-axis flex rules are emitted as LONGHANDS (`flexGrow` /
 * `flexShrink` / `flexBasis`) rather than the `flex` shorthand — the computed
 * CSS is identical in real browsers, and jsdom's CSSOM drops the shorthand
 * (making integration tests blind to it). flexGrow 1 / flexShrink 1 /
 * flexBasis 0 ≡ `flex: 1 1 0`; 0 / 0 / auto ≡ `flex: 0 0 auto`.
 */
export function flexChildStyle(
  penWidth: unknown,
  penHeight: unknown,
  parentDirection: 'vertical' | 'horizontal',
): React.CSSProperties {
  const style: React.CSSProperties = {};

  const apply = (value: unknown, isMain: boolean, isWidth: boolean) => {
    // Fixed size: number (or numeric string).
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (isWidth) style.width = `${value}px`;
      else style.height = `${value}px`;
      return;
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      const n = Number(value);
      if (isWidth) style.width = `${n}px`;
      else style.height = `${n}px`;
      return;
    }
    // fill_container: main axis grows (flex-basis 0), cross axis stretches.
    if (typeof value === 'string' && value.startsWith('fill_container')) {
      if (isMain) {
        // ≡ flex: 1 1 0 (see the header note).
        style.flexGrow = 1;
        style.flexShrink = 1;
        style.flexBasis = 0;
      } else {
        style.alignSelf = 'stretch';
      }
      return;
    }
    // fit_content (with optional paren minimum) or unspecified: auto-size.
    if (typeof value === 'string') {
      const m = FIT_CONTENT_RE.exec(value.trim());
      if (m) {
        const min = Number(m[1]);
        if (Number.isFinite(min)) {
          if (isWidth) style.minWidth = `${min}px`;
          else style.minHeight = `${min}px`;
        }
      }
    }
    if (isMain) {
      // ≡ flex: 0 0 auto (see the header note).
      style.flexGrow = 0;
      style.flexShrink = 0;
      style.flexBasis = 'auto';
    } else {
      style.alignSelf = 'auto';
    }
  };

  // Parent direction vertical → main axis is HEIGHT; horizontal → WIDTH.
  apply(penHeight, parentDirection === 'vertical', false);
  apply(penWidth, parentDirection === 'horizontal', true);
  return style;
}

export function styleFor(layer: Layer, opts: StyleForOpts): React.CSSProperties {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${opts.relX}px`,
    top: `${opts.relY}px`,
    width: `${layer.width}px`,
    height: `${layer.height}px`,
    zIndex: layer.zIndex,
    boxSizing: 'border-box',
    // The world container has pointer-events: none; each node re-enables it
    // so DOM hit-testing replaces the SVG renderer's bbox top-hit.
    pointerEvents: 'auto',
    cursor: 'move',
  };

  // ---- Native layout mode (spec §3.4, Phase 2) -----------------------------
  // Flex ITEM: this node flows inside a flex parent — geometry comes from
  // the .pen sizing modes (flexChildStyle), not the resolver's predicted
  // absolute box. Absolute positioning is emitted only for children of
  // layout:'none' parents and `layoutPosition: 'absolute'` opt-outs
  // (DomNode decides which — styleFor just applies what it is told).
  if (opts.flowChild) {
    delete style.position;
    delete style.left;
    delete style.top;
    delete style.width;
    delete style.height;
    Object.assign(
      style,
      flexChildStyle(opts.flowChild.penWidth, opts.flowChild.penHeight, opts.flowChild.parentDirection),
    );
  }

  // Flex CONTAINER: this node's .pen layout is vertical/horizontal — emit
  // the §3.4 flex mapping. Paint styles below are unchanged: only geometry /
  // layout differ between the two modes.
  if (opts.nativeLayout) {
    const nl = opts.nativeLayout;
    style.display = 'flex';
    style.flexDirection = nl.direction === 'vertical' ? 'column' : 'row';
    style.gap = `${nl.gap}px`;
    const p = expandPadding(nl.padding);
    style.padding = `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;
    style.justifyContent = JUSTIFY_MAP[nl.justifyContent ?? 'start'] ?? 'flex-start';
    if (nl.alignItems) style.alignItems = ALIGN_MAP[nl.alignItems] ?? 'flex-start';
    if (opts.flowChild) {
      // A flowing flex container is un-positioned, but its
      // `layoutPosition: 'absolute'` children need it as their containing
      // block — relative positioning anchors them here without removing the
      // container from its own parent's flow.
      style.position = 'relative';
    }
  }

  if (layer.visible === false) {
    // See header: hidden subtree stays mounted (SVG mode unmounts it).
    style.visibility = 'hidden';
  }

  const isText = layer.type === 'text';
  const isVector = layer.type === 'path' || layer.type === 'star' || layer.type === 'polygon';

  // ---- Token bindings → CSS custom properties (spec §3.6, Phase 2) -------------
  // When the world container publishes `--acv-*` custom properties (see
  // dom/variables.ts), bound nodes reference them so a `set_variable` patch
  // repaints via the cascade. The resolver-resolved value stays as the var()
  // FALLBACK — SVG mode / server-side renders (no custom properties) and
  // unbound variables keep today's exact output.
  const fillVarName = layer.tokenBinding?.fillToken ? cssVarName(layer.tokenBinding.fillToken) : null;
  const textVarName = layer.tokenBinding?.textToken ? cssVarName(layer.tokenBinding.textToken) : null;
  const strokeVarName = layer.tokenBinding?.strokeToken ? cssVarName(layer.tokenBinding.strokeToken) : null;
  const fillCss = fillVarName ? `var(${fillVarName}, ${layer.fill})` : layer.fill;
  const textCss = textVarName ? `var(${textVarName}, ${layer.textColor})` : layer.textColor;
  const strokeCss = strokeVarName && layer.stroke ? `var(${strokeVarName}, ${layer.stroke})` : layer.stroke;

  // ---- Fill ------------------------------------------------------------------
  if (!isText && !isVector && layer.type !== 'group' && layer.type !== 'section') {
    // SVG ignores `fill` on text (glyphs use textColor) and on vector types
    // (islands paint fill themselves). Groups are transparent containers and
    // sections spend their fill on the label chip — neither paints a
    // background (SVG parity: fill="transparent" on both rects).
    if (layer.gradient && layer.gradient.stops.length >= 2) {
      style.background = gradientCss(layer.gradient);
    } else {
      style.background = fillCss; // 'transparent' is a valid CSS background
    }
  }

  // ---- Stroke → border ---------------------------------------------------------
  // box-sizing: border-box keeps the OUTER geometry identical to the SVG bbox
  // (SVG strokes center on the path edge; this is the closest CSS equivalent
  // without the inset-border trick — spec Appendix B `strokeAlignment` row).
  if (layer.type === 'component' || layer.type === 'component_set' || layer.type === 'instance') {
    // Accent default: SVG renders these with a component/instance accent
    // border when no explicit stroke is set (Math.max(strokeWidth, 1.5)).
    if (layer.strokeWidth > 0) {
      style.border = `${layer.strokeWidth}px solid ${strokeCss}`;
    } else {
      style.border = `1.5px solid ${layer.type === 'instance' ? 'var(--ac-canvas-instance)' : 'var(--ac-canvas-component)'}`;
    }
    if (layer.type === 'component_set') {
      style.borderStyle = 'dashed'; // SVG: strokeDasharray '4 2'
    }
  } else if (layer.type === 'boolean_operation') {
    // Dashed placeholder outline — mirrors the SVG renderer's dashed rect.
    style.border = `1.5px dashed ${strokeCss || 'var(--ac-canvas-highlight)'}`;
  } else if (layer.type === 'slice') {
    // Translucent export-region overlay (SVG: fillOpacity 0.08 + dashed 1.5px).
    style.background = 'color-mix(in oklch, var(--ac-canvas-autolayout) 8%, transparent)';
    style.border = '1.5px dashed var(--ac-canvas-autolayout)';
  } else if (layer.type === 'section') {
    // Always-on dashed outline (SVG parity); the label chip is child content.
    style.border = `1px dashed ${strokeCss || 'var(--ac-canvas-default-stroke)'}`;
    style.borderRadius = 8; // SVG parity (rx=8)
  } else if (layer.type === 'group') {
    // Transparent container — no bg/border. Selection/hover outline is drawn
    // by the chrome overlay (replaces SVG's always-on dashed rect).
  } else if (!isText && !isVector && layer.type !== 'line') {
    if (layer.strokeWidth > 0) {
      style.border = `${layer.strokeWidth}px solid ${strokeCss}`;
    }
  }

  // ---- Corner radii -------------------------------------------------------------
  if (isText || layer.type === 'line' || layer.type === 'group' || layer.type === 'slice') {
    // Radii don't apply: text is glyph painting, line is a pill, group/slice
    // are outline-only containers.
  } else if (layer.type === 'ellipse') {
    // Ellipse ignores radius fields — always a circle/ellipse mask.
    style.borderRadius = '50%';
  } else if (layer.radii) {
    style.borderRadius = `${layer.radii.topLeft}px ${layer.radii.topRight}px ${layer.radii.bottomRight}px ${layer.radii.bottomLeft}px`;
  } else if (layer.radius > 0) {
    style.borderRadius = `${layer.radius}px`;
  }

  // ---- Effects -------------------------------------------------------------------
  if (layer.shadow) {
    if (isText) {
      // Follow the glyphs, not the box (SVG parity: filter applies to the
      // <text> element itself).
      style.textShadow = `${layer.shadow.x}px ${layer.shadow.y}px ${layer.shadow.blur}px ${layer.shadow.color}`;
    } else {
      const spread = layer.shadow.spread ?? 0;
      const inset = layer.shadow.inset ? ' inset' : '';
      style.boxShadow = `${layer.shadow.x}px ${layer.shadow.y}px ${layer.shadow.blur}px ${spread}px ${layer.shadow.color}${inset}`;
    }
  }
  if ((layer.blur ?? 0) > 0) {
    style.filter = `blur(${layer.blur}px)`;
  }
  if (layer.opacity !== 1) {
    style.opacity = layer.opacity;
  }

  // ---- Rotation (spec defect D4 — NEW on-screen rendering) ------------------------
  // Both export paths always honored `rotation`; the SVG renderer ignored it.
  // The DOM renderer makes rotation canonical on-screen: transform-origin at
  // the top-left corner matches the .pen/export rotate-around-origin math.
  if (layer.type === 'line') {
    // The pill's own angle composes with the layer rotation.
    const len = Math.hypot(layer.width, layer.height);
    const angle = Math.atan2(layer.height, layer.width) * (180 / Math.PI);
    style.width = `${len}px`;
    style.height = `${Math.max(2, layer.strokeWidth)}px`; // SVG parity: Math.max(2, strokeWidth)
    style.borderRadius = '9999px'; // round line caps
    style.background = fillCss; // SVG <line> strokes with shape.fill
    style.transform = `rotate(${angle + (layer.rotation || 0)}deg)`;
    style.transformOrigin = '0 0';
  } else if (layer.rotation) {
    style.transform = `rotate(${layer.rotation}deg)`;
    style.transformOrigin = '0 0';
  }

  // ---- Clip ---------------------------------------------------------------------
  if (layer.clip && CLIPPABLE_TYPES.has(layer.type)) {
    // Nested + free replacement for the SVG renderer's per-frame <clipPath>
    // def machinery (spec §3.5).
    style.overflow = 'hidden';
  }
  if (layer.type === 'image' && layer.radius > 0) {
    // Round image corners via the wrapper (SVG: inset(0 round Npx) clipPath).
    style.borderRadius = `${layer.radius}px`;
    style.overflow = 'hidden';
  }

  // ---- Text typography ------------------------------------------------------------
  if (isText) {
    style.color = textCss;
    style.fontSize = layer.fontSize;
    style.fontWeight = layer.fontWeight ?? 400;
    style.fontFamily = layer.fontFamily
      ? `${layer.fontFamily}, var(--font-inter), system-ui, sans-serif`
      : 'var(--font-inter), Inter, system-ui, sans-serif';
    if (layer.letterSpacing !== undefined) {
      style.letterSpacing = `${layer.letterSpacing}px`;
    }
    if (layer.lineHeight !== undefined) {
      style.lineHeight = String(layer.lineHeight);
    }
    if (layer.textAlign) {
      style.textAlign = layer.textAlign;
    }
    const decoration =
      layer.underline && layer.strikethrough ? 'underline line-through'
      : layer.underline ? 'underline'
      : layer.strikethrough ? 'line-through'
      : undefined;
    if (decoration) {
      style.textDecoration = decoration;
    }
    style.whiteSpace = 'pre-wrap';
    style.wordBreak = 'break-word';
    // Column flow so multi-line text + child nodes stack in document order.
    style.display = 'flex';
    style.flexDirection = 'column';
    // Baseline parity: SVG places the first baseline at y + fontSize; the DOM
    // line box centers glyphs in the line height. paddingTop: 0 pins the first
    // line box to the box top — the residual ~10% fontSize divergence is
    // documented at the top of this file.
    style.paddingTop = 0;
  }

  return style;
}

/// Gradient → CSS background string (spec Appendix B).
/// Angle convention: .pen 0° points right; CSS 0° points up → cssAngle =
/// penAngle + 90. Stops are emitted `<color> <offset>%` (CSS color-stop
/// grammar: color first, position second).
function gradientCss(g: GradientFill): string {
  const stops = g.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(', ');
  if (g.type === 'radial') {
    return `radial-gradient(circle, ${stops})`;
  }
  const cssAngle = (g.angle ?? 90) + 90;
  return `linear-gradient(${cssAngle}deg, ${stops})`;
}
