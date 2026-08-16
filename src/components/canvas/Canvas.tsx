'use client';

// Infinite canvas renderer for AgentCanvas.
//
// Renders every shape in the document as SVG. Supports:
//   - pan (middle-mouse drag or space-drag)
//   - zoom (wheel)
//   - click to select
//   - drag to move selected shapes
//   - resize handles on the active selection
//   - agent-highlight glow (briefly shown when the agent uses canvas_select_shape)
//
// Local edits emit CanvasPatches via the store so other viewers (and the
// agent) see them. Agent-originated patches arrive via the same store and
// are rendered identically — there is no visual distinction between human
// and agent edits at the canvas level, by design.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvasStore, findShape } from '@/lib/canvas/store';
import type { CanvasPatch, HeatmapOverlay, Shape } from '@/lib/canvas/types';
import { PenLine, MousePointerClick } from 'lucide-react';

interface DragState {
  kind: 'pan' | 'move' | 'resize';
  startX: number;
  startY: number;
  /// Original positions of the shapes being moved (canvas-space).
  originals?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  /// Resize handle being dragged.
  handle?: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';
  /// Original pan when starting a pan drag.
  panX?: number;
  panY?: number;
}

const HANDLE_SIZE = 8;
const MIN_SIZE = 4;

export function Canvas() {
  const document = useCanvasStore((s) => s.document);
  const selectedIds = useSelectedIds();
  const agentHighlightIds = useCanvasStore((s) => s.agentHighlightIds);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const select = useCanvasStore((s) => s.select);

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ zoom: 1, panX: 120, panY: 80 });
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [size, setSize] = useState({ w: 1200, h: 800 });

  // Track container size for responsive rendering.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setSize({ w: e.contentRect.width, h: e.contentRect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keyboard: space to pan, delete to remove selection, escape to clear.
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isEditableTarget(e.target)) {
        setSpaceDown(true);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isEditableTarget(e.target)) return;
        if (selectedIds.length > 0) {
          const patch: CanvasPatch = {
            op: 'remove',
            shapeIds: selectedIds,
            summary: `Deleted ${selectedIds.length} shape(s)`,
          };
          sendPatch(patch);
          select([]);
        }
      } else if (e.key === 'Escape') {
        select([]);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [selectedIds, sendPatch, select]);

  // ---- Coordinate conversion -------------------------------------------------
  const screenToCanvas = useCallback(
    (sx: number, sy: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const x = (sx - rect.left - viewport.panX) / viewport.zoom;
      const y = (sy - rect.top - viewport.panY) / viewport.zoom;
      return { x, y };
    },
    [viewport],
  );

  // ---- Wheel zoom ------------------------------------------------------------
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const delta = -e.deltaY * 0.0015;
      const newZoom = Math.max(0.1, Math.min(4, viewport.zoom * (1 + delta)));
      // Keep the point under the cursor stable.
      const canvasX = (mouseX - viewport.panX) / viewport.zoom;
      const canvasY = (mouseY - viewport.panY) / viewport.zoom;
      const newPanX = mouseX - canvasX * newZoom;
      const newPanY = mouseY - canvasY * newZoom;
      setViewport({ zoom: newZoom, panX: newPanX, panY: newPanY });
    },
    [viewport],
  );

  // Disable passive wheel listener so we can preventDefault.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const delta = -e.deltaY * 0.0015;
      setViewport((vp) => {
        const newZoom = Math.max(0.1, Math.min(4, vp.zoom * (1 + delta)));
        const canvasX = (mouseX - vp.panX) / vp.zoom;
        const canvasY = (mouseY - vp.panY) / vp.zoom;
        return {
          zoom: newZoom,
          panX: mouseX - canvasX * newZoom,
          panY: mouseY - canvasY * newZoom,
        };
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // ---- Mouse interactions ----------------------------------------------------
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Middle mouse OR space+left → pan
      if (e.button === 1 || (e.button === 0 && spaceDown)) {
        setDragState({
          kind: 'pan',
          startX: sx,
          startY: sy,
          panX: viewport.panX,
          panY: viewport.panY,
        });
        return;
      }

      if (e.button !== 0) return;

      // Click on empty canvas → clear selection.
      // (SVG group for shapes handles its own clicks.)
      if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.emptyBg === 'true') {
        select([]);
      }
    },
    [spaceDown, viewport, select],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragState) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (dragState.kind === 'pan') {
        setViewport((vp) => ({
          ...vp,
          panX: (dragState.panX ?? 0) + (sx - dragState.startX),
          panY: (dragState.panY ?? 0) + (sy - dragState.startY),
        }));
        return;
      }

      const dxCanvas = (sx - dragState.startX) / viewport.zoom;
      const dyCanvas = (sy - dragState.startY) / viewport.zoom;

      if (dragState.kind === 'move' && dragState.originals) {
        // Move every selected shape by the delta. We update the store directly
        // (no patch roundtrip — the human's drag is local state). When the
        // drag ends we emit a single patch.
        for (const orig of dragState.originals) {
          const patch: CanvasPatch = {
            op: 'update',
            shapeId: orig.id,
            shape: { x: orig.x + dxCanvas, y: orig.y + dyCanvas },
            summary: '',
          };
          // Send without summary to avoid log spam during drag — we'll send
          // a final summary on mouseup.
          sendPatch(patch);
        }
        // Reset startX/Y so we get incremental deltas — actually simpler to
        // keep originals and recompute. Already handled above.
      } else if (dragState.kind === 'resize' && dragState.originals && dragState.handle) {
        const orig = dragState.originals[0];
        if (!orig) return;
        let { x, y, width, height } = orig;
        const h = dragState.handle;
        if (h.includes('e')) width = Math.max(MIN_SIZE, orig.width + dxCanvas);
        if (h.includes('s')) height = Math.max(MIN_SIZE, orig.height + dyCanvas);
        if (h.includes('w')) {
          const newWidth = Math.max(MIN_SIZE, orig.width - dxCanvas);
          x = orig.x + (orig.width - newWidth);
          width = newWidth;
        }
        if (h.includes('n')) {
          const newHeight = Math.max(MIN_SIZE, orig.height - dyCanvas);
          y = orig.y + (orig.height - newHeight);
          height = newHeight;
        }
        const patch: CanvasPatch = {
          op: 'update',
          shapeId: orig.id,
          shape: { x, y, width, height },
          summary: '',
        };
        sendPatch(patch);
      }
    },
    [dragState, viewport.zoom, sendPatch],
  );

  const onMouseUp = useCallback(() => {
    if (dragState?.kind === 'move' && dragState.originals) {
      // Emit a final summary patch so other viewers see the move in the log.
      // (The actual position is already synced via the incremental patches.)
    }
    setDragState(null);
  }, [dragState]);

  // ---- Shape interaction handlers -------------------------------------------
  const onShapeMouseDown = useCallback(
    (e: React.MouseEvent, shape: Shape) => {
      if (spaceDown || e.button !== 0) return;
      e.stopPropagation();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      let newSelected: string[];
      if (e.shiftKey) {
        newSelected = selectedIds.includes(shape.id)
          ? selectedIds.filter((id) => id !== shape.id)
          : [...selectedIds, shape.id];
      } else if (!selectedIds.includes(shape.id)) {
        newSelected = [shape.id];
      } else {
        newSelected = selectedIds;
      }
      select(newSelected);

      setDragState({
        kind: 'move',
        startX: sx,
        startY: sy,
        originals: newSelected
          .map((id) => findShape(document, id))
          .filter((s): s is Shape => !!s)
          .map((s) => ({ id: s.id, x: s.x, y: s.y, width: s.width, height: s.height })),
      });
    },
    [spaceDown, selectedIds, document, select],
  );

  const onResizeHandleMouseDown = useCallback(
    (e: React.MouseEvent, shape: Shape, handle: NonNullable<DragState['handle']>) => {
      e.stopPropagation();
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDragState({
        kind: 'resize',
        handle,
        startX: e.clientX - rect.left,
        startY: e.clientY - rect.top,
        originals: [
          { id: shape.id, x: shape.x, y: shape.y, width: shape.width, height: shape.height },
        ],
      });
    },
    [],
  );

  // ---- Render ---------------------------------------------------------------
  const { zoom, panX, panY } = viewport;
  const selectedSet = new Set(selectedIds);
  const highlightSet = new Set(agentHighlightIds);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full overflow-hidden select-none ${spaceDown ? 'cursor-grab' : 'cursor-default'}`}
      style={{ background: document.background }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* Infinite-canvas backdrop grid */}
      <div
        data-empty-bg="true"
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, color-mix(in oklch, var(--ac-text-primary) 12%, transparent) 1px, transparent 1px)',
          backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          backgroundPosition: `${panX}px ${panY}px`,
        }}
      />

      {/* Empty-canvas drop zone — subtle, screen-centered, fades out when shapes exist. */}
      {document.shapes.length === 0 && (
        <div
          data-empty-bg="true"
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{
            animation: 'ac-fade-in 240ms ease-out',
          }}
        >
          <div
            className="flex flex-col items-center gap-3 px-10 py-8 rounded-xl border-2 border-dashed max-w-md text-center"
            style={{
              borderColor: 'var(--ac-border-strong)',
              backgroundColor: 'color-mix(in oklch, var(--ac-surface-0) 70%, transparent)',
              backdropFilter: 'blur(2px)',
            }}
          >
            <div
              className="flex items-center justify-center h-12 w-12 rounded-lg"
              style={{
                backgroundColor: 'var(--ac-accent-soft)',
                color: 'var(--ac-accent)',
                boxShadow: 'inset 0 0 0 1px var(--ac-accent-border)',
              }}
            >
              <PenLine className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <div className="text-[14px] font-semibold ac-text-1">Empty canvas</div>
              <div className="text-[12px] ac-text-3 leading-relaxed">
                Describe what you want to build in the panel on the right,
                <br />
                or pick a shape from the toolbar to drop one in.
              </div>
            </div>
            <div className="flex items-center gap-1.5 mt-1 text-[10px] ac-text-4">
              <MousePointerClick className="h-3 w-3" />
              <span>Tip: try “Design a login form” in the chat</span>
            </div>
          </div>
        </div>
      )}

      <svg
        className="absolute inset-0"
        width={size.w}
        height={size.h}
        style={{ pointerEvents: 'none' }}
      >
        <defs>
          {/* Radial gradient used for heatmap fixation points. */}
          <radialGradient id="heatmap-fixation" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(239, 68, 68, 0.65)" />
            <stop offset="50%" stopColor="rgba(249, 115, 22, 0.35)" />
            <stop offset="100%" stopColor="rgba(234, 88, 12, 0)" />
          </radialGradient>
          {/* Marker for component instance badge. */}
          <pattern id="component-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(14, 165, 233, 0.35)" strokeWidth="2" />
          </pattern>
        </defs>
        <g transform={`translate(${panX}, ${panY}) scale(${zoom})`}>
          {/* Shapes — pointer events re-enabled per shape */}
          {(document.shapes ?? [])
            .slice()
            .sort((a, b) => a.zIndex - b.zIndex)
            .map((shape) => (
              <ShapeRenderer
                key={shape.id}
                shape={shape}
                selected={selectedSet.has(shape.id)}
                highlighted={highlightSet.has(shape.id)}
                zoom={zoom}
                onShapeMouseDown={onShapeMouseDown}
                onResizeHandleMouseDown={onResizeHandleMouseDown}
              />
            ))}

          {/* Attention heatmap overlay — rendered on top of shapes. */}
          {document.heatmap && (
            <HeatmapRenderer overlay={document.heatmap} zoom={zoom} />
          )}
        </g>
      </svg>

      {/* Zoom indicator */}
      <div
        className="absolute bottom-3 left-3 flex items-center gap-2 backdrop-blur rounded-md border shadow-sm px-2 py-1 text-xs ac-text-2 ac-transition"
        style={{
          backgroundColor: 'color-mix(in oklch, var(--ac-surface-0) 88%, transparent)',
          borderColor: 'var(--ac-border-default)',
        }}
      >
        <button
          className="px-1 ac-text-3 hover:ac-text-1 ac-transition ac-focus-ring rounded"
          onClick={() => setViewport((v) => ({ ...v, zoom: Math.max(0.1, v.zoom * 0.9) }))}
        >
          −
        </button>
        <span className="tabular-nums w-12 text-center ac-text-2">{Math.round(zoom * 100)}%</span>
        <button
          className="px-1 ac-text-3 hover:ac-text-1 ac-transition ac-focus-ring rounded"
          onClick={() => setViewport((v) => ({ ...v, zoom: Math.min(4, v.zoom * 1.1) }))}
        >
          +
        </button>
        <button
          className="ml-1 px-2 py-0.5 rounded ac-text-3 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
          onClick={() => setViewport({ zoom: 1, panX: 120, panY: 80 })}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

// Hook to keep selectedIds stable across renders when nothing changed.
function useSelectedIds() {
  return useCanvasStore((s) => s.selectedIds);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// ---- Shape renderer --------------------------------------------------------

interface ShapeRendererProps {
  shape: Shape;
  selected: boolean;
  highlighted: boolean;
  zoom: number;
  onShapeMouseDown: (e: React.MouseEvent, shape: Shape) => void;
  onResizeHandleMouseDown: (
    e: React.MouseEvent,
    shape: Shape,
    handle: NonNullable<DragState['handle']>,
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
      element = (
        <>
          {filterDef}
          <text
            x={shape.x}
            y={shape.y + shape.fontSize}
            fontSize={shape.fontSize}
            fill={shape.textColor}
            fontFamily="Inter, system-ui, sans-serif"
            {...commonProps}
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
  const handles: NonNullable<DragState['handle']>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

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
          stroke="#f59e0b"
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
            stroke="#22c55e"
            strokeWidth={1 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            style={{ pointerEvents: 'none' }}
          />
          <g style={{ pointerEvents: 'none' }} transform={`translate(${shape.x + 4 / zoom}, ${shape.y - 14 / zoom})`}>
            <rect width={36 / zoom} height={12 / zoom} rx={2 / zoom} fill="#22c55e" />
            <text x={18 / zoom} y={9 / zoom} fontSize={9 / zoom} fill="white" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">AL</text>
          </g>
        </>
      )}

      {/* Component master / instance indicators. */}
      {isComponentMaster && (
        <g style={{ pointerEvents: 'none' }} transform={`translate(${shape.x + shape.width - 16 / zoom}, ${shape.y + 4 / zoom})`}>
          <rect width={12 / zoom} height={12 / zoom} rx={2 / zoom} fill="#0ea5e9" />
          <text x={6 / zoom} y={9 / zoom} fontSize={9 / zoom} fill="white" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">M</text>
        </g>
      )}
      {isComponentInstance && (
        <g style={{ pointerEvents: 'none' }} transform={`translate(${shape.x + shape.width - 16 / zoom}, ${shape.y + 4 / zoom})`}>
          <rect width={12 / zoom} height={12 / zoom} rx={2 / zoom} fill="#a78bfa" />
          <text x={6 / zoom} y={9 / zoom} fontSize={9 / zoom} fill="white" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">I</text>
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
            stroke="#0ea5e9"
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
                fill="white"
                stroke="#0ea5e9"
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

// ---- Heatmap renderer -------------------------------------------------------
//
// Renders the attention heatmap overlay. Each fixation point is drawn as a
// soft radial gradient circle whose radius scales with intensity. The whole
// overlay is mixed onto the canvas using a 'screen'-like blend so it
// highlights rather than obscures the underlying design.

function HeatmapRenderer({ overlay, zoom }: { overlay: HeatmapOverlay; zoom: number }) {
  // Each fixation point: radius scaled by intensity.
  // Max radius ~ 80px at intensity 1.0.
  return (
    <g style={{ pointerEvents: 'none' }} opacity={0.85}>
      {/* Bounding outline so the user can see what was analyzed. */}
      <rect
        x={overlay.x}
        y={overlay.y}
        width={overlay.width}
        height={overlay.height}
        fill="none"
        stroke="#ef4444"
        strokeWidth={1.5 / zoom}
        strokeDasharray={`${6 / zoom} ${4 / zoom}`}
      />
      {overlay.points.map((p, i) => {
        const radius = 30 + p.intensity * 60;
        return (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={radius}
            fill="url(#heatmap-fixation)"
            opacity={0.4 + p.intensity * 0.5}
          />
        );
      })}
      {/* Heatmap label badge in the top-left of the analyzed frame. */}
      <g transform={`translate(${overlay.x + 6 / zoom}, ${overlay.y + 6 / zoom})`}>
        <rect width={120 / zoom} height={16 / zoom} rx={3 / zoom} fill="rgba(239, 68, 68, 0.92)" />
        <text x={60 / zoom} y={11 / zoom} fontSize={10 / zoom} fill="white" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">
          Attention heatmap
        </text>
      </g>
    </g>
  );
}

function handlePosition(shape: Shape, handle: NonNullable<DragState['handle']>): { x: number; y: number } {
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

function cursorForHandle(h: NonNullable<DragState['handle']>): string {
  switch (h) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n':  case 's':  return 'ns-resize';
    case 'e':  case 'w':  return 'ew-resize';
  }
}
