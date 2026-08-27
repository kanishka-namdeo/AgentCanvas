'use client';

// islands.tsx — SVG islands for the DOM renderer's vector tail (spec §3.7).
//
// Freeform geometry that has no clean CSS equivalent (path polylines, stars,
// regular polygons) renders as an inline <svg> INSIDE the node div. The node
// div keeps positioning / hit-testing / z-order; the island only paints.
// Island SVG is excluded from chrome measurements — selection geometry always
// comes from the parent node rect.
//
// Also hosts the non-vector node CONTENT emitters that DomNode renders as
// children: the <img> for image nodes and the dashed-op-symbol placeholder
// for boolean_operation nodes.

import type { Layer } from '@/lib/canvas/types';
import { createElement } from 'react';
import { lucideIconElements, LUCIDE_DEFAULT_STROKE_WIDTH } from '@/lib/icons';

/// Render the island/content child for a vector, image, icon, or boolean node.
/// Returns null for every other type (DomNode only calls this for the types
/// that need it — see DomNode's content switch).
export function renderIsland(layer: Layer): React.ReactNode {
  switch (layer.type) {
    case 'path':
      return pathIsland(layer);
    case 'star':
      return starIsland(layer);
    case 'polygon':
      return polygonIsland(layer);
    case 'image':
      return imageContent(layer);
    case 'boolean_operation':
      return booleanContent(layer);
    case 'icon':
      return iconIsland(layer);
    default:
      return null;
  }
}

const ISLAND_SVG_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'visible',
  pointerEvents: 'none',
};

/// `path` — points are stored in ABSOLUTE canvas coordinates; the viewBox
/// offset (layer.x, layer.y) maps them into the node-local viewport so the
/// points can be used verbatim (exactly what the SVG renderer paints).
function pathIsland(layer: Layer): React.ReactNode {
  if (!layer.points || layer.points.length === 0) return null;
  const pts = layer.points.map((p) => `${p.x},${p.y}`).join(' ');
  const stroke = layer.strokeWidth > 0 ? layer.stroke : 'none';
  return (
    <svg
      width={layer.width}
      height={layer.height}
      viewBox={`${layer.x} ${layer.y} ${layer.width} ${layer.height}`}
      style={ISLAND_SVG_STYLE}
    >
      {layer.closed ? (
        <polygon
          points={pts}
          fill={layer.fill}
          stroke={stroke}
          strokeWidth={layer.strokeWidth}
          strokeLinejoin="round"
        />
      ) : (
        <polyline
          points={pts}
          fill="none"
          stroke={stroke === 'none' ? layer.stroke : stroke}
          strokeWidth={Math.max(2, layer.strokeWidth)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/// `star` — point math mirrors the legacy SVG renderer's star case
/// but with the center RELATIVE to the node (cx = width/2, cy = height/2)
/// inside a `0 0 w h` viewBox.
function starIsland(layer: Layer): React.ReactNode {
  const points = layer.pointCount ?? 5;
  const innerRatio = layer.innerRadiusRatio ?? 0.5;
  const cx = layer.width / 2;
  const cy = layer.height / 2;
  const rOuter = Math.min(layer.width, layer.height) / 2;
  const rInner = rOuter * innerRatio;
  const starPoints: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const angle = (Math.PI / points) * i - Math.PI / 2;
    starPoints.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
  }
  const stroke = layer.strokeWidth > 0 ? layer.stroke : 'none';
  return (
    <svg width={layer.width} height={layer.height} viewBox={`0 0 ${layer.width} ${layer.height}`} style={ISLAND_SVG_STYLE}>
      <polygon
        points={starPoints.join(' ')}
        fill={layer.fill}
        stroke={stroke}
        strokeWidth={layer.strokeWidth}
      />
    </svg>
  );
}

/// `polygon` — regular N-gon (polygonCount ?? 6), relative center, mirrors
/// the SVG renderer's math.
function polygonIsland(layer: Layer): React.ReactNode {
  const sides = layer.polygonCount ?? 6;
  const cx = layer.width / 2;
  const cy = layer.height / 2;
  const r = Math.min(layer.width, layer.height) / 2;
  const polyPoints: string[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (2 * Math.PI / sides) * i - Math.PI / 2;
    polyPoints.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
  }
  const stroke = layer.strokeWidth > 0 ? layer.stroke : 'none';
  return (
    <svg width={layer.width} height={layer.height} viewBox={`0 0 ${layer.width} ${layer.height}`} style={ISLAND_SVG_STYLE}>
      <polygon
        points={polyPoints.join(' ')}
        fill={layer.fill}
        stroke={stroke}
        strokeWidth={layer.strokeWidth}
      />
    </svg>
  );
}

/// `icon` — a Lucide library glyph (docs/lucide-icons.md). The node div is
/// the positioning/hit box; this island paints the glyph as an inline SVG on
/// the 24×24 lucide grid, stroke-painted with the layer's stroke color
/// (the resolver normalizes PenIcon.fill → layer.stroke). Stroke width stays
/// in viewBox units so it scales with the icon exactly like lucide-react
/// does when resized.
function iconIsland(layer: Layer): React.ReactNode {
  const elements = layer.iconName ? lucideIconElements(layer.iconName) : null;
  const stroke =
    layer.stroke && layer.stroke !== 'transparent'
      ? layer.stroke
      : layer.textColor && layer.textColor !== 'transparent'
        ? layer.textColor
        : '#0f172a';
  const sw = layer.strokeWidth > 0 ? layer.strokeWidth : LUCIDE_DEFAULT_STROKE_WIDTH;
  if (!elements) {
    // Unknown icon name — a visible dashed placeholder beat silent nothing:
    // the miss is immediately obvious on canvas (and in VLM critiques).
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          border: '1.5px dashed var(--ac-canvas-highlight)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          color: 'var(--ac-canvas-highlight)',
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      >
        {layer.iconName ? `⌗ ${layer.iconName}` : '⌗ icon'}
      </div>
    );
  }
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      preserveAspectRatio="xMidYMid meet"
      style={ISLAND_SVG_STYLE}
    >
      {elements.map((el, i) => createElement(el.tag, { key: i, ...el.attrs }))}
    </svg>
  );
}

/// `image` — plain <img> content; corner radius/clipping is handled by the
/// node wrapper (styleFor sets borderRadius + overflow:hidden), matching the
/// SVG renderer's inset(0 round Npx) clip.
function imageContent(layer: Layer): React.ReactNode {
  return (
    <img
      src={layer.src ?? undefined}
      alt=""
      draggable={false}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        pointerEvents: 'none',
        display: 'block',
      }}
    />
  );
}

/// `boolean_operation` — placeholder visual port (SVG parity): the node div
/// paints the fill; this child adds the dashed outline + the centered op
/// symbol. True boolean geometry needs a polygon-clipping lib (spec Phase 2+).
function booleanContent(layer: Layer): React.ReactNode {
  const opSymbol =
    layer.booleanOperationType === 'union' ? '∪' :
    layer.booleanOperationType === 'subtract' ? '−' :
    layer.booleanOperationType === 'intersect' ? '∩' :
    layer.booleanOperationType === 'exclude' ? '⊕' : '?';
  const color = layer.stroke || 'var(--ac-canvas-highlight)';
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        border: `1.5px dashed ${color}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <span style={{ fontSize: 32, fontWeight: 700, opacity: 0.5, color, pointerEvents: 'none' }}>
        {opSymbol}
      </span>
    </div>
  );
}
