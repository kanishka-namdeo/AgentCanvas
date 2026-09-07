// key-repeat-coalescer — keyboard auto-repeat rAF coalescing (2026-09-08
// perf, 12-d #12).
//
// ⌘Z/⌘⇧Z held fires the store undo/redo per OS key-repeat (~30/s); every call
// swaps the document → buildWorld + full roots reconciliation per tick. Arrow
// nudges run an O(sel×canvas) shape lookup (×2: shape + parent) plus a full
// update_many apply + resolvePenTree PER KEYPRESS. This coalescer bounds both
// to at most one unit of work per animation frame:
//
//   - undo/redo: a COUNTED rAF drain — every keydown maps to exactly one undo
//     (intent is never lost), but never more than one per frame; leftover ops
//     re-arm the drain;
//   - nudge: (dx, dy) accumulate per frame; ONE applyNudge callback per frame
//     with the TOTAL delta — the callback reads positions from the CURRENT
//     document (not accumulated stale coordinates — the same LWW rule the
//     drag handler uses).
//
// Timing is injectable (`schedule`/`cancel`) so unit tests drive frames
// without fake timers; the default uses requestAnimationFrame with a
// setTimeout(0) fallback for non-browser environments (bare jsdom/Node).

export interface KeyRepeatCoalescerOpts {
  /// Apply ONE undo/redo op. Called at most once per drain.
  applyHistory: (op: 'undo' | 'redo') => void;
  /// Apply one accumulated nudge with the frame's total (dx, dy).
  applyNudge: (dx: number, dy: number) => void;
  /// Injectable frame scheduler (default: requestAnimationFrame, falling
  /// back to setTimeout(0)). Returns a cancelable token or null when the
  /// callback was invoked synchronously.
  schedule?: (fn: () => void) => number | null;
  /// Cancel a token returned by `schedule`.
  cancel?: (token: number) => void;
}

export interface KeyRepeatCoalescer {
  queueUndo(): void;
  queueRedo(): void;
  queueNudge(dx: number, dy: number): void;
  /// Flush anything still pending synchronously and cancel the scheduled
  /// drain (effect-cleanup hook — a mid-frame listener teardown must not
  /// strand the last nudge/undo).
  dispose(): void;
}

const defaultSchedule = (fn: () => void): number | null => {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(fn);
  }
  return setTimeout(fn, 0) as unknown as number;
};

const defaultCancel = (token: number): void => {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(token);
  } else {
    clearTimeout(token);
  }
};

export function createKeyRepeatCoalescer(opts: KeyRepeatCoalescerOpts): KeyRepeatCoalescer {
  const schedule = opts.schedule ?? defaultSchedule;
  const cancel = opts.cancel ?? defaultCancel;
  let pendingUndoOps = 0;
  let pendingRedoOps = 0;
  let pendingNudge: { dx: number; dy: number } | null = null;
  let frameToken: number | null = null;

  const drain = (): void => {
    frameToken = null;
    // History — one op per frame; leftovers re-arm below.
    if (pendingUndoOps > 0) {
      pendingUndoOps -= 1;
      opts.applyHistory('undo');
    } else if (pendingRedoOps > 0) {
      pendingRedoOps -= 1;
      opts.applyHistory('redo');
    }
    // Nudge — one accumulated callback per frame.
    if (pendingNudge) {
      const { dx, dy } = pendingNudge;
      pendingNudge = null;
      opts.applyNudge(dx, dy);
    }
    arm();
  };

  const arm = (): void => {
    if (pendingUndoOps <= 0 && pendingRedoOps <= 0 && !pendingNudge) return;
    if (frameToken != null) return;
    frameToken = schedule(drain);
    // A synchronous scheduler already drained — nothing left to cancel.
  };

  return {
    queueUndo(): void {
      pendingUndoOps += 1;
      arm();
    },
    queueRedo(): void {
      pendingRedoOps += 1;
      arm();
    },
    queueNudge(dx: number, dy: number): void {
      pendingNudge = {
        dx: (pendingNudge?.dx ?? 0) + dx,
        dy: (pendingNudge?.dy ?? 0) + dy,
      };
      arm();
    },
    dispose(): void {
      if (pendingUndoOps > 0 || pendingRedoOps > 0 || pendingNudge) {
        drain();
      }
      if (frameToken != null) cancel(frameToken);
      frameToken = null;
      pendingUndoOps = 0;
      pendingRedoOps = 0;
      pendingNudge = null;
    },
  };
}
