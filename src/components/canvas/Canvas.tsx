'use client';

// Infinite canvas shell for AgentCanvas.
//
// The shell owns viewport state, gestures, selection/drag/resize interaction,
// context menus, zoom UI, the empty state, and the backdrop grid. The actual
// paint tree is delegated to the DOM renderer module (`dom/DomCanvas` —
// spec docs/html-dom-renderer.md). Supports:
//   - pan (middle-mouse drag or space-drag)
//   - zoom (wheel)
//   - click to select
//   - drag to move selected shapes
//   - resize handles on the active selection
//   - agent-highlight glow (briefly shown when the agent uses canvas_select_shape)
//   - P0-01/02: right-click context menu (empty canvas + shape variants)
//   - Phase 7 (spec §6 / Appendix H): marquee selection (⌘-drag = nested),
//     ⌘+click deep select, Enter/⇧Enter/Tab/⇧Tab hierarchy navigation,
//     ⇧1/⇧2/⇧0 zoom chords, outline mode (⌘⇧O), pixel grid (⌘') and
//     snap-to-pixel (⌘⇧') view options, and the K scale tool. All chords are
//     matched against the single shortcut registry (lib/canvas/shortcuts.ts)
//     so the keymap and the help dialog can never drift.
//
// Local edits emit CanvasPatches via the store so other viewers (and the
// agent) see them. Agent-originated patches arrive via the same store and
// are rendered identically — there is no visual distinction between human
// and agent edits at the canvas level, by design.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvasStore, findShape } from '@/lib/canvas/store';
import { useClipboard } from '@/hooks/use-clipboard';
import type { CanvasPatch, Shape, Viewport } from '@/lib/canvas/types';
import { SHORTCUTS_BY_ACTION, matchShortcut } from '@/lib/canvas/shortcuts';
import { fitViewport, DEFAULT_VIEWPORT } from '@/lib/canvas/viewport';
import { scaleGeometry } from '@/lib/canvas/scale';
import {
  COMPONENT_DRAG_MIME,
  readComponentIdFromDrop,
  buildComponentDropPatch,
} from '@/lib/canvas/assets-drag';
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
import { DomCanvas } from './dom/DomCanvas';
import { Rulers } from './Rulers';
import { Guides } from './dom/Guides';
import { newGuideId } from '@/lib/canvas/store';
import { MIN_SIZE, type ResizeHandle } from './handleMath';
import { PackTokensStyle } from './PackTokensStyle';

interface DragState {
  kind: 'pan' | 'move' | 'resize' | 'marquee';
  startX: number;
  startY: number;
  /// Original positions of the shapes being moved (canvas-space).
  originals?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  /// Resize handle being dragged.
  handle?: ResizeHandle;
  /// Original pan when starting a pan drag.
  panX?: number;
  panY?: number;
  /// Marquee (Phase 7): current pointer position, container-relative screen
  /// coords. Updated on mousemove; consumed on mouseup.
  curX?: number;
  curY?: number;
  /// ⌘-drag nested marquee (Phase 7): also selects descendants of
  /// intersecting groups/frames (Figma's nested-marquee semantics).
  nested?: boolean;
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
  // Phase 7 view flags (ephemeral store slice — see store.ts).
  const pixelGridVisible = useCanvasStore((s) => s.pixelGridVisible);
  const snapToPixel = useCanvasStore((s) => s.snapToPixel);
  const outlineMode = useCanvasStore((s) => s.outlineMode);
  const rulersVisible = useCanvasStore((s) => s.rulersVisible);
  const toggleViewFlag = useCanvasStore((s) => s.toggleViewFlag);
  // Phase 7 §H.1 / §H.2 guide lines — drag-out guides from rulers +
  // right-click delete. Mounted in the screen-space overlay (above the
  // world, below the selection chrome) so they don't get panned/zoomed.
  // Gated on `rulersVisible` (Figma behavior — guides only show when
  // rulers are visible).
  const guideLines = useCanvasStore((s) => s.guideLines);
  const addGuideAction = useCanvasStore((s) => s.addGuide);
  const removeGuideAction = useCanvasStore((s) => s.removeGuide);
  // Phase 7 §H.2 measure overlay (Alt/Option hover): measureMode is set
  // transiently by the keydown/keyup handler below — never user-toggled.
  // The DOM renderer reads it to know when to paint the redline overlay.
  const measureMode = useCanvasStore((s) => s.measureMode);
  const setMeasureMode = useCanvasStore((s) => s.setMeasureMode);
  const clipboard = useClipboard();
  // DOM renderer layout strategy (spec Phase 2 dual layout mode): 'parity'
  // (default — resolver absolute geometry) or 'native' (browser CSS flexbox
  // for auto-layout containers).
  const layoutMode = useSettings((s) => s.canvasLayoutMode) ?? 'parity';
  // Phase 4 L4 culling (spec §4.2): settings.domCulling defaults to true.
  // The L5 CullingCoordinator (≥2k nodes per page) is wired separately inside
  // DomCanvas and reads the same setting via this same flag through the
  // `l4Culling` prop — they're a single Phase 4 surface for the user.
  const domCulling = useSettings((s) => s.domCulling) ?? true;
  const l4Culling = domCulling;
  // P0-01/02: Track the last right-click position + the shape under the cursor
  // at right-click time. The context-menu items use these to choose between
  // the empty-canvas and shape variants.
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [contextShape, setContextShape] = useState<Shape | null>(null);

  // Phase 7 §H.1 — Assets panel drop target. When the user drags a reusable
  // component card from the LayersPanel's Assets tab over the canvas, we
  // show a dashed accent border around the world (the drop affordance);
  // on drop we read the component id from the drag payload and emit a
  // `place_instance` patch (the documented Figma behavior path) that
  // places a linked instance at the cursor's canvas-space coordinates.
  const [isDropTarget, setIsDropTarget] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ zoom: 1, panX: 120, panY: 80 });
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  // Phase 7 §H.2 measure overlay: pointer position in canvas space, tracked
  // while Alt/Option is held + the pointer is over the canvas + no drag is
  // active. Cleared when Alt releases (the keyup effect resets measureMode
  // → this effect's [measureMode] cleanup clears the pointer too). A ref
  // mirrors the state so the mousemove handler can dedupe setState calls
  // (the pointer moves many times per frame — only setState when the
  // canvas-space coords have moved more than ~0.5px to avoid render spam).
  const [pointerCanvas, setPointerCanvas] = useState<{ x: number; y: number } | null>(null);
  const pointerCanvasRef = useRef<{ x: number; y: number } | null>(null);

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

  // ---- Phase 7: zoom + hierarchy-navigation helpers ---------------------------

  // Apply a zoom action (⇧1 fit / ⇧2 selection / ⇧0 100% / ⇧+ / ⇧−, plus the
  // TopMenuBar View items which fire the 'ac:canvas-zoom' CustomEvent — the
  // viewport state is shell-local, so the menu routes through the shell).
  const applyZoom = useCallback(
    (kind: 'fit' | 'selection' | '100' | 'in' | 'out') => {
      if (kind === 'fit') {
        setViewport(fitViewport(document.shapes ?? [], size));
      } else if (kind === 'selection') {
        const selected = (document.shapes ?? []).filter((s) => selectedIds.includes(s.id));
        if (selected.length > 0) setViewport(fitViewport(selected, size));
      } else if (kind === '100') {
        setViewport({ ...DEFAULT_VIEWPORT });
      } else {
        setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom * (kind === 'in' ? 1.2 : 1 / 1.2)) }));
      }
    },
    [document.shapes, size, selectedIds],
  );

  useEffect(() => {
    const onZoomRequest = (ev: Event) => {
      const kind = (ev as CustomEvent).detail?.kind as 'fit' | 'selection' | '100' | 'in' | 'out' | undefined;
      if (kind) applyZoom(kind);
    };
    window.addEventListener('ac:canvas-zoom', onZoomRequest);
    return () => window.removeEventListener('ac:canvas-zoom', onZoomRequest);
  }, [applyZoom]);

  // Enter/⇧Enter/Tab/⇧Tab hierarchy navigation (spec Phase 7): Enter selects
  // the topmost child of the selected container; ⇧Enter selects the parent;
  // Tab/⇧Tab cycle siblings within the same parent (zIndex order, wrapping).
  const navigateHierarchy = useCallback(
    (dir: 'child' | 'parent' | 'next' | 'prev') => {
      if (selectedIds.length !== 1) return;
      const current = findShape(document, selectedIds[0]);
      if (!current) return;
      const shapes = document.shapes ?? [];
      if (dir === 'child') {
        const children = shapes
          .filter((s) => (s.parentId ?? null) === current.id)
          .sort((a, b) => a.zIndex - b.zIndex);
        if (children.length > 0) select([children[children.length - 1].id]); // topmost
      } else if (dir === 'parent') {
        if (current.parentId) select([current.parentId]);
      } else {
        const pid = current.parentId ?? null;
        const siblings = shapes
          .filter((s) => (s.parentId ?? null) === pid)
          .sort((a, b) => a.zIndex - b.zIndex);
        if (siblings.length < 2) return;
        const idx = siblings.findIndex((s) => s.id === current.id);
        if (idx < 0) return;
        const nextIdx = dir === 'next' ? (idx + 1) % siblings.length : (idx - 1 + siblings.length) % siblings.length;
        select([siblings[nextIdx].id]);
      }
    },
    [selectedIds, document, select],
  );

  // Keyboard: space to pan, delete to remove selection, escape to clear,
  // plus the Phase 7 canvas-scope registry chords (zoom / view options /
  // hierarchy navigation). App-scope chords live in page.tsx.
  // Also: Phase 7 §H.2 — track Alt/Option hold to drive the measure
  // overlay (setMeasureMode on every keydown + keyup, gated by the same
  // input-focus guard as the rest of the keymap). The cleanup resets
  // measureMode to false on unmount so the overlay can't get stuck on if
  // the component unmounts while Alt is held.
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      // Phase 7 §H.2 — track Alt-hold on every keydown (Alt's own keydown
      // fires repeatedly while held; setState is idempotent). Skip while
      // typing in an input/textarea (reuse the file's editable-target
      // guard). Do NOT preventDefault — Alt has native browser behaviors
      // (option-key character entry on macOS, menu-focus on Windows) we
      // don't want to block.
      if (!isEditableTarget(e.target)) {
        setMeasureMode(e.altKey);
      }
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
      } else {
        if (isEditableTarget(e.target)) return;
        // ---- Registry-driven canvas chords (spec Phase 7 / Appendix H) ----
        const match = (action: string) => {
          const def = SHORTCUTS_BY_ACTION.get(action);
          return def ? matchShortcut(e, def) : false;
        };
        if (match('zoom.fit')) { e.preventDefault(); applyZoom('fit'); return; }
        if (match('zoom.selection')) { e.preventDefault(); applyZoom('selection'); return; }
        if (match('zoom.100')) { e.preventDefault(); applyZoom('100'); return; }
        if (match('zoom.in')) { e.preventDefault(); applyZoom('in'); return; }
        if (match('zoom.out')) { e.preventDefault(); applyZoom('out'); return; }
        if (match('outline-mode')) { e.preventDefault(); toggleViewFlag('outlineMode'); return; }
        if (match('pixel-grid')) { e.preventDefault(); toggleViewFlag('pixelGridVisible'); return; }
        if (match('snap-to-pixel')) { e.preventDefault(); toggleViewFlag('snapToPixel'); return; }
        if (match('nav.child')) { e.preventDefault(); navigateHierarchy('child'); return; }
        if (match('nav.parent')) { e.preventDefault(); navigateHierarchy('parent'); return; }
        if (match('nav.sibling-next')) { e.preventDefault(); navigateHierarchy('next'); return; }
        if (match('nav.sibling-prev')) { e.preventDefault(); navigateHierarchy('prev'); return; }
      }
    };
    const onUp = (e: KeyboardEvent) => {
      // §H.2 — Alt release clears measureMode. Same editable-target guard
      // so keyup inside an input doesn't toggle the overlay off (we never
      // toggled it on in that case).
      if (!isEditableTarget(e.target)) {
        setMeasureMode(e.altKey);
      }
      if (e.code === 'Space') setSpaceDown(false);
    };
    // Window blur — if the user Alt-Tabs away while Alt is held, the keyup
    // never fires; reset measureMode so the overlay doesn't get stuck on.
    const onBlur = () => setMeasureMode(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
      // Reset on unmount — the store slice outlives this component.
      setMeasureMode(false);
    };
  }, [selectedIds, sendPatch, select, applyZoom, navigateHierarchy, toggleViewFlag, setMeasureMode]);

  // Phase 7 §H.2 — clear the tracked pointer when Alt releases (so the
  // overlay disappears the instant the key does, regardless of when the
  // next mousemove fires). Also clears when entering a drag (the overlay
  // would be visually noisy + incorrect during drag — Figma hides it).
  /* eslint-disable react-hooks/set-state-in-effect -- Alt-hold is a
     window-scope keyboard gesture; the only way to observe its release
     is via the store flag it writes. The setState call only fires when
     the flag transitions from on → off (rare — once per Alt-hold), so
     cascading renders are bounded to one per release. */
  useEffect(() => {
    if (!measureMode && pointerCanvasRef.current !== null) {
      pointerCanvasRef.current = null;
      setPointerCanvas(null);
    }
  }, [measureMode]);
  /* eslint-enable react-hooks/set-state-in-effect */

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

      // Click on empty canvas → clear selection. In select mode this ALSO
      // starts a marquee (rubber-band) drag (spec Phase 7): dragging selects
      // every layer whose bbox intersects the swept rect. ⌘/Ctrl at drag-start
      // = nested marquee — descendants of intersecting containers are
      // selected too. (SVG-group click handling is unchanged — shape handlers
      // stopPropagation so this branch only sees non-shape targets.)
      if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.emptyBg === 'true') {
        select([]);
        if (toolMode === 'select') {
          setDragState({
            kind: 'marquee',
            startX: sx,
            startY: sy,
            curX: sx,
            curY: sy,
            nested: e.metaKey || e.ctrlKey,
          });
        }
      }
    },
    [spaceDown, toolMode, viewport, select],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragState) {
        // Phase 7 §H.2 idle-hover path — track the pointer in canvas
        // space so the measure overlay can compute distance redlines to
        // nearby siblings + the containing frame's edges. Only runs when
        // Alt is held; on every other idle mousemove we bail immediately
        // (the existing behavior). The ref mirrors the state so we can
        // dedupe setState calls (the pointer moves many times per frame;
        // only setState when the canvas-space coords have moved > ~0.5px
        // to avoid render-spamming the overlay on every mousemove event).
        if (!measureMode) return;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const cx = (sx - viewport.panX) / viewport.zoom;
        const cy = (sy - viewport.panY) / viewport.zoom;
        const prev = pointerCanvasRef.current;
        if (!prev || Math.abs(prev.x - cx) > 0.5 || Math.abs(prev.y - cy) > 0.5) {
          pointerCanvasRef.current = { x: cx, y: cy };
          setPointerCanvas({ x: cx, y: cy });
        }
        return;
      }
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

      // Marquee: track the current pointer (screen space) for rendering; the
      // actual selection happens on mouse-up.
      if (dragState.kind === 'marquee') {
        setDragState({ ...dragState, curX: sx, curY: sy });
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
          // Snap-to-pixel (⌘⇧', spec Phase 7): round drag results to integer
          // canvas coordinates before the patch is emitted.
          if (snapToPixel) {
            newX = Math.round(newX);
            newY = Math.round(newY);
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
        const h = dragState.handle;
        // Figma-hierarchy: like the move handler, if the resized shape is
        // nested, convert the new absolute x/y to relative coords by
        // subtracting the parent's absolute position. Width/height stay the
        // same — they're not parent-relative.
        const current = findShape(document, orig.id);
        const toRelative = (absX: number, absY: number) => {
          let relX = absX;
          let relY = absY;
          if (current?.parentId) {
            const parent = findShape(document, current.parentId);
            if (parent) {
              relX -= parent.x;
              relY -= parent.y;
            }
          }
          return { relX, relY };
        };

        if (toolMode === 'scale') {
          // K scale tool (spec Phase 7): proportional resize — width/height/
          // fontSize/strokeWidth all multiply by one factor anchored at the
          // opposite corner (Figma rescale() semantics).
          const scaled = scaleGeometry(
            {
              ...orig,
              fontSize: current?.fontSize,
              strokeWidth: current?.strokeWidth,
            },
            h,
            dxCanvas,
            dyCanvas,
          );
          let { x: sx2, y: sy2, width, height } = scaled;
          if (snapToPixel) {
            sx2 = Math.round(sx2);
            sy2 = Math.round(sy2);
            width = Math.round(width);
            height = Math.round(height);
          }
          const { relX, relY } = toRelative(sx2, sy2);
          const shape: Record<string, unknown> = { x: relX, y: relY, width, height };
          if (scaled.fontSize !== undefined) shape.fontSize = scaled.fontSize;
          if (scaled.strokeWidth !== undefined) shape.strokeWidth = scaled.strokeWidth;
          sendPatch({ op: 'update', shapeId: orig.id, shape: shape as Partial<Shape>, summary: '' });
          return;
        }

        let { x, y, width, height } = orig;
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
        // Snap-to-pixel (⌘⇧', spec Phase 7): round resize results to integer
        // canvas coordinates before the patch is emitted.
        if (snapToPixel) {
          x = Math.round(x);
          y = Math.round(y);
          width = Math.round(width);
          height = Math.round(height);
        }
        const { relX, relY } = toRelative(x, y);
        const patch: CanvasPatch = {
          op: 'update',
          shapeId: orig.id,
          shape: { x: relX, y: relY, width, height },
          summary: '',
        };
        sendPatch(patch);
      }
    },
    [dragState, viewport, measureMode, sendPatch, document, toolMode, snapToPixel],
  );

  const onMouseUp = useCallback(() => {
    // Marquee (spec Phase 7): select every layer whose bbox intersects the
    // swept rect (partially-intersecting included). The rect corners are
    // container-relative screen coords; convert to canvas space by inverting
    // the pan/zoom transform. Nested marquee (⌘-drag) additionally selects
    // all descendants of intersecting containers.
    if (dragState?.kind === 'marquee') {
      const x0 = dragState.startX;
      const y0 = dragState.startY;
      const x1 = dragState.curX ?? dragState.startX;
      const y1 = dragState.curY ?? dragState.startY;
      const isDrag = Math.abs(x1 - x0) > 2 || Math.abs(y1 - y0) > 2;
      if (isDrag) {
        const cx0 = (Math.min(x0, x1) - viewport.panX) / viewport.zoom;
        const cy0 = (Math.min(y0, y1) - viewport.panY) / viewport.zoom;
        const cx1 = (Math.max(x0, x1) - viewport.panX) / viewport.zoom;
        const cy1 = (Math.max(y0, y1) - viewport.panY) / viewport.zoom;
        const shapes = document.shapes ?? [];
        const hitIds = new Set(
          shapes
            .filter((s) => s.visible !== false)
            .filter((s) => !(s.x > cx1 || s.x + s.width < cx0 || s.y > cy1 || s.y + s.height < cy0))
            .map((s) => s.id),
        );
        if (dragState.nested) {
          // Recurse: any shape with an intersecting ANCESTOR joins the
          // selection (Figma's nested marquee grabs whole subtrees).
          for (const s of shapes) {
            if (hitIds.has(s.id)) continue;
            let p = s.parentId;
            while (p) {
              if (hitIds.has(p)) {
                hitIds.add(s.id);
                break;
              }
              const parent = shapes.find((x) => x.id === p);
              p = parent?.parentId ?? null;
            }
          }
        }
        if (hitIds.size > 0) select([...hitIds]);
      }
      setDragState(null);
      return;
    }
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
  }, [dragState, sendPatch, document, viewport, select]);

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

      // Deep select (spec Phase 7 / Appendix H): ⌘/Ctrl+click cycles the
      // selection through the ancestor chain instead of re-selecting the top
      // hit. Robust v1 semantics:
      //   1st ⌘+click  → selects the event-target node itself (the DEEPEST
      //                  node's handler fires first and stopPropagation()s, so
      //                  this is the node under the cursor).
      //   2nd ⌘+click  → the clicked node is already selected → select its
      //                  PARENT (parentId chain up, one hop per click).
      // No move drag starts on deep-select (Figma: ⌘+click only re-targets).
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        if (selectedIds.includes(shape.id)) {
          const parent = shape.parentId ? findShape(document, shape.parentId) : undefined;
          select(parent ? [parent.id] : [shape.id]);
        } else {
          select([shape.id]);
        }
        return;
      }

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

  // Phase 7 §H.1 — Assets panel drop handler. HTML5 DnD fires onDragOver
  // continuously while a drag is in progress; we must call `preventDefault()`
  // on it (otherwise the browser blocks the drop). We also gate on the
  // drag carrying our COMPONENT_DRAG_MIME so we don't paint the affordance
  // for unrelated drags (file drags from the OS, layer-row reparent drags
  // from the LayersPanel tree, etc.). On drop, we read the component id,
  // compute canvas-space coords, and emit a `place_instance` patch — the
  // same op the agent uses (pen_place_instance tool), so the placed
  // instance is a fully linked PenRef, not a frozen copy.
  const onCanvasDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(COMPONENT_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!isDropTarget) setIsDropTarget(true);
    },
    [isDropTarget],
  );

  const onCanvasDragLeave = useCallback(
    (e: React.DragEvent) => {
      // Only clear when leaving the container itself (relatedTarget is
      // null/outside) — dragleave fires for every child boundary crossing
      // during a drag, which would flicker the affordance.
      if (e.currentTarget === e.target || e.relatedTarget === null) {
        setIsDropTarget(false);
      }
    },
    [],
  );

  const onCanvasDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(COMPONENT_DRAG_MIME)) return;
      e.preventDefault();
      setIsDropTarget(false);
      const componentId = readComponentIdFromDrop(e.dataTransfer);
      if (!componentId) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const vp: Viewport = viewport;
      const patch = buildComponentDropPatch(componentId, e.clientX, e.clientY, rect, vp);
      if (!patch) return;
      sendPatch(patch);
    },
    [viewport, sendPatch],
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
          onDragOver={onCanvasDragOver}
          onDragLeave={onCanvasDragLeave}
          onDrop={onCanvasDrop}
        >
      {/* Design-system pack tokens — when the user has pinned a pack via
          the DesignSystemPicker, this injects the pack's tokens.css as a
          `<style>` tag scoped to the canvas subtree. The agent's
          `var(--color-accent)`, `var(--color-text-primary)`, `var(--radius-card)`
          etc. references then resolve to the pack's actual values at render
          time. Renders nothing when no pack is chosen. */}
      <PackTokensStyle />
      {/* Phase 7 §H.1 — Assets panel drop affordance: dashed accent border
          around the canvas while a component card is being dragged over it.
          Rendered as a sibling of the backdrop grid (pointer-events:none so
          it never intercepts the drop). data-ac-drop-target is the selector
          the tests look for. */}
      {isDropTarget && (
        <div
          data-ac-drop-target=""
          className="absolute inset-0 pointer-events-none"
          style={{
            boxShadow: 'inset 0 0 0 2px var(--ac-accent)',
            backgroundColor: 'color-mix(in oklch, var(--ac-accent) 6%, transparent)',
          }}
        />
      )}
      {/* Infinite-canvas backdrop grid (⌘' pixel-grid toggle, spec Phase 7) */}
      <div
        data-empty-bg="true"
        className="absolute inset-0"
        style={{
          visibility: pixelGridVisible ? 'visible' : 'hidden',
          backgroundImage:
            'radial-gradient(circle, color-mix(in oklch, var(--ac-text-primary) 12%, transparent) 1px, transparent 1px)',
          backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          backgroundPosition: `${panX}px ${panY}px`,
        }}
      />

      {/* Marquee selection rect (spec Phase 7) — screen-space, accent border
          + translucent fill from the selection tokens. data-ac-marquee is the
          test/automation selector. */}
      {dragState?.kind === 'marquee' && (() => {
        const x = Math.min(dragState.startX, dragState.curX ?? dragState.startX);
        const y = Math.min(dragState.startY, dragState.curY ?? dragState.startY);
        const w = Math.abs((dragState.curX ?? dragState.startX) - dragState.startX);
        const h = Math.abs((dragState.curY ?? dragState.startY) - dragState.startY);
        if (w < 2 && h < 2) return null;
        return (
          <div
            data-ac-marquee=""
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: w,
              height: h,
              border: `1px solid var(--ac-canvas-selection)`,
              backgroundColor: 'color-mix(in oklch, var(--ac-canvas-selection) 12%, transparent)',
              pointerEvents: 'none',
              zIndex: 5,
            }}
          />
        );
      })()}

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
            <div className="space-y-1.5">
              <div className="text-[18px] font-semibold ac-text-1 tracking-tight">Empty canvas</div>
              <div className="text-[12px] ac-text-2 leading-relaxed">
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

      <DomCanvas
        document={document}
        selectedIds={selectedIds}
        highlightIds={agentHighlightIds}
        viewport={viewport}
        layoutMode={layoutMode}
        outlineMode={outlineMode}
        l4Culling={l4Culling}
        // Phase 7 §H.2 measure overlay — pointer in canvas space +
        // measureMode flag threaded through to DomChrome where the
        // MeasureOverlay component is mounted.
        pointerCanvas={pointerCanvas}
        measureMode={measureMode}
        onShapeMouseDown={onShapeMouseDown}
        onResizeHandleMouseDown={onResizeHandleMouseDown}
      />

      {/* Phase 7 §H.2 rulers — top + left pixel rulers showing canvas-space
          coordinates with adaptive tick marks. Toggled via the View menu.
          The world div is rendered ABOVE this z-index (rulers don't
          intercept pointer events — pointer-events:none). */}
      {rulersVisible && (
        <Rulers
          document={document}
          panX={panX}
          panY={panY}
          zoom={zoom}
          width={size.w}
          height={size.h}
          onAddGuide={(axis, position) =>
            addGuideAction({
              id: newGuideId(),
              axis,
              position,
              color: '#f24822',
            })
          }
        />
      )}

      {/* Phase 7 §H.1 / §H.2 guide lines — drag-out guides from rulers,
          rendered in the screen-space overlay above the world (so they
          don't get panned/zoomed). Right-click a guide to delete. */}
      {rulersVisible && (
        <Guides
          guideLines={guideLines}
          panX={panX}
          panY={panY}
          zoom={zoom}
          width={size.w}
          height={size.h}
          onRemoveGuide={(id) => removeGuideAction(id)}
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
