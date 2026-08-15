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
import type { CanvasPatch, Shape } from '@/lib/canvas/types';

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
            'radial-gradient(circle, rgba(15,23,42,0.08) 1px, transparent 1px)',
          backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          backgroundPosition: `${panX}px ${panY}px`,
        }}
      />

      <svg
        className="absolute inset-0"
        width={size.w}
        height={size.h}
        style={{ pointerEvents: 'none' }}
      >
        <g transform={`translate(${panX}, ${panY}) scale(${zoom})`}>
          {/* Shapes — pointer events re-enabled per shape */}
          {document.shapes
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
        </g>
      </svg>

      {/* Zoom indicator */}
      <div className="absolute bottom-3 left-3 flex items-center gap-2 bg-white/90 backdrop-blur rounded-md border border-slate-200 shadow-sm px-2 py-1 text-xs text-slate-600">
        <button
          className="px-1 hover:text-slate-900"
          onClick={() => setViewport((v) => ({ ...v, zoom: Math.max(0.1, v.zoom * 0.9) }))}
        >
          −
        </button>
        <span className="tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
        <button
          className="px-1 hover:text-slate-900"
          onClick={() => setViewport((v) => ({ ...v, zoom: Math.min(4, v.zoom * 1.1) }))}
        >
          +
        </button>
        <button
          className="ml-1 px-2 py-0.5 rounded hover:bg-slate-100 text-slate-500"
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

function ShapeRenderer({
  shape,
  selected,
  highlighted,
  zoom,
  onShapeMouseDown,
  onResizeHandleMouseDown,
}: ShapeRendererProps) {
  if (!shape.visible) return null;

  const commonProps = {
    style: { pointerEvents: 'auto' as const, cursor: 'move' },
    onMouseDown: (e: React.MouseEvent) => onShapeMouseDown(e, shape),
    opacity: shape.opacity,
  };

  const stroke = shape.strokeWidth > 0 ? shape.stroke : 'none';
  const strokeWidth = shape.strokeWidth;

  let element: React.ReactNode;
  switch (shape.type) {
    case 'rectangle':
    case 'frame': {
      element = (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.radius}
          ry={shape.radius}
          fill={shape.fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          {...commonProps}
        />
      );
      break;
    }
    case 'ellipse': {
      element = (
        <ellipse
          cx={shape.x + shape.width / 2}
          cy={shape.y + shape.height / 2}
          rx={shape.width / 2}
          ry={shape.height / 2}
          fill={shape.fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          {...commonProps}
        />
      );
      break;
    }
    case 'line': {
      element = (
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
      );
      break;
    }
    case 'text': {
      element = (
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

  const handleSize = HANDLE_SIZE / zoom;
  const handles: NonNullable<DragState['handle']>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

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
