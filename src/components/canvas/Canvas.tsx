'use client';

// Infinite canvas shell for AgentCanvas.
//
// The shell owns viewport state, gestures, selection/drag/resize interaction,
// context menus, zoom UI, the empty state, and the backdrop grid. The actual
// paint tree is delegated to a renderer module chosen by the `renderer`
// setting (Settings → Appearance): `svg/SvgCanvas` (classic) or `dom/DomCanvas`
// (DOM parity mode — spec docs/html-dom-renderer.md). Supports:
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
import { useCanvasGestures, clampZoom } from '@/lib/canvas/use-canvas-gestures';
import { useSettings } from '@/lib/settings/store';
import { SvgCanvas } from './svg/SvgCanvas';
import { DomCanvas } from './dom/DomCanvas';
import { MIN_SIZE, type ResizeHandle } from './svg/ShapeRenderer';

interface DragState {
  kind: 'pan' | 'move' | 'resize';
  startX: number;
  startY: number;
  /// Original positions of the shapes being moved (canvas-space).
  originals?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  /// Resize handle being dragged.
  handle?: ResizeHandle;
  /// Original pan when starting a pan drag.
  panX?: number;
  panY?: number;
  /// P2-31: Track whether Alt was held at drag-start. On mouse-up with
  /// altWasDown, the move handler emits a duplicate patch (creating a copy
  /// at the dragged-to position) and reverts the original to its starting
  /// position — the Figma "Alt-drag = duplicate" pattern.
  altWasDown?: boolean;
}

export function Canvas() {
  const document = useCanvasStore((s) => s.document);
  const selectedIds = useSelectedIds();
  const agentHighlightIds = useCanvasStore((s) => s.agentHighlightIds);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const select = useCanvasStore((s) => s.select);
  const toolMode = useCanvasStore((s) => s.toolMode);
  const clipboard = useClipboard();
  // Renderer feature flag (spec Phase 1): 'svg' classic renderer (default) or
  // 'dom' DOM parity-mode renderer. Absent field (pre-flag settings blob)
  // resolves to 'svg'.
  const renderer = useSettings((s) => s.renderer) ?? 'svg';
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

  // ---- Wheel + touch gesture handling ---------------------------------------
  // The gesture hook handles: trackpad pinch-zoom, trackpad two-finger pan,
  // touch pinch-zoom, touch two-finger pan, touch double-tap-to-zoom, and
  // touch momentum/inertia. It registers native event listeners on the
  // container with passive=false so we can preventDefault.
  // Mouse-wheel zoom is also handled here (the hook distinguishes it from
  // trackpad scroll by deltaMode + magnitude).
  useCanvasGestures({
    containerRef,
    viewport,
    setViewport,
    spaceDown,
    panMode: toolMode === 'pan',
    // Single-pointer touch/mouse drags are handled by the React onMouseDown/
    // onMouseMove/onMouseUp props below (they need access to the event target
    // for shape hit-testing + stopPropagation). The gesture hook's
    // onSinglePointer* callbacks are not used here — the hook only handles
    // wheel, pinch, and touch gestures.
  });

  // ---- Mouse interactions (shape drag + pan) --------------------------------
  // These handle single-pointer mouse drags. Touch drags with one finger also
  // route through here because React maps touch → mouse events synthetically
  // (and the gesture hook doesn't interfere with single-pointer events).
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
      // P2-31: If Alt was held at drag-start, emit a duplicate patch (which
      // creates a copy at the current position + 24 offset) and revert the
      // original shapes to their starting positions. The duplicate ends up
      // at (currentPos + 24); the original snaps back to its start.
      if (dragState.altWasDown && dragState.originals.length > 0) {
        const ids = dragState.originals.map((o) => o.id);
        // Emit the duplicate first (creates copies at current position + 24).
        sendPatch({ op: 'duplicate', shapeIds: ids, summary: `Duplicated ${ids.length} shape(s) via Alt+drag` });
        // Then revert the originals to their starting positions.
        const updates = dragState.originals.map((o) => {
          const s = findShape(document, o.id);
          // Subtract parent absolute position if nested (same fix as drag handler).
          let relX = o.x;
          let relY = o.y;
          if (s?.parentId) {
            const parent = findShape(document, s.parentId);
            if (parent) { relX -= parent.x; relY -= parent.y; }
          }
          return { id: o.id, changes: { x: relX, y: relY } };
        });
        sendPatch({ op: 'update_many', updates, summary: `Reverted ${updates.length} original(s) to start position (Alt+drag)` });
      }
    }
    setDragState(null);
  }, [dragState, sendPatch, document]);

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
        // P2-31: Track Alt at drag-start for the duplicate-on-drag pattern.
        altWasDown: e.altKey,
      });
    },
    [spaceDown, toolMode, selectedIds, document, select],
  );

  const onResizeHandleMouseDown = useCallback(
    (e: React.MouseEvent, shape: Shape, handle: ResizeHandle) => {
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
          style={{ background: document.background, touchAction: 'none' }}
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
            <button
              onClick={() => {
                // Open the command palette so the user can pick a preset prompt.
                const open = (window as any).__openCommandPalette as (() => void) | undefined;
                if (open) open();
              }}
              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium text-white ac-transition shadow-sm hover:opacity-90"
              style={{ backgroundColor: 'var(--ac-accent)' }}
            >
              <PenLine className="h-3.5 w-3.5" />
              Try a preset prompt
              <kbd className="text-[9px] px-1 py-0 rounded bg-white/20 font-mono ml-1">⌘K</kbd>
            </button>
            <div className="flex items-center gap-1.5 mt-1 text-[10px] ac-text-4">
              <MousePointerClick className="h-3 w-3" />
              <span>Tip: try “Design a login form” in the chat</span>
            </div>
          </div>
        </div>
      )}

      {renderer === 'dom' ? (
        <DomCanvas
          document={document}
          selectedIds={selectedIds}
          highlightIds={agentHighlightIds}
          viewport={viewport}
          onShapeMouseDown={onShapeMouseDown}
          onResizeHandleMouseDown={onResizeHandleMouseDown}
        />
      ) : (
        <SvgCanvas
          document={document}
          size={size}
          zoom={zoom}
          panX={panX}
          panY={panY}
          selectedIds={selectedSet}
          highlightIds={highlightSet}
          onShapeMouseDown={onShapeMouseDown}
          onResizeHandleMouseDown={onResizeHandleMouseDown}
        />
      )}

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
          onClick={() => setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom * 0.9) }))}
        >
          −
        </button>
        <span className="tabular-nums w-12 text-center ac-text-2" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button
          className="px-1 ac-text-3 hover:ac-text-1 ac-transition ac-focus-ring rounded"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom * 1.1) }))}
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
              className="ac-text-danger"
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
            <ContextMenuItem onClick={() => setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom * 1.2) }))}>
              <ArrowUp className="h-3.5 w-3.5 mr-2" /> Zoom in
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom * 0.8) }))}>
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
