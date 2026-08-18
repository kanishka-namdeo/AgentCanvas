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
//   - P0-01/02: right-click context menu (empty canvas + shape variants)
//
// Local edits emit CanvasPatches via the store so other viewers (and the
// agent) see them. Agent-originated patches arrive via the same store and
// are rendered identically — there is no visual distinction between human
// and agent edits at the canvas level, by design.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvasStore, findShape } from '@/lib/canvas/store';
import { useClipboard } from '@/hooks/use-clipboard';
import type { CanvasPatch, Shape } from '@/lib/canvas/types';
import { PenLine, MousePointerClick, Scissors, Copy, ClipboardPaste, Trash2, ArrowUp, ArrowDown, BringToFront, SendToBack, Group as GroupIcon, SquareStack, Lock, Eye } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

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
  const toolMode = useCanvasStore((s) => s.toolMode);
  const clipboard = useClipboard();
  // P0-01/02: Track the last right-click position + the shape under the cursor
  // at right-click time. The context-menu items use these to choose between
  // the empty-canvas and shape variants.
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [contextShape, setContextShape] = useState<Shape | null>(null);

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

      // Middle mouse OR space+left OR pan-tool-mode+left → pan
      if (e.button === 1 || (e.button === 0 && (spaceDown || toolMode === 'pan'))) {
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
    [spaceDown, toolMode, viewport, select],
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
        //
        // Figma-hierarchy note: a shape's stored x/y is RELATIVE to its
        // parent's content origin for nested nodes (parentId !== null), and
        // ABSOLUTE for top-level nodes. `orig.x/y` from `findShape` is the
        // resolved ABSOLUTE position. So before emitting the patch, if the
        // shape is nested, subtract the parent's absolute position to convert
        // the new absolute position back to a relative one. (Without this,
        // moving a nested shape would double-offset it visually.)
        for (const orig of dragState.originals) {
          const current = findShape(document, orig.id);
          let newX = orig.x + dxCanvas;
          let newY = orig.y + dyCanvas;
          if (current?.parentId) {
            const parent = findShape(document, current.parentId);
            if (parent) {
              newX -= parent.x;
              newY -= parent.y;
            }
          }
          const patch: CanvasPatch = {
            op: 'update',
            shapeId: orig.id,
            shape: { x: newX, y: newY },
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
        // P1-18: Shift-constrain on resize — lock aspect ratio to the
        // original shape's width / height ratio. Apply the larger delta
        // (width or height) and compute the other dimension from the ratio.
        if (e.shiftKey && orig.width > 0 && orig.height > 0) {
          const ratio = orig.width / orig.height;
          // Determine the dominant axis based on the handle.
          if (h === 'e' || h === 'w' || h === 'ne' || h === 'nw' || h === 'se' || h === 'sw') {
            // Horizontal-resizing handle: compute height from width.
            const newHeightFromWidth = width / ratio;
            // If the handle includes 'n' or 's', adjust y accordingly.
            if (h.includes('n')) {
              y = orig.y + (orig.height - newHeightFromWidth);
            }
            height = newHeightFromWidth;
          } else if (h === 'n' || h === 's') {
            // Vertical-resizing handle: compute width from height.
            const newWidthFromHeight = height * ratio;
            x = orig.x + (orig.width - newWidthFromHeight) / 2;
            width = newWidthFromHeight;
          }
        }
        // Figma-hierarchy: like the move handler, if the resized shape is
        // nested, convert the new absolute x/y to relative coords by
        // subtracting the parent's absolute position. Width/height stay the
        // same — they're not parent-relative.
        const current = findShape(document, orig.id);
        let relX = x;
        let relY = y;
        if (current?.parentId) {
          const parent = findShape(document, current.parentId);
          if (parent) {
            relX -= parent.x;
            relY -= parent.y;
          }
        }
        const patch: CanvasPatch = {
          op: 'update',
          shapeId: orig.id,
          shape: { x: relX, y: relY, width, height },
          summary: '',
        };
        sendPatch(patch);
      }
    },
    [dragState, viewport.zoom, sendPatch, document],
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
      // In pan mode, clicking a shape should pan, not select.
      if (spaceDown || toolMode === 'pan' || e.button !== 0) return;
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
    [spaceDown, toolMode, selectedIds, document, select],
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

  // P0-01/02: onContextMenu — track the right-click position + the shape
  // under the cursor so the menu items can choose between variants.
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Convert screen-space click to canvas-space.
      const cx = (sx - viewport.panX) / viewport.zoom;
      const cy = (sy - viewport.panY) / viewport.zoom;
      setContextMenuPos({ x: cx, y: cy });
      // Find the topmost shape under the cursor (highest zIndex first).
      const shapes = document.shapes ?? [];
      const hit = shapes
        .slice()
        .sort((a, b) => b.zIndex - a.zIndex)
        .find((s) => cx >= s.x && cx <= s.x + s.width && cy >= s.y && cy <= s.y + s.height);
      setContextShape(hit ?? null);
      // If the right-clicked shape is NOT already in the selection, select it
      // (so the menu items that operate on selectedIds operate on the right
      // shape). If the user right-clicked empty canvas, leave the selection
      // alone so multi-selection ops still work.
      if (hit && !selectedIds.includes(hit.id)) {
        select([hit.id]);
      }
      // Don't preventDefault — let the ContextMenu wrapper handle that.
    },
    [document.shapes, viewport.panX, viewport.panY, viewport.zoom, selectedIds, select],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className={`relative w-full h-full overflow-hidden select-none ${(spaceDown || toolMode === 'pan') ? 'cursor-grab' : 'cursor-default'}`}
          style={{ background: document.background }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onContextMenu={onContextMenu}
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
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => setViewport((v) => ({ ...v, zoom: Math.max(0.1, v.zoom * 0.9) }))}
        >
          −
        </button>
        <span className="tabular-nums w-12 text-center ac-text-2" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button
          className="px-1 ac-text-3 hover:ac-text-1 ac-transition ac-focus-ring rounded"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => setViewport((v) => ({ ...v, zoom: Math.min(4, v.zoom * 1.1) }))}
        >
          +
        </button>
        <button
          className="ml-1 px-2 py-0.5 rounded ac-text-3 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
          aria-label="Reset zoom to 100%"
          title="Reset zoom to 100%"
          onClick={() => setViewport({ zoom: 1, panX: 120, panY: 80 })}
        >
          Reset
        </button>
      </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {/* P0-01 vs P0-02: choose variant based on whether a shape was hit. */}
        {contextShape ? (
          <>
            {/* === Shape right-click (P0-02) === */}
            <ContextMenuItem onClick={() => clipboard.cut([contextShape])}>
              <Scissors className="h-3.5 w-3.5 mr-2" /> Cut <span className="ml-auto text-[10px] ac-text-4">⌘X</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => clipboard.copy([contextShape])}>
              <Copy className="h-3.5 w-3.5 mr-2" /> Copy <span className="ml-auto text-[10px] ac-text-4">⌘C</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => clipboard.paste()}>
              <ClipboardPaste className="h-3.5 w-3.5 mr-2" /> Paste <span className="ml-auto text-[10px] ac-text-4">⌘V</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => clipboard.paste({ offset: { dx: 0, dy: 0 } })}>
              <ClipboardPaste className="h-3.5 w-3.5 mr-2" /> Paste in place <span className="ml-auto text-[10px] ac-text-4">⌘⇧V</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => sendPatch({ op: 'duplicate', shapeIds: [contextShape.id], summary: `Duplicated ${contextShape.name}` })}>
              <Copy className="h-3.5 w-3.5 mr-2" /> Duplicate here <span className="ml-auto text-[10px] ac-text-4">⌘D</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => sendPatch({ op: 'zorder', shapeIds: [contextShape.id], zorderKind: 'forward', summary: `Bring forward` })}>
              <ArrowUp className="h-3.5 w-3.5 mr-2" /> Bring forward <span className="ml-auto text-[10px] ac-text-4">⌘]</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => sendPatch({ op: 'zorder', shapeIds: [contextShape.id], zorderKind: 'front', summary: `Bring to front` })}>
              <BringToFront className="h-3.5 w-3.5 mr-2" /> Bring to front <span className="ml-auto text-[10px] ac-text-4">⌘⇧]</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => sendPatch({ op: 'zorder', shapeIds: [contextShape.id], zorderKind: 'backward', summary: `Send backward` })}>
              <ArrowDown className="h-3.5 w-3.5 mr-2" /> Send backward <span className="ml-auto text-[10px] ac-text-4">⌘[</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => sendPatch({ op: 'zorder', shapeIds: [contextShape.id], zorderKind: 'back', summary: `Send to back` })}>
              <SendToBack className="h-3.5 w-3.5 mr-2" /> Send to back <span className="ml-auto text-[10px] ac-text-4">⌘⇧[</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            {selectedIds.length >= 2 && (
              <ContextMenuItem onClick={() => sendPatch({ op: 'group', shapeIds: selectedIds, summary: `Grouped ${selectedIds.length} shape(s)` })}>
                <GroupIcon className="h-3.5 w-3.5 mr-2" /> Group <span className="ml-auto text-[10px] ac-text-4">⌘G</span>
              </ContextMenuItem>
            )}
            {contextShape.type === 'group' && (
              <ContextMenuItem onClick={() => sendPatch({ op: 'ungroup', shapeIds: [contextShape.id], summary: `Ungrouped ${contextShape.name}` })}>
                <SquareStack className="h-3.5 w-3.5 mr-2" /> Ungroup <span className="ml-auto text-[10px] ac-text-4">⌘⇧G</span>
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => sendPatch({ op: 'update', shapeId: contextShape.id, shape: { locked: !contextShape.locked }, summary: `${contextShape.locked ? 'Unlocked' : 'Locked'} ${contextShape.name}` })}>
              <Lock className="h-3.5 w-3.5 mr-2" /> {contextShape.locked ? 'Unlock' : 'Lock'}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => sendPatch({ op: 'update', shapeId: contextShape.id, shape: { visible: !contextShape.visible }, summary: `${contextShape.visible ? 'Hid' : 'Showed'} ${contextShape.name}` })}>
              <Eye className="h-3.5 w-3.5 mr-2" /> {contextShape.visible ? 'Hide' : 'Show'}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => {
                sendPatch({ op: 'remove', shapeIds: [contextShape.id], summary: `Deleted ${contextShape.name}` });
                if (selectedIds.includes(contextShape.id)) select(selectedIds.filter((id) => id !== contextShape.id));
              }}
              className="text-rose-600"
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete <span className="ml-auto text-[10px] ac-text-4">⌫</span>
            </ContextMenuItem>
          </>
        ) : (
          <>
            {/* === Empty canvas right-click (P0-01) === */}
            <ContextMenuItem onClick={() => clipboard.paste()}>
              <ClipboardPaste className="h-3.5 w-3.5 mr-2" /> Paste <span className="ml-auto text-[10px] ac-text-4">⌘V</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => clipboard.paste({ offset: { dx: 0, dy: 0 } })}>
              <ClipboardPaste className="h-3.5 w-3.5 mr-2" /> Paste in place <span className="ml-auto text-[10px] ac-text-4">⌘⇧V</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => clipboard.selectAll()}>
              <SquareStack className="h-3.5 w-3.5 mr-2" /> Select all <span className="ml-auto text-[10px] ac-text-4">⌘A</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => select([])}>
              <SquareStack className="h-3.5 w-3.5 mr-2" /> Clear selection <span className="ml-auto text-[10px] ac-text-4">⎋</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => setViewport((v) => ({ ...v, zoom: Math.min(4, v.zoom * 1.2) }))}>
              <ArrowUp className="h-3.5 w-3.5 mr-2" /> Zoom in
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setViewport((v) => ({ ...v, zoom: Math.max(0.1, v.zoom * 0.8) }))}>
              <ArrowDown className="h-3.5 w-3.5 mr-2" /> Zoom out
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setViewport({ zoom: 1, panX: 120, panY: 80 })}>
              <BringToFront className="h-3.5 w-3.5 mr-2" /> Reset zoom
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
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
