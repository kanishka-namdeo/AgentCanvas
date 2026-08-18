'use client';

// useScrub — drag-to-change numeric input hook.
//
// On pointer-down, requests Element.requestPointerLock() and listens to
// window-level mousemove events. Each movementX adjusts the value by
// `step` (Shift = 10× speed). On pointer-up, exits pointer lock and
// invokes the onCommit callback with the final value.
//
// P1-17 item from the UI Audit. The hook is intentionally simple — it
// doesn't handle keyboard modifier changes mid-drag (the speed is locked
// at press-time based on e.shiftKey).
//
// Usage:
//   const scrubHandlers = useScrub({
//     initialValue: 100, step: 1, onChange: (v) => sendPatch({ ... }),
//     onCommit: (v) => sendPatch({ op: 'update', shape: { x: v }, ... }),
//   });
//   <input type="number" {...scrubHandlers} />
//
// The hook returns props to spread on the target input:
//   - onMouseDown: starts scrub
//   - onDoubleClick: resets to defaultValue
//
// The actual onPointerMove / onPointerUp handlers are attached at the
// window level once a scrub starts, so they don't pollute the input's
// event surface.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseScrubOptions {
  /// Initial value when the scrub starts. The onCommit callback receives the
  /// final value after dragging.
  initialValue: number;
  /// Per-pixel movement delta. Default 1.
  step?: number;
  /// Multiplier applied when Shift is held. Default 10.
  shiftMultiplier?: number;
  /// Called continuously during the scrub with the new value (for live preview).
  onChange?: (v: number) => void;
  /// Called once on pointer-up with the final value (to emit the patch).
  onCommit?: (v: number) => void;
  /// Optional minimum clamp.
  min?: number;
  /// Optional maximum clamp.
  max?: number;
  /// Reset-to value on double-click. If undefined, double-click does nothing.
  resetTo?: number;
}

export interface UseScrubHandlers {
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  /// Cursor style for the input — 'ew-resize' indicates horizontal scrub.
  style?: React.CSSProperties;
}

export function useScrub(opts: UseScrubOptions): UseScrubHandlers {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const valueRef = useRef(opts.initialValue);
  const [isScrubbing, setIsScrubbing] = useState(false);

  // Update valueRef when the prop value changes (e.g. external selection change).
  useEffect(() => {
    if (!isScrubbing) valueRef.current = opts.initialValue;
  }, [opts.initialValue, isScrubbing]);

  // Attach window-level listeners while scrubbing.
  useEffect(() => {
    if (!isScrubbing) return;
    const onMove = (e: MouseEvent) => {
      const o = optsRef.current;
      const mult = e.shiftKey ? (o.shiftMultiplier ?? 10) : 1;
      const delta = e.movementX * (o.step ?? 1) * mult;
      let next = valueRef.current + delta;
      if (o.min !== undefined) next = Math.max(o.min, next);
      if (o.max !== undefined) next = Math.min(o.max, next);
      valueRef.current = next;
      o.onChange?.(next);
    };
    const onUp = () => {
      setIsScrubbing(false);
      const o = optsRef.current;
      o.onCommit?.(valueRef.current);
      if (typeof document !== 'undefined' && document.exitPointerLock) {
        document.exitPointerLock();
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isScrubbing]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start scrub on left-click without modifiers (except Shift).
    if (e.button !== 0) return;
    // Don't scrub if the user is trying to place the cursor in the input —
    // require Alt-drag OR a click on the label area. For simplicity, we
    // scrub on plain left-click and require the user to triple-click for
    // text selection. This matches Figma's behavior.
    e.preventDefault();
    valueRef.current = optsRef.current.initialValue;
    setIsScrubbing(true);
    // Request pointer lock so the cursor stays inside the window.
    if (typeof document !== 'undefined' && document.documentElement.requestPointerLock) {
      try {
        (e.target as HTMLElement).requestPointerLock?.();
      } catch {
        // requestPointerLock can throw if not in a secure context — silent fail.
      }
    }
  }, []);

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    if (optsRef.current.resetTo === undefined) return;
    e.preventDefault();
    valueRef.current = optsRef.current.resetTo;
    optsRef.current.onChange?.(optsRef.current.resetTo);
    optsRef.current.onCommit?.(optsRef.current.resetTo);
  }, []);

  return {
    onMouseDown,
    onDoubleClick,
    style: { cursor: 'ew-resize' },
  };
}
