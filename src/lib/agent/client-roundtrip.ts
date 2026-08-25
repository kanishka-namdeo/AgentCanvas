// client-roundtrip.ts — server-side pending registry for the client↔server
// round-trip tools (spec §5.2 / §5.4 / §5.5, Phase 3 — M2-c).
//
// Mirrors the ask-user-question plugin's pending-map pattern
// (plugins/ask-user-question.ts): a tool emits a SyncEvent through the
// per-turn event sink (plugins/event-bus) and blocks on a Promise stored in
// a module-level Map keyed by toolCallId. The browser's store handles the
// event, reads the live DOM (getComputedStyle / getBoundingClientRect /
// html-to-image capture), and POSTs the answer to
// /api/agent/client-responses — which calls the resolver here.
//
// Event path (verified — same one ask_user_question rides):
//   tool.execute → emitEvent → runner-native sink → agent_event queue →
//   /api/agent NDJSON line → canvas-sync driveAgent fanout → socket.io
//   'sync' → store._onSync → client POST → resolver below.
// The route, canvas-sync and the translator pass ALL SyncEvent types through
// (no filtering), so the new request events ride for free.
//
// HANG SAFETY (critical constraint): `awaitClientResponse` NEVER rejects.
// On timeout it resolves `null` and the caller falls back to resolver-data /
// server-side rendering. The agent loop can therefore never wedge on a
// round-trip, even when no client is connected (headless runs, tests).
//
// Also hosts the SERVER-side measured-bounds runtime store (spec §3.8): the
// DOM renderer pushes its ResizeObserver cache via canvas:measured_bounds /
// the client-responses POST, and consumers (canvasSnapshot §5.5,
// pen_bake_layout) read it back per document. LRU-capped.

/// One pending round-trip: the resolve fn for the blocked tool + the timeout
/// timer that will resolve null (never reject).
interface PendingClientResponse {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingClientResponse>();

/// Default round-trip budgets (ms). Exported as a mutable object so tests can
/// shrink the timeouts instead of waiting real seconds — and so tuning is a
/// one-line change. Spec: 2s for tools, 3s for the VLM critic (§5.4).
export const ROUNDTRIP_DEFAULTS = {
  computedTimeoutMs: 2000,
  screenshotTimeoutMs: 2000,
  criticScreenshotTimeoutMs: 3000,
};

/** Result payload for an `agent:computed_request` round-trip. */
export interface ComputedResult {
  id: string;
  /** Screen-space bounding rect (getBoundingClientRect, rounded). */
  rect: { x: number; y: number; width: number; height: number };
  /** Canvas-space geometry (world-transform divided out). Width/height are
   *  optional because older clients may send only the position — the tool
   *  falls back to the screen rect when absent. */
  canvasRect?: { x: number; y: number; width?: number; height?: number };
  computed: Record<string, string>;
  /** Client-reported flag; server fallbacks set this themselves. */
  measured?: boolean;
}

/** Result payload for an `agent:screenshot_request` round-trip. */
export interface ScreenshotResult {
  dataUrl?: string;
  error?: string;
}

/**
 * Block until the client answers (via /api/agent/client-responses) or the
 * timeout elapses. Resolves `null` on timeout — NEVER rejects, so the agent
 * loop can't hang (the caller falls back gracefully). `emit` is invoked
 * synchronously AFTER the pending entry is registered, so a (theoretically)
 * instant client response can never race the registration.
 */
export function awaitClientResponse<T>(
  toolCallId: string,
  emit: () => void,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(toolCallId);
      resolve(null);
    }, timeoutMs);
    pending.set(toolCallId, {
      resolve: resolve as (value: unknown) => void,
      timer,
    });
    emit();
  });
}

/// Resolve a pending round-trip. Returns false when nothing was pending
/// (already timed out / unknown id) — callers treat that as "no client".
export function resolveClientResponse<T>(toolCallId: string, value: T): boolean {
  const p = pending.get(toolCallId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(toolCallId);
  p.resolve(value);
  return true;
}

/// Resolver for canvas:computed_response POSTs (kind: 'computed').
export function resolveComputedResponse(toolCallId: string, results: ComputedResult[]): boolean {
  return resolveClientResponse(toolCallId, Array.isArray(results) ? results : []);
}

/// Resolver for canvas:screenshot_response POSTs (kind: 'screenshot').
export function resolveScreenshotResponse(
  toolCallId: string,
  dataUrl?: string,
  error?: string,
): boolean {
  const valid = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/');
  return resolveClientResponse(toolCallId, {
    dataUrl: valid ? dataUrl : undefined,
    error: error ?? (valid ? undefined : dataUrl ? 'invalid_data_url' : 'screenshot_failed'),
  } satisfies ScreenshotResult);
}

// ---- Server-side measured-bounds store (spec §3.8) --------------------------

type BoundsMap = Record<string, { width: number; height: number }>;

/// LRU cap — one entry per document. The app is effectively single-document
/// per browser tab; 20 covers multi-tab / multi-session dev flows without
/// unbounded growth in a long-lived Next.js process.
const MAX_MEASURED_DOCS = 20;
const measuredByDoc = new Map<string, BoundsMap>();

/// Overwrite the measured-bounds cache for a document (client push).
export function setMeasuredBounds(documentId: string, bounds: BoundsMap): void {
  if (!documentId || !bounds || typeof bounds !== 'object') return;
  // Refresh LRU position.
  measuredByDoc.delete(documentId);
  measuredByDoc.set(documentId, { ...bounds });
  while (measuredByDoc.size > MAX_MEASURED_DOCS) {
    const oldest = measuredByDoc.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    measuredByDoc.delete(oldest);
  }
}

/// Read the measured-bounds cache for a document (empty when the client
/// never pushed — consumers degrade to resolver data).
export function getMeasuredBounds(documentId: string): BoundsMap {
  const b = measuredByDoc.get(documentId);
  return b ?? {};
}

/// Test-only: clear pending round-trips + the measured-bounds store.
export function __resetClientRoundtripForTests(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  measuredByDoc.clear();
}
