// Client-side mutation identity + offline outbox (Phase B, R1 + R5).
//
// THE OUTBOX (Figma's "fresh copy + reapply" reconnect contract):
// While the socket is down, `sendPatch` still applies edits optimistically
// (the local canvas never blocks) and queues the wire-bound mutation here.
// On reconnect the client first takes the server's `canvas:full` (reconciled
// per-element via version+nonce — unsynced local edits survive), THEN flushes
// the queue in ascending clientMutationId order. The server's MutationClock
// (lib/canvas/user-patch-journal.ts) dedupes retried entries exactly-once and
// answers `mutation:ack`s that prune the queue. A permanent rejection (gap)
// re-anchors the counter and drops the stale queue with a visible toast —
// never a silent loss, never a deadlock (the Replicache rules).
//
// THE COUNTER: per-client monotonic, contiguous ids (1, 2, 3…). Gaps are
// forbidden server-side because canvas ops are order-dependent, so:
//   - every non-`select` patch is stamped (selects are ephemera — never
//     journaled, never queued; stamping them would burn ids the server
//     never sees and manufacture a gap);
//   - the counter persists to localStorage piggybacked on every outbox
//     enqueue + pagehide/visibility flushes (a localStorage write per
//     60Hz drag is too hot);
//   - on boot the REST status route's `lastMutationIDChanges` RE-ANCHORS the
//     counter to max(local, serverLast + 1), which makes a crash that lost
//     the un-persisted tail safe: ids already accepted server-side are
//     never reused, and the (empty) queue simply continues after them.
//
// Storage keys follow the `agentcanvas.<thing>.v1` convention.

import type { CanvasPatch } from './types';

const CLIENT_ID_KEY = 'agentcanvas.client-id.v1';
const MUTATION_CLOCK_KEY = 'agentcanvas.mutation-clock.v1';
const OUTBOX_KEY = 'agentcanvas.outbox.v1';

/// Per-document outbox cap — drop-OLDEST under pathological bursts (the
/// bounded-dedupe-set / snapshot-cap precedents). Offline drags can enqueue
/// dozens of update patches; 500 keeps the queue useful without letting a
/// stuck tab eat localStorage.
const OUTBOX_CAP_PER_DOC = 500;

export interface OutboxEntry {
  clientMutationId: number;
  patch: CanvasPatch;
  queuedAt: number;
}

type OutboxState = Record<string, OutboxEntry[]>;

// ---- stable client identity ---------------------------------------------------

let clientIdCache: string | null = null;

/// Stable per-browser client id (survives reloads — unlike the per-page-load
/// presence participantId). Used for the MutationClock key and ack routing.
export function getClientId(): string {
  if (clientIdCache) return clientIdCache;
  let id: string | null = null;
  try {
    if (typeof localStorage !== 'undefined') {
      id = localStorage.getItem(CLIENT_ID_KEY);
      if (!id) {
        id =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(CLIENT_ID_KEY, id);
      }
    }
  } catch {
    // Privacy mode / quota — fall through to an ephemeral id.
  }
  clientIdCache = id ?? `ephemeral-${Math.random().toString(36).slice(2)}`;
  return clientIdCache;
}

// ---- monotonic mutation counter -------------------------------------------------

let counter: number | null = null;

function loadCounter(): number {
  if (counter !== null) return counter;
  let value = 0;
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(MUTATION_CLOCK_KEY);
      const parsed = raw ? (JSON.parse(raw) as { next?: number }) : null;
      if (parsed && typeof parsed.next === 'number' && Number.isFinite(parsed.next)) {
        value = Math.max(0, Math.trunc(parsed.next));
      }
    }
  } catch {
    // Corrupt slot — restart from 0; the server anchor fixes any collision.
  }
  counter = value;
  return counter;
}

/// Persist the counter NOW (cheap single-key write). Called on outbox
/// enqueues (a write is happening anyway), pagehide/visibility flushes, and
/// anchor changes — never on the 60Hz sendPatch hot path.
export function persistMutationClock(): void {
  if (counter === null) return;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MUTATION_CLOCK_KEY, JSON.stringify({ next: counter }));
    }
  } catch {
    // Quota failures must never break editing.
  }
}

/// The next contiguous mutation id. Stamped on every non-select sendPatch.
export function nextMutationId(): number {
  const current = loadCounter();
  counter = current + 1;
  return counter;
}

/// Re-anchor the counter from the server's durable lastMutationId (boot-time
/// REST status fetch / a gap rejection). max() — a locally-AHEAD counter
/// (offline edits still queued) must never move backwards.
export function anchorMutationCounter(serverLastForMe: number | undefined | null): void {
  if (serverLastForMe === undefined || serverLastForMe === null || !Number.isFinite(serverLastForMe)) {
    return;
  }
  const current = loadCounter();
  // `counter` stores the LAST ISSUED id (nextMutationId pre-increments), so
  // anchoring to the server's lastMutationId makes the next stamp
  // serverLast + 1. max(): a locally-AHEAD counter (offline edits still
  // queued) must never move backwards.
  const serverLast = Math.max(0, Math.trunc(serverLastForMe));
  if (serverLast > current) {
    counter = serverLast;
    persistMutationClock();
  }
}

/// FORCE the counter to a value — used after a rejected mutation drops the
/// outbox: nothing is in flight anymore, so restarting from server truth is
/// safe AND required (a max()-only anchor would leave the counter ahead of
/// the server clock and every subsequent id would gap-reject forever).
export function resetMutationCounter(serverLast: number): void {
  if (!Number.isFinite(serverLast)) return;
  counter = Math.max(0, Math.trunc(serverLast));
  persistMutationClock();
}

// ---- outbox ----------------------------------------------------------------------

function readOutbox(): OutboxState {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as OutboxState;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeOutbox(state: OutboxState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(state));
  } catch {
    // Quota / privacy mode — the optimistic local apply already happened;
    // the queue simply won't survive a crash.
  }
}

/// Queue a wire-bound mutation (called by sendPatch when the socket is down
/// or the queue is still draining). Persists the outbox AND the counter in
/// the same call — offline editing is exactly when both must survive a crash.
export function enqueueOutboxPatch(documentId: string, clientMutationId: number, patch: CanvasPatch): void {
  const state = readOutbox();
  const queue = state[documentId] ?? [];
  queue.push({ clientMutationId, patch, queuedAt: Date.now() });
  // Drop-oldest cap.
  const dropped = Math.max(0, queue.length - OUTBOX_CAP_PER_DOC);
  state[documentId] = dropped > 0 ? queue.slice(dropped) : queue;
  writeOutbox(state);
  persistMutationClock();
}

/// The document's queued entries, ascending by clientMutationId.
export function outboxEntries(documentId: string): OutboxEntry[] {
  const queue = readOutbox()[documentId] ?? [];
  return [...queue].sort((a, b) => a.clientMutationId - b.clientMutationId);
}

export function outboxSize(documentId: string): number {
  return (readOutbox()[documentId] ?? []).length;
}

/// Remove entries with clientMutationId <= lastMutationId (acked). Returns
/// the number pruned. The Replicache `id <= lastMutationID` rule.
export function pruneOutboxUpTo(documentId: string, lastMutationId: number): number {
  if (!Number.isFinite(lastMutationId)) return 0;
  const state = readOutbox();
  const queue = state[documentId];
  if (!queue || queue.length === 0) return 0;
  const kept = queue.filter((e) => e.clientMutationId > lastMutationId);
  if (kept.length === queue.length) return 0;
  state[documentId] = kept;
  writeOutbox(state);
  return queue.length - kept.length;
}

/// Drop the document's ENTIRE queue (permanent rejection / document restore).
/// Returns the number of entries dropped.
export function clearOutbox(documentId: string): number {
  const state = readOutbox();
  const queue = state[documentId];
  if (!queue || queue.length === 0) return 0;
  delete state[documentId];
  writeOutbox(state);
  return queue.length;
}

/// Whether a patch op should participate in mutation identity at all.
/// `select` is UI state (like presence) — never journaled, never queued.
/// Stamping it would burn a counter id the server never sees → a fake gap.
export function isMutationBearingPatch(patch: CanvasPatch): boolean {
  return patch?.op !== 'select';
}

/// Test hook — reset all module caches + storage slots (full suite isolation).
export function __resetClientMutationsForTests(): void {
  clientIdCache = null;
  counter = null;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(CLIENT_ID_KEY);
      localStorage.removeItem(MUTATION_CLOCK_KEY);
      localStorage.removeItem(OUTBOX_KEY);
    }
  } catch {
    // ignore
  }
}

/// Test hook — clear ONLY the in-module caches, KEEPING the persisted slots.
/// Simulates a page reload (same browser, fresh module state).
export function __reloadClientMutationsForTests(): void {
  clientIdCache = null;
  counter = null;
}
