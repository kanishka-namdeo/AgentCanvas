// measure.ts — the measured-bounds readback pool (spec §3.8, Phase 2).
//
// One shared ResizeObserver watches every mounted node element in NATIVE
// layout mode and writes real { width, height } sizes into the canvas
// store's `measuredBounds` runtime slice (via the `onMeasure` callback
// DomCanvas wires to `setMeasuredBounds`). The cache NEVER re-enters layout:
//   model → DOM → measure → cache → (hint on next document mutation)
// so there is no feedback loop — the browser is the layout authority and
// the cache only improves the resolver's server-side approximations.
//
// jsdom safety: `typeof ResizeObserver === 'undefined'` (jsdom has none) →
// the pool is a NO-OP (observe/unobserve/disconnect all no-op), so unit and
// integration tests run unchanged. Callbacks are coalesced via rAF (with a
// setTimeout(0) fallback when rAF is unavailable).
//
// Capacity: capped at MAX_OBSERVED ids (FIFO eviction by insertion order —
// a Map iterates keys oldest-first). Exceeding the cap logs once in dev.

/// Real browser-measured node size (mirrors the store's MeasuredBounds).
export interface MeasuredBounds {
  width: number;
  height: number;
}

export type MeasureCallback = (id: string, bounds: MeasuredBounds) => void;

/// Max simultaneously observed node ids (spec §4 scale budget: ~5k nodes per
/// page; the pool keeps a margin below that).
const MAX_OBSERVED = 4000;

export class MeasuredBoundsPool {
  private readonly els = new Map<string, HTMLDivElement>();
  private readonly idsByEl = new Map<HTMLDivElement, string>();
  private readonly ro: ResizeObserver | null = null;
  private readonly pending = new Map<string, MeasuredBounds>();
  private rafScheduled = false;
  private capWarned = false;

  constructor(private readonly onMeasure: MeasureCallback) {
    // jsdom (and any environment without ResizeObserver) gets a no-op pool.
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver((entries) => this.handleEntries(entries));
    }
  }

  /// Register a node element under its layer id. Re-registering an id
  /// (React ref churn) un-observes the previous element first.
  observe(el: HTMLDivElement, id: string): void {
    if (!el || !id) return;
    const existing = this.els.get(id);
    if (existing && existing !== el) {
      this.doUnobserve(id);
    }
    if (this.els.has(id)) return;
    // FIFO eviction by insertion order (Map key iteration = insertion order).
    while (this.els.size >= MAX_OBSERVED) {
      const oldestId = this.els.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      if (process.env.NODE_ENV !== 'production' && !this.capWarned) {
        this.capWarned = true;
        console.warn(
          `[measure] measured-bounds pool cap (${MAX_OBSERVED}) exceeded — evicting oldest observations (FIFO)`,
        );
      }
      this.doUnobserve(oldestId);
    }
    this.els.set(id, el);
    this.idsByEl.set(el, id);
    this.ro?.observe(el);
  }

  /// Unregister a node id (element unmounted).
  unobserve(id: string): void {
    if (!this.els.has(id)) return;
    this.doUnobserve(id);
  }

  /// Tear the whole pool down (DomCanvas unmount / layout-mode switch).
  disconnect(): void {
    this.ro?.disconnect();
    this.els.clear();
    this.idsByEl.clear();
    this.pending.clear();
    this.rafScheduled = false;
  }

  /// Currently observed id count (tests / diagnostics).
  get size(): number {
    return this.els.size;
  }

  private doUnobserve(id: string): void {
    const el = this.els.get(id);
    if (el) {
      this.ro?.unobserve(el);
      this.idsByEl.delete(el);
    }
    this.els.delete(id);
    this.pending.delete(id);
  }

  private handleEntries(entries: ResizeObserverEntry[]): void {
    for (const entry of entries) {
      const id = this.idsByEl.get(entry.target as HTMLDivElement);
      if (!id) continue;
      const cr = entry.contentRect;
      const width = Math.round(cr.width);
      const height = Math.round(cr.height);
      // Last write wins within a frame (coalesced).
      this.pending.set(id, { width, height });
    }
    if (this.pending.size > 0) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    const flush = () => {
      this.rafScheduled = false;
      const entries = Array.from(this.pending.entries());
      this.pending.clear();
      for (const [id, bounds] of entries) {
        this.onMeasure(id, bounds);
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else if (typeof setTimeout === 'function') {
      setTimeout(flush, 0);
    } else {
      flush();
    }
  }
}
