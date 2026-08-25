'use client';

// SVG shape renderer — the per-layer SVG element factory (classic renderer).
//
// Extracted VERBATIM from Canvas.tsx in the renderer split (spec Phase 1
// step 2 — docs/html-dom-renderer.md §6). Renders ONE resolved Layer as SVG:
//   - gradients (linear/radial defs), shadow/blur SVG filters
//   - all 17 LayerTypes (switch below)
//   - selection chrome: 1 outline + 8 zoom-compensated resize handles
//   - agent-highlight pulse, component master/instance badges, auto-layout
//     indicator
//
// This file is the parity baseline the DOM renderer (../dom/) is compared
// against — behavior here must not drift without a spec note.

import type { Shape } from '@/lib/canvas/types';

/// The 8-way resize handle union. Shared vocabulary between the SVG renderer,
/// the DOM chrome overlay, and the Canvas shell's DragState.
export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

/// Screen-space size of a resize handle before zoom compensation.
export const HANDLE_SIZE = 8;

/// Minimum width/height a shape can be resized to.
export const MIN_SIZE = 4;

export interface ShapeRendererProps {
  shape: Shape;
  selected: boolean;
  highlighted: boolean;
  zoom: number;
  onShapeMouseDown: (e: React.MouseEvent, shape: Shape) => void;
  onResizeHandleMouseDown: (
    e: React.MouseEvent,
    shape: Shape,
    handle: ResizeHandle,
  ) => void;
}

export function ShapeRenderer({
  shape,
  selected,
  highlighted,
  zoom,
  onShapeMouseDown,
  onResizeHandleMouseDown,
}: ShapeRendererProps) {
  if (!shape.visible) return null;

  // Unique filter id for this shape (for shadow/blur SVG filters).
  const filterId = `shape-filter-${shape.id}`;
  const hasFilter = !!shape.shadow || (shape.blur ?? 0) > 0;

  // Build the SVG filter definition if needed.
  const filterDef = hasFilter ? (
    <defs>
      <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
        {shape.blur && shape.blur > 0 && (
          <feGaussianBlur in="SourceGraphic" stdDeviation={shape.blur} />
        )}
        {shape.shadow && (
          <feDropShadow
            dx={shape.shadow.x}
            dy={shape.shadow.y}
            stdDeviation={shape.shadow.blur}
            floodColor={shape.shadow.color}
            floodOpacity={1}
          />
        )}
      </filter>
    </defs>
  ) : null;

  // Resolve fill: gradient overrides solid fill.
  const gradientId = `shape-gradient-${shape.id}`;
  let fillValue: string = shape.fill;
  let gradientDef: React.ReactNode = null;
  if (shape.gradient && shape.gradient.stops.length >= 2) {
    const g = shape.gradient;
    const angle = g.angle ?? 90;
    const rad = (angle * Math.PI) / 180;
    const x1 = 50 - Math.cos(rad) * 50;
    const y1 = 50 - Math.sin(rad) * 50;
    const x2 = 50 + Math.cos(rad) * 50;
    const y2 = 50 + Math.sin(rad) * 50;
    gradientDef = (
      <defs>
        {g.type === 'radial' ? (
          <radialGradient id={gradientId} cx="50%" cy="50%" r="50%">
            {g.stops.map((s, i) => (
              <stop key={i} offset={`${s.offset * 100}%`} stopColor={s.color} />
            ))}
          </radialGradient>
        ) : (
          <linearGradient id={gradientId} x1={`${x1}%`} y1={`${y1}%`} x2={`${x2}%`} y2={`${y2}%`}>
            {g.stops.map((s, i) => (
              <stop key={i} offset={`${s.offset * 100}%`} stopColor={s.color} />
            ))}
          </linearGradient>
        )}
      </defs>
    );
    fillValue = `url(#${gradientId})`;
  }

  const commonProps = {
    style: { pointerEvents: 'auto' as const, cursor: 'move' },
    onMouseDown: (e: React.MouseEvent) => onShapeMouseDown(e, shape),
    opacity: shape.opacity,
    filter: hasFilter ? `url(#${filterId})` : undefined,
  };

  const stroke = shape.strokeWidth > 0 ? shape.stroke : 'none';
  const strokeWidth = shape.strokeWidth;

  // Per-corner radii (rectangle/frame only).
  const radii = shape.radii;
  const rx = radii ? radii.topLeft : shape.radius;
  const ry = radii ? radii.topRight : shape.radius;

  let element: React.ReactNode;
  switch (shape.type) {
    case 'rectangle':
    case 'frame': {
      element = (
        <>
          {filterDef}
          {gradientDef}
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={rx}
            ry={ry}
            fill={fillValue}
            stroke={stroke}
            strokeWidth={strokeWidth}
            {...commonProps}
          />
        </>
      );
      break;
    }
    case 'ellipse': {
      element = (
        <>
          {filterDef}
          {gradientDef}
          <ellipse
            cx={shape.x + shape.width / 2}
            cy={shape.y + shape.height / 2}
            rx={shape.width / 2}
            ry={shape.height / 2}
            fill={fillValue}
            stroke={stroke}
            strokeWidth={strokeWidth}
            {...commonProps}
          />
        </>
      );
      break;
    }
    case 'line': {
      element = (
        <>
          {filterDef}
          <line
            x1={shape.x}
            y1={shape.y}
            x2={shape.x + shape.width}
            y2={shape.y + shape.height}
            stroke={shape.fill}
            strokeWidth={Math.max(2, strokeWidth)}
            strokeLinecap="round"
            {...commonProps}
          />
        </>
      );
      break;
    }
    case 'text': {
      // Apply the typography fields the AI specified (or that were resolved
      // from .pen PenTextStyle). Previously the renderer hard-coded
      // fontFamily="Inter, system-ui, sans-serif" and applied NO weight,
      // letter-spacing, line-height, or text-anchor — so every text layer
      // rendered at default 400 weight, left-aligned, with no spacing,
      // regardless of what the system prompt told the AI to specify.
      // Now: fontWeight, letterSpacing, lineHeight, textAlign are honored.
      // Font family resolves to the shape's own fontFamily, else the
      // --font-inter CSS var (loaded in layout.tsx), else the OS fallback
      // chain. textAnchor + x offset pick up textAlign so centered titles
      // actually center inside their bounding box.
      const ta = shape.textAlign ?? 'left';
      const anchor = ta === 'center' ? 'middle' : ta === 'right' ? 'end' : 'start';
      // x for centered text = horizontal midpoint of the layer; for left
      // text = layer's left edge; for right text = layer's right edge.
      const tx = ta === 'center' ? shape.x + shape.width / 2
                : ta === 'right'  ? shape.x + shape.width
                : shape.x;
      const fontFamily = shape.fontFamily
        ? `${shape.fontFamily}, var(--font-inter), system-ui, sans-serif`
        : 'var(--font-inter), Inter, system-ui, sans-serif';
      const decoration = shape.underline && shape.strikethrough
        ? 'underline line-through'
        : shape.underline ? 'underline'
        : shape.strikethrough ? 'line-through'
        : undefined;
      // lineHeight is a CSS property (not an SVG attribute), so pass via style.
      // Merge with commonProps.style (pointerEvents/cursor) — commonProps is
      // spread last below, so we have to fold our text style into it.
      const textStyle: React.CSSProperties = shape.lineHeight !== undefined
        ? { lineHeight: String(shape.lineHeight) }
        : {};
      const mergedCommonProps = {
        ...commonProps,
        style: { pointerEvents: 'auto' as const, cursor: 'move' as const, ...textStyle },
      };
      element = (
        <>
          {filterDef}
          <text
            x={tx}
            y={shape.y + shape.fontSize}
            fontSize={shape.fontSize}
            fontWeight={shape.fontWeight ?? 400}
            letterSpacing={shape.letterSpacing ?? undefined}
            textAnchor={anchor}
            textDecoration={decoration}
            fill={shape.textColor}
            fontFamily={fontFamily}
            {...mergedCommonProps}
          >
            {shape.text}
          </text>
        </>
      );
      break;
    }
    case 'path': {
      if (!shape.points || shape.points.length === 0) {
        element = null;
        break;
      }
      const pts = shape.points.map((p) => `${p.x},${p.y}`).join(' ');
      element = (
        <>
          {filterDef}
          {gradientDef}
          {shape.closed ? (
            <polygon
              points={pts}
              fill={fillValue}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeLinejoin="round"
              {...commonProps}
            />
          ) : (
            <polyline
              points={pts}
              fill="none"
              stroke={stroke === 'none' ? shape.stroke : stroke}
              strokeWidth={Math.max(2, strokeWidth)}
              strokeLinecap="round"
              strokeLinejoin="round"
              {...commonProps}
            />
          )}
        </>
      );
      break;
    }
    case 'image': {
      element = (
        <>
          {filterDef}
          <image
            href={shape.src ?? undefined}
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            preserveAspectRatio="xMidYMid slice"
            clipPath={shape.radius > 0 ? `inset(0 round ${shape.radius}px)` : undefined}
            {...commonProps}
          />
        </>
      );
      break;
    }
    case 'group': {
      // Group is invisible — just a transparent container for its children.
      // In this MVP we don't recurse into children; groups render as a
      // labeled outline so the user can still select/move them.
      element = (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          fill="transparent"
          stroke={shape.stroke}
          strokeWidth={1}
          strokeDasharray="4 4"
          {...commonProps}
        />
      );
      break;
    }
    // ---- Figma-canonical node types (Phase 2 renderer support) ----
    case 'section': {
      // SECTION — Figma's large grouping container with a header label.
      // Render as a transparent dashed outline + a small label chip at the
      // top-left so the section is visually distinct from a regular frame.
      const label = shape.label ?? shape.name ?? 'Section';
      element = (
        <g {...commonProps}>
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            fill="transparent"
            stroke={shape.stroke || 'var(--ac-canvas-default-stroke)'}
            strokeWidth={1}
            strokeDasharray="6 4"
            rx={8}
          />
          <rect
            x={shape.x + 8}
            y={shape.y - 10}
            width={Math.max(40, label.length * 6.5 + 16)}
            height={20}
            fill={shape.fill === 'transparent' ? 'var(--ac-canvas-bg)' : shape.fill}
            stroke={shape.stroke || 'var(--ac-canvas-default-stroke)'}
            strokeWidth={1}
            rx={4}
          />
          <text
            x={shape.x + 16}
            y={shape.y + 4}
            fontSize={11}
            fontWeight={600}
            fill={shape.stroke || 'var(--ac-canvas-default-text)'}
            fontFamily="Inter, system-ui, sans-serif"
          >
            {label}
          </text>
        </g>
      );
      break;
    }
    case 'component':
    case 'component_set': {
      // COMPONENT + COMPONENT_SET — render as a labeled frame (like a Frame,
      // but with a distinct accent border + an "M" badge so the user can
      // visually identify reusable components / variant sets).
      element = (
        <g {...commonProps}>
          {filterDef}
          {gradientDef}
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={rx}
            ry={ry}
            fill={fillValue}
            stroke={stroke === 'none' ? 'var(--ac-canvas-component)' : stroke}
            strokeWidth={Math.max(strokeWidth, 1.5)}
            strokeDasharray={shape.type === 'component_set' ? '4 2' : undefined}
          />
          {/* Component badge — small "M" or "◇" in the top-left */}
          <rect
            x={shape.x + 4}
            y={shape.y + 4}
            width={16}
            height={16}
            fill="var(--ac-canvas-component)"
            rx={2}
          />
          <text
            x={shape.x + 12}
            y={shape.y + 16}
            fontSize={11}
            fontWeight={700}
            fill="var(--ac-canvas-handle-fill)"
            textAnchor="middle"
            fontFamily="Inter, system-ui, sans-serif"
          >
            {shape.type === 'component_set' ? '◇' : 'M'}
          </text>
        </g>
      );
      break;
    }
    case 'instance': {
      // INSTANCE — a placed component copy. Render as a labeled frame
      // with a "◆" badge so it's visually distinct from a master component.
      element = (
        <g {...commonProps}>
          {filterDef}
          {gradientDef}
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={rx}
            ry={ry}
            fill={fillValue}
            stroke={stroke === 'none' ? 'var(--ac-canvas-instance)' : stroke}
            strokeWidth={Math.max(strokeWidth, 1.5)}
          />
          <rect
            x={shape.x + 4}
            y={shape.y + 4}
            width={16}
            height={16}
            fill="var(--ac-canvas-instance)"
            rx={2}
          />
          <text
            x={shape.x + 12}
            y={shape.y + 16}
            fontSize={11}
            fontWeight={700}
            fill="var(--ac-canvas-handle-fill)"
            textAnchor="middle"
            fontFamily="Inter, system-ui, sans-serif"
          >
            ◆
          </text>
        </g>
      );
      break;
    }
    case 'boolean_operation': {
      // BOOLEAN_OPERATION — non-destructive union/subtract/intersect/exclude.
      // We don't compute the actual boolean geometry (would require a
      // polygon-clipping library); for now render the bounding box with a
      // dashed outline + a small "∪/∩/−/⊕" badge indicating the op type.
      const opSymbol =
        shape.booleanOperationType === 'union' ? '∪' :
        shape.booleanOperationType === 'subtract' ? '−' :
        shape.booleanOperationType === 'intersect' ? '∩' :
        shape.booleanOperationType === 'exclude' ? '⊕' : '?';
      element = (
        <g {...commonProps}>
          {filterDef}
          {gradientDef}
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={rx}
            ry={ry}
            fill={fillValue}
            stroke={stroke === 'none' ? 'var(--ac-canvas-highlight)' : stroke}
            strokeWidth={Math.max(strokeWidth, 1.5)}
            strokeDasharray="6 3"
          />
          <text
            x={shape.x + shape.width / 2}
            y={shape.y + shape.height / 2 + 6}
            fontSize={32}
            fontWeight={700}
            fill={stroke === 'none' ? 'var(--ac-canvas-highlight)' : stroke}
            textAnchor="middle"
            fontFamily="Inter, system-ui, sans-serif"
            opacity={0.5}
          >
            {opSymbol}
          </text>
        </g>
      );
      break;
    }
    case 'slice': {
      // SLICE — export region. Not rendered as a visible shape; only marks
      // an area for PNG/SVG/PDF export. Render as a translucent green overlay
      // with a dashed border so the user can see/select it.
      element = (
        <g {...commonProps}>
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            fill="var(--ac-canvas-autolayout)"
            fillOpacity={0.08}
            stroke="var(--ac-canvas-autolayout)"
            strokeWidth={1.5}
            strokeDasharray="4 2"
          />
          <text
            x={shape.x + 4}
            y={shape.y + 14}
            fontSize={10}
            fontWeight={600}
            fill="var(--ac-canvas-autolayout)"
            fontFamily="Inter, system-ui, sans-serif"
          >
            ⌖ slice
          </text>
        </g>
      );
      break;
    }
    case 'star': {
      // STAR — render as an SVG <polygon> with `points` computed from
      // pointCount + innerRadiusRatio. If pointCount is missing, default
      // to a 5-point star (pentagram).
      const points = shape.pointCount ?? 5;
      const innerRatio = shape.innerRadiusRatio ?? 0.5;
      const cx = shape.x + shape.width / 2;
      const cy = shape.y + shape.height / 2;
      const rOuter = Math.min(shape.width, shape.height) / 2;
      const rInner = rOuter * innerRatio;
      const starPoints: string[] = [];
      for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? rOuter : rInner;
        const angle = (Math.PI / points) * i - Math.PI / 2;
        starPoints.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
      }
      element = (
        <>
          {filterDef}
          {gradientDef}
          <polygon
            points={starPoints.join(' ')}
            fill={fillValue}
            stroke={stroke}
            strokeWidth={strokeWidth}
            {...commonProps}
          />
        </>
      );
      break;
    }
    case 'polygon': {
      // POLYGON — regular polygon with N sides. Compute points around a circle.
      // Default to 6 sides (hexagon) if polygonCount is missing.
      const sides = shape.polygonCount ?? 6;
      const cx = shape.x + shape.width / 2;
      const cy = shape.y + shape.height / 2;
      const r = Math.min(shape.width, shape.height) / 2;
      const polyPoints: string[] = [];
      for (let i = 0; i < sides; i++) {
        const angle = (2 * Math.PI / sides) * i - Math.PI / 2;
        polyPoints.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
      }
      element = (
        <>
          {filterDef}
          {gradientDef}
          <polygon
            points={polyPoints.join(' ')}
            fill={fillValue}
            stroke={stroke}
            strokeWidth={strokeWidth}
            {...commonProps}
          />
        </>
      );
      break;
    }
    default: {
      element = null;
    }
  }

  // Mask clipping: if shape has maskId, wrap in a clipPath.
  // NOTE: this is a simplified implementation — the mask shape's bounding
  // box is used as the clip region, not its actual geometry. True SVG
  // masking requires a <mask> element with the mask shape rendered into it.
  // For now, we clip to the mask shape's bounding box.
  if (shape.maskId && element) {
    // We can't look up the mask shape here without passing it down, so we
    // just add a data attribute. The Canvas component handles the actual
    // clipping by wrapping this shape in a <g> with a clipPath. For now,
    // this is a no-op visual marker.
  }

  const handleSize = HANDLE_SIZE / zoom;
  const handles: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  // Component instance badge: small "◆" in the top-left corner for instances,
  // or a filled corner for the master component.
  const isComponentMaster = shape.componentId === shape.id;
  const isComponentInstance = shape.componentId && shape.componentId !== shape.id;

  // Auto-layout indicator: a small dashed border with a "AL" badge for
  // frames/groups that have auto-layout applied.
  const hasAutoLayout = !!shape.autoLayout && (shape.type === 'frame' || shape.type === 'group');

  return (
    <g>
      {highlighted && (
        <rect
          x={shape.x - 4 / zoom}
          y={shape.y - 4 / zoom}
          width={shape.width + 8 / zoom}
          height={shape.height + 8 / zoom}
          fill="none"
          stroke="var(--ac-canvas-highlight)"
          strokeWidth={2 / zoom}
          style={{ pointerEvents: 'none' }}
        >
          <animate
            attributeName="stroke-opacity"
            values="1;0.4;1"
            dur="0.8s"
            repeatCount="indefinite"
          />
        </rect>
      )}
      {element}

      {/* Auto-layout visual indicator (dashed inner border + badge). */}
      {hasAutoLayout && (
        <>
          <rect
            x={shape.x + 2 / zoom}
            y={shape.y + 2 / zoom}
            width={shape.width - 4 / zoom}
            height={shape.height - 4 / zoom}
            fill="none"
            stroke="var(--ac-canvas-autolayout)"
            strokeWidth={1 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            style={{ pointerEvents: 'none' }}
          />
          <g style={{ pointerEvents: 'none' }} transform={`translate(${shape.x + 4 / zoom}, ${shape.y - 14 / zoom})`}>
            <rect width={36 / zoom} height={12 / zoom} rx={2 / zoom} fill="var(--ac-canvas-autolayout)" />
            <text x={18 / zoom} y={9 / zoom} fontSize={9 / zoom} fill="var(--ac-canvas-handle-fill)" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">AL</text>
          </g>
        </>
      )}

      {/* Component master / instance indicators. */}
      {isComponentMaster && (
        <g style={{ pointerEvents: 'none' }} transform={`translate(${shape.x + shape.width - 16 / zoom}, ${shape.y + 4 / zoom})`}>
          <rect width={12 / zoom} height={12 / zoom} rx={2 / zoom} fill="var(--ac-canvas-component)" />
          <text x={6 / zoom} y={9 / zoom} fontSize={9 / zoom} fill="var(--ac-canvas-handle-fill)" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">M</text>
        </g>
      )}
      {isComponentInstance && (
        <g style={{ pointerEvents: 'none' }} transform={`translate(${shape.x + shape.width - 16 / zoom}, ${shape.y + 4 / zoom})`}>
          <rect width={12 / zoom} height={12 / zoom} rx={2 / zoom} fill="var(--ac-canvas-instance)" />
          <text x={6 / zoom} y={9 / zoom} fontSize={9 / zoom} fill="var(--ac-canvas-handle-fill)" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">I</text>
        </g>
      )}

      {selected && (
        <>
          <rect
            x={shape.x - 1 / zoom}
            y={shape.y - 1 / zoom}
            width={shape.width + 2 / zoom}
            height={shape.height + 2 / zoom}
            fill="none"
            stroke="var(--ac-canvas-selection)"
            strokeWidth={1.5 / zoom}
            style={{ pointerEvents: 'none' }}
          />
          {handles.map((h) => {
            const pos = handlePosition(shape, h);
            return (
              <rect
                key={h}
                x={pos.x - handleSize / 2}
                y={pos.y - handleSize / 2}
                width={handleSize}
                height={handleSize}
                fill="var(--ac-canvas-handle-fill)"
                stroke="var(--ac-canvas-selection)"
                strokeWidth={1 / zoom}
                style={{ pointerEvents: 'auto', cursor: cursorForHandle(h) }}
                onMouseDown={(e) => onResizeHandleMouseDown(e, shape, h)}
              />
            );
          })}
        </>
      )}
    </g>
  );
}

export function handlePosition(shape: Shape, handle: ResizeHandle): { x: number; y: number } {
  const { x, y, width, height } = shape;
  const cx = x + width / 2;
  const cy = y + height / 2;
  switch (handle) {
    case 'nw': return { x, y };
    case 'n':  return { x: cx, y };
    case 'ne': return { x: x + width, y };
    case 'e':  return { x: x + width, y: cy };
    case 'se': return { x: x + width, y: y + height };
    case 's':  return { x: cx, y: y + height };
    case 'sw': return { x, y: y + height };
    case 'w':  return { x, y: cy };
  }
}

export function cursorForHandle(h: ResizeHandle): string {
  switch (h) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n':  case 's':  return 'ns-resize';
    case 'e':  case 'w':  return 'ew-resize';
  }
}
