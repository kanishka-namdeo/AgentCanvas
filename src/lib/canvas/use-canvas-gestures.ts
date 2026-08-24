// Touch + trackpad gesture handling for the canvas.
//
// This hook unifies mouse, trackpad, and touch input into a single gesture
// recognition layer. It implements the interaction patterns used by Figma,
// Excalidraw, tldraw, and Miro:
//
//   ┌─────────────────────┬──────────────────────────────────────────────┐
//   │ Input               │ Gesture                                      │
//   ├─────────────────────┼──────────────────────────────────────────────┤
//   │ Mouse wheel         │ Zoom (cursor-anchored)                       │
//   │ Trackpad 2-finger   │ PAN (deltaX + deltaY)                        │
//   │ Trackpad pinch      │ Zoom (ctrlKey=true, cursor-anchored)         │
//   │ Trackpad pinch+pan  │ Zoom + pan simultaneously (ctrlKey=true)     │
//   │ Middle mouse drag   │ Pan                                          │
//   │ Space+drag          │ Pan                                          │
//   │ Touch 1 finger      │ Select / drag shape                          │
//   │ Touch 2 finger      │ Pinch-zoom + pan simultaneously               │
//   │ Touch double-tap    │ Zoom in 2x at tap point                      │
//   └─────────────────────┴──────────────────────────────────────────────┘
//
// Key implementation details:
//   - The wheel handler distinguishes pinch (ctrlKey) from scroll (no ctrlKey).
//     Trackpads fire ctrlKey=true on pinch; mice never do.
//   - Touch handling uses Pointer Events (pointerdown/move/up) with a multi-
//     pointer map. When 2 pointers are active, we compute the distance between
//     them for pinch-zoom and their midpoint movement for pan.
//   - `touch-action: none` is set on the container so the browser doesn't
//     intercept touch gestures (no scrolling, no double-tap-zoom).
//   - Zoom is always cursor/midpoint-anchored: the canvas point under the
//     cursor stays fixed during zoom.
//   - Momentum/inertia: trackpad wheel events already have OS-level inertia.
//     For touch pan, we implement simple velocity-based momentum on pointerup.

'use client';

import { useEffect, useRef, useCallback, type RefObject } from 'react';

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

export interface ViewportSetter {
  /// Accepts either a new viewport object OR an updater function (mirrors React's setState).
  (valueOrUpdater: Viewport | ((vp: Viewport) => Viewport)): void;
}

interface PointerInfo {
  id: number;
  x: number;
  y: number;
}

interface GestureState {
  pointers: Map<number, PointerInfo>;
  // Pinch state (captured at the moment the second pointer goes down).
  pinchStartDist: number;
  pinchStartZoom: number;
  pinchStartMidX: number;
  pinchStartMidY: number;
  pinchStartPanX: number;
  pinchStartPanY: number;
  // Momentum tracking for touch pan.
  lastPanX: number;
  lastPanY: number;
  lastPanTime: number;
  velocityX: number;
  velocityY: number;
  // Double-tap detection.
  lastTapTime: number;
  lastTapX: number;
  lastTapY: number;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_SENSITIVITY_WHEEL = 0.0015;
const ZOOM_SENSITIVITY_PINCH = 0.015; // per unit of log-distance change
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST_PX = 30;
const MOMENTUM_FRICTION = 0.92;
const MOMENTUM_MIN_VELOCITY = 0.5;

function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

export interface UseCanvasGesturesOptions {
  containerRef: RefObject<HTMLElement | null>;
  viewport: Viewport;
  setViewport: ViewportSetter;
  /// Called when a single-pointer (mouse or touch) tap/drag starts on the canvas
  /// (not on a shape). Returns true if the gesture was handled (e.g. start a pan).
  onSinglePointerDown?: (x: number, y: number, isTouch: boolean) => boolean;
  /// Called on single-pointer move (during a drag).
  onSinglePointerMove?: (x: number, y: number) => void;
  /// Called when a single-pointer drag ends.
  onSinglePointerUp?: (x: number, y: number) => void;
  /// Whether space-bar is held (enables pan with left-click drag).
  spaceDown: boolean;
  /// Whether the pan tool is active.
  panMode: boolean;
}

export function useCanvasGestures(opts: UseCanvasGesturesOptions) {
  const {
    containerRef,
    viewport,
    setViewport,
    onSinglePointerDown,
    onSinglePointerMove,
    onSinglePointerUp,
    spaceDown,
    panMode,
  } = opts;

  // Keep a ref to the latest viewport so the wheel handler (registered once)
  // always sees the current value without re-registering.
  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  // Gesture state (mutable, doesn't trigger re-renders).
  const gestureRef = useRef<GestureState>({
    pointers: new Map(),
    pinchStartDist: 0,
    pinchStartZoom: 1,
    pinchStartMidX: 0,
    pinchStartMidY: 0,
    pinchStartPanX: 0,
    pinchStartPanY: 0,
    lastPanX: 0,
    lastPanY: 0,
    lastPanTime: 0,
    velocityX: 0,
    velocityY: 0,
    lastTapTime: 0,
    lastTapX: 0,
    lastTapY: 0,
  });

  // Track whether a single-pointer drag is in progress (for the onPointer* callbacks).
  const singlePointerDragRef = useRef(false);
  // Momentum animation frame.
  const momentumRef = useRef<number | null>(null);

  // ---- Wheel handler (trackpad + mouse) -------------------------------------
  //
  // Distinguishes:
  //   - ctrlKey + wheel  → pinch-zoom (trackpad pinch gesture)
  //   - wheel only       → pan (trackpad two-finger scroll) OR zoom (mouse wheel)
  //
  // The heuristic: if deltaX or deltaY is non-zero AND ctrlKey is false, it's
  // a trackpad two-finger scroll → PAN. If ctrlKey is true, it's a pinch → ZOOM.
  // For a plain mouse wheel (no ctrlKey, deltaY only, no deltaX), we zoom
  // (matching the original behavior — most users expect mouse wheel = zoom).
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (e.ctrlKey) {
      // Pinch-zoom (trackpad pinch). ctrlKey is true when the user does a
      // two-finger pinch on a trackpad. The deltaY gives the zoom delta.
      // Use the functional updater so rapid successive events accumulate.
      const delta = -e.deltaY * ZOOM_SENSITIVITY_PINCH;
      setViewport((vp) => {
        const newZoom = clampZoom(vp.zoom * (1 + delta));
        const canvasX = (mouseX - vp.panX) / vp.zoom;
        const canvasY = (mouseY - vp.panY) / vp.zoom;
        return {
          zoom: newZoom,
          panX: mouseX - canvasX * newZoom,
          panY: mouseY - canvasY * newZoom,
        };
      });
      return;
    }

    // If there's a deltaX, it's definitely a trackpad two-finger pan (mouse
    // wheels never produce deltaX). If deltaX is 0 and deltaY is non-zero,
    // it could be either a trackpad scroll or a mouse wheel — we check
    // deltaMode to distinguish (mice use lines=1, trackpads use pixels=0).
    if (e.deltaX !== 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 50 && !e.shiftKey)) {
      // Trackpad two-finger pan. Use the functional updater so rapid
      // successive wheel events accumulate correctly (viewportRef.current
      // would be stale during a burst of events).
      setViewport((vp) => ({
        zoom: vp.zoom,
        panX: vp.panX - e.deltaX,
        panY: vp.panY - e.deltaY,
      }));
      return;
    }

    // Mouse wheel zoom (original behavior — no ctrlKey, large deltaY).
    // Also use the functional updater for the same reason.
    const delta = -e.deltaY * ZOOM_SENSITIVITY_WHEEL;
    setViewport((vp) => {
      const newZoom = clampZoom(vp.zoom * (1 + delta));
      const canvasX = (mouseX - vp.panX) / vp.zoom;
      const canvasY = (mouseY - vp.panY) / vp.zoom;
      return {
        zoom: newZoom,
        panX: mouseX - canvasX * newZoom,
        panY: mouseY - canvasY * newZoom,
      };
    });
  }, [containerRef, setViewport]);

  // ---- Pointer handlers (mouse + touch unified) ----------------------------
  const onPointerDown = useCallback((e: PointerEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const gs = gestureRef.current;
    gs.pointers.set(e.pointerId, { id: e.pointerId, x, y });

    // Cancel any in-progress momentum.
    if (momentumRef.current !== null) {
      cancelAnimationFrame(momentumRef.current);
      momentumRef.current = null;
    }

    if (gs.pointers.size === 2) {
      // Two pointers are now down — start pinch-zoom + pan.
      const [p1, p2] = Array.from(gs.pointers.values());
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      gs.pinchStartDist = Math.hypot(dx, dy);
      gs.pinchStartZoom = viewportRef.current.zoom;
      gs.pinchStartMidX = (p1.x + p2.x) / 2;
      gs.pinchStartMidY = (p1.y + p2.y) / 2;
      gs.pinchStartPanX = viewportRef.current.panX;
      gs.pinchStartPanY = viewportRef.current.panY;
      // If a single-pointer drag was in progress, end it.
      singlePointerDragRef.current = false;
      return;
    }

    if (gs.pointers.size === 1) {
      // Single pointer down. This could be a tap, a drag, or the start of a
      // pinch (second pointer hasn't landed yet). We call onPointerDown to
      // let the Canvas start a pan or shape-drag. If the caller handles it,
      // we mark a single-pointer drag in progress.
      const isTouch = e.pointerType === 'touch';
      const handled = onSinglePointerDown?.(x, y, isTouch) ?? false;
      singlePointerDragRef.current = handled;

      // Track for momentum.
      gs.lastPanX = x;
      gs.lastPanY = y;
      gs.lastPanTime = Date.now();
      gs.velocityX = 0;
      gs.velocityY = 0;
    }
  }, [containerRef, onSinglePointerDown]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const gs = gestureRef.current;

    // Update the pointer position.
    if (gs.pointers.has(e.pointerId)) {
      gs.pointers.set(e.pointerId, { id: e.pointerId, x, y });
    } else {
      return; // Pointer not down — ignore hover moves.
    }

    if (gs.pointers.size >= 2) {
      // Pinch-zoom + pan with two pointers.
      const [p1, p2] = Array.from(gs.pointers.values());
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.hypot(dx, dy);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;

      if (gs.pinchStartDist > 0) {
        const scale = dist / gs.pinchStartDist;
        const newZoom = clampZoom(gs.pinchStartZoom * scale);
        // The canvas point that was under the pinch midpoint at the start
        // should stay under the current midpoint.
        const canvasX = (gs.pinchStartMidX - gs.pinchStartPanX) / gs.pinchStartZoom;
        const canvasY = (gs.pinchStartMidY - gs.pinchStartPanY) / gs.pinchStartZoom;
        setViewport({
          zoom: newZoom,
          panX: midX - canvasX * newZoom,
          panY: midY - canvasY * newZoom,
        });
      }
      return;
    }

    if (gs.pointers.size === 1 && singlePointerDragRef.current) {
      // Single-pointer drag (pan or shape-move). Delegate to the Canvas.
      onSinglePointerMove?.(x, y);

      // Track velocity for momentum (touch only).
      if (e.pointerType === 'touch') {
        const now = Date.now();
        const dt = now - gs.lastPanTime;
        if (dt > 0) {
          // Exponential moving average for smoother velocity.
          const alpha = 0.5;
          const instVx = (x - gs.lastPanX) / dt;
          const instVy = (y - gs.lastPanY) / dt;
          gs.velocityX = gs.velocityX * (1 - alpha) + instVx * alpha;
          gs.velocityY = gs.velocityY * (1 - alpha) + instVy * alpha;
        }
        gs.lastPanX = x;
        gs.lastPanY = y;
        gs.lastPanTime = now;
      }
    }
  }, [containerRef, onSinglePointerMove, setViewport]);

  const onPointerUp = useCallback((e: PointerEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const gs = gestureRef.current;
    const wasTouch = e.pointerType === 'touch';

    gs.pointers.delete(e.pointerId);

    if (gs.pointers.size < 2) {
      // Pinch ended — reset pinch state.
      gs.pinchStartDist = 0;
    }

    if (gs.pointers.size === 0) {
      // All pointers up.
      if (singlePointerDragRef.current) {
        onSinglePointerUp?.(x, y);
        singlePointerDragRef.current = false;
      }

      // Touch momentum (inertia) panning.
      if (wasTouch && (Math.abs(gs.velocityX) > MOMENTUM_MIN_VELOCITY || Math.abs(gs.velocityY) > MOMENTUM_MIN_VELOCITY)) {
        const animate = () => {
          const v = gestureRef.current;
          setViewport((vp) => ({
            ...vp,
            panX: vp.panX + v.velocityX * 16, // ~16ms per frame
            panY: vp.panY + v.velocityY * 16,
          }));
          v.velocityX *= MOMENTUM_FRICTION;
          v.velocityY *= MOMENTUM_FRICTION;
          if (Math.abs(v.velocityX) > MOMENTUM_MIN_VELOCITY || Math.abs(v.velocityY) > MOMENTUM_MIN_VELOCITY) {
            momentumRef.current = requestAnimationFrame(animate);
          } else {
            momentumRef.current = null;
          }
        };
        momentumRef.current = requestAnimationFrame(animate);
      }

      // Double-tap detection (touch only).
      if (wasTouch) {
        const now = Date.now();
        const gs2 = gestureRef.current;
        if (now - gs2.lastTapTime < DOUBLE_TAP_MS &&
            Math.abs(x - gs2.lastTapX) < DOUBLE_TAP_DIST_PX &&
            Math.abs(y - gs2.lastTapY) < DOUBLE_TAP_DIST_PX) {
          // Double-tap → zoom in 2x at the tap point.
          const vp = viewportRef.current;
          const newZoom = clampZoom(vp.zoom * 2);
          const canvasX = (x - vp.panX) / vp.zoom;
          const canvasY = (y - vp.panY) / vp.zoom;
          setViewport({
            zoom: newZoom,
            panX: x - canvasX * newZoom,
            panY: y - canvasY * newZoom,
          });
          gs2.lastTapTime = 0; // Reset so triple-tap doesn't zoom again.
        } else {
          gs2.lastTapTime = now;
          gs2.lastTapX = x;
          gs2.lastTapY = y;
        }
      }
    }
  }, [containerRef, onSinglePointerUp, setViewport]);

  // ---- Register native event listeners --------------------------------------
  // We use native addEventListener (not React props) so we can control
  // passive/passive and capture phases precisely.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Wheel: passive=false so we can preventDefault (stop browser zoom/scroll).
    el.addEventListener('wheel', onWheel, { passive: false });
    // Pointer events: we use pointer capture for reliable drag tracking.
    // The pointer handlers are always defined (they default to no-op when the
    // optional callbacks aren't provided), so they're safe to pass directly.
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);

    // Set touch-action: none so the browser doesn't intercept touch gestures
    // (no scrolling, no double-tap-zoom, no long-press context menu).
    el.style.touchAction = 'none';

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      if (momentumRef.current !== null) {
        cancelAnimationFrame(momentumRef.current);
        momentumRef.current = null;
      }
    };
  }, [containerRef, onWheel, onPointerDown, onPointerMove, onPointerUp]);
}
