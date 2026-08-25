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

export interface StyleForOpts {
  /// Position of this node relative to its parent's absolute position
  /// (layer.x - parent.x). Root nodes pass parent 0,0 — i.e. relX = layer.x.
  relX: number;
  relY: number;
}

/// The container types whose `clip: true` clips their children (spec §3.5).
const CLIPPABLE_TYPES = new Set(['frame', 'component', 'instance', 'group', 'section']);

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

  if (layer.visible === false) {
    // See header: hidden subtree stays mounted (SVG mode unmounts it).
    style.visibility = 'hidden';
  }

  const isText = layer.type === 'text';
  const isVector = layer.type === 'path' || layer.type === 'star' || layer.type === 'polygon';

  // ---- Fill ------------------------------------------------------------------
  if (!isText && !isVector && layer.type !== 'group' && layer.type !== 'section') {
    // SVG ignores `fill` on text (glyphs use textColor) and on vector types
    // (islands paint fill themselves). Groups are transparent containers and
    // sections spend their fill on the label chip — neither paints a
    // background (SVG parity: fill="transparent" on both rects).
    if (layer.gradient && layer.gradient.stops.length >= 2) {
      style.background = gradientCss(layer.gradient);
    } else {
      style.background = layer.fill; // 'transparent' is a valid CSS background
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
      style.border = `${layer.strokeWidth}px solid ${layer.stroke}`;
    } else {
      style.border = `1.5px solid ${layer.type === 'instance' ? 'var(--ac-canvas-instance)' : 'var(--ac-canvas-component)'}`;
    }
    if (layer.type === 'component_set') {
      style.borderStyle = 'dashed'; // SVG: strokeDasharray '4 2'
    }
  } else if (layer.type === 'boolean_operation') {
    // Dashed placeholder outline — mirrors the SVG renderer's dashed rect.
    style.border = `1.5px dashed ${layer.stroke || 'var(--ac-canvas-highlight)'}`;
  } else if (layer.type === 'slice') {
    // Translucent export-region overlay (SVG: fillOpacity 0.08 + dashed 1.5px).
    style.background = 'color-mix(in oklch, var(--ac-canvas-autolayout) 8%, transparent)';
    style.border = '1.5px dashed var(--ac-canvas-autolayout)';
  } else if (layer.type === 'section') {
    // Always-on dashed outline (SVG parity); the label chip is child content.
    style.border = `1px dashed ${layer.stroke || 'var(--ac-canvas-default-stroke)'}`;
    style.borderRadius = 8; // SVG parity (rx=8)
  } else if (layer.type === 'group') {
    // Transparent container — no bg/border. Selection/hover outline is drawn
    // by the chrome overlay (replaces SVG's always-on dashed rect).
  } else if (!isText && !isVector && layer.type !== 'line') {
    if (layer.strokeWidth > 0) {
      style.border = `${layer.strokeWidth}px solid ${layer.stroke}`;
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
    style.background = layer.fill; // SVG <line> strokes with shape.fill
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
    style.color = layer.textColor;
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
