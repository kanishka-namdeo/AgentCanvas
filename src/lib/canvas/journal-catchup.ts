// Client-side reconnect catch-up on the agent event journal.
//
// The server journals every significant agent event (AgentEvent table, per-
// document monotonic `seq`) and exposes it at
// GET /api/documents/[documentId]/events?afterSeq=N. This module is the
// missing CONSUMER: it turns that read API into reconnect recovery.
//
// WHAT IT FIXES
// -------------
// A socket.io disconnect (network blip, laptop sleep, page reload) during an
// agent turn means the client misses live sync events. The canvas itself is
// already covered — canvas-sync re-sends `canvas:full` to every (re)subscriber.
// What was NOT covered: the agent turn's CLOSURE. A client that missed
// `agent:turn_end` / `turn_cancelled` / `agent:error` / `agent:stuck` stays
// `agentBusy` with a forever-streaming message and an 'in_progress' run —
// until the 10-minute zombie sweep. With catch-up, the missed terminal event
// is replayed within one reconnect (~1-2s) and the turn finalizes honestly.
//
// WATERMARK MODEL
// ---------------
// The client keeps a per-document watermark = the journal seq it has
// definitely accounted for, persisted in localStorage (survives reload).
// It advances at exactly two points:
//   1. When a terminal agent event is processed LIVE (_onSync →
//      scheduleWatermarkAdvance, debounced) — so a clean session keeps the
//      watermark at the last closed turn's boundary.
//   2. After a catch-up run completes (replayed or skipped-and-skipped).
// Live deltas/streaming events do NOT advance it: they carry no seq (journal
// writes are deliberately fire-and-forget server-side), and a watermark that
// moved mid-turn would hide the very gap we want to replay.
//
// REPLAY SAFETY (why the guards below exist)
// ------------------------------------------
// `_onSync` agent handlers are POSITION-based ("the last turn"), not
// id-based. Replaying arbitrary historical events onto a DIFFERENT turn
// would corrupt it. Three guards make replay safe:
//   a) Only replays when the client holds an OPEN last turn (streaming /
//      agentBusy) — i.e. the events in the window belong to THAT turn.
//      A closed last turn means the window belongs to foreign/older turns:
//      skip everything, just advance the watermark.
//   b) Stops at the FIRST terminal event — the closure is the payload we
//      want; anything after it belongs to later turns we never saw.
//   c) Patches are NEVER replayed: `canvas:full` on resubscribe already
//      brings the canvas current, and re-applying the same patches against
//      the refreshed document would double-apply (the C1 dedup set cannot
//      catch patches the client never applied). Canvas state ≠ journal's job.
//
// KNOWN LIMITATION (documented, deliberate): a disconnect spanning MULTIPLE
// turns replays only the first turn's closure; turns the client never saw
// are not reconstructed (their canvas effects arrive via `canvas:full` /
// snapshots, their chat rows never existed client-side).

import type { SyncEvent } from './types';

const WATERMARK_STORAGE_KEY = 'agentcanvas.journal-watermark.v1';

/// Terminal journal rows — replay stops after the first one (the turn
/// closure is what a reconnecting client needs).
const TERMINAL_JOURNAL_TYPES = new Set([
  'agent:turn_end',
  'agent:turn_cancelled',
  'agent:error',
  'agent:stuck',
]);

/// Synthetic (non-SyncEvent) journal row types — audit records, never
/// dispatchable to _onSync.
const SYNTHETIC_JOURNAL_TYPES = new Set(['agent:tool_call_interrupted', 'patch_dropped']);

/// Debounce window for the live-terminal watermark advance (trailing).
const WATERMARK_ADVANCE_DEBOUNCE_MS = 600;

/// Page size for catch-up fetches (server caps at 1000).
const FETCH_PAGE_LIMIT = 200;

export interface JournalRowWire {
  seq: number;
  type: string;
  toolCallId: string | null;
  payload: unknown;
  createdAt: string;
}

interface EventsResponse {
  events: JournalRowWire[];
  lastSeq: number;
  count: number;
  truncated: boolean;
}

/// Adapter the host store provides — keeps this module testable without
/// importing the zustand store (no circular import: store → catchup only).
export interface CatchUpAdapter {
  /// Whether the client currently holds an OPEN last turn (streaming /
  /// agentBusy) — replay is only positionally safe then.
  isTurnOpen: () => boolean;
  /// Dispatch a replayed SyncEvent (the store routes it through _onSync).
  dispatch: (ev: SyncEvent) => void;
}

// ---- watermark persistence (localStorage) ------------------------------------

type Watermarks = Record<string, number>;

function readWatermarks(): Watermarks {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(WATERMARK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Watermarks;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeWatermarks(w: Watermarks): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(WATERMARK_STORAGE_KEY, JSON.stringify(w));
  } catch {
    // Quota / privacy-mode failures must never break reconnect handling.
  }
}

export function loadWatermark(documentId: string): number {
  return readWatermarks()[documentId] ?? 0;
}

export function saveWatermark(documentId: string, seq: number): void {
  if (!Number.isFinite(seq) || seq < 0) return;
  const w = readWatermarks();
  // Monotonic — never move a watermark backwards (a racing late save with a
  // stale lastSeq would otherwise re-open an already-replayed window).
  if ((w[documentId] ?? 0) >= seq) return;
  w[documentId] = seq;
  writeWatermarks(w);
}

// ---- fetch -------------------------------------------------------------------

async function fetchEventsPage(
  documentId: string,
  afterSeq: number,
): Promise<EventsResponse | null> {
  try {
    const res = await fetch(
      `/api/documents/${encodeURIComponent(documentId)}/events?afterSeq=${afterSeq}&limit=${FETCH_PAGE_LIMIT}`,
      { headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as EventsResponse;
    if (!body || !Array.isArray(body.events) || !Number.isFinite(body.lastSeq)) return null;
    return body;
  } catch {
    // Offline flapping / server restarting — the next reconnect retries.
    return null;
  }
}

/// Cheap lastSeq probe: `afterSeq` beyond any real seq returns an empty page
/// with the true watermark. Used by the debounced live-terminal advance.
async function fetchLastSeq(documentId: string): Promise<number | null> {
  const page = await fetchEventsPage(documentId, Number.MAX_SAFE_INTEGER);
  return page?.lastSeq ?? null;
}

// ---- live-terminal watermark advance (debounced) ------------------------------

const advanceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/// Called by the store whenever a terminal agent event is processed LIVE.
/// Coalesces bursts (turn_end + trailing turn_cancelled…) into one probe and
/// saves the journal's current lastSeq as the new watermark.
export function scheduleWatermarkAdvance(documentId: string): void {
  const existing = advanceTimers.get(documentId);
  if (existing) clearTimeout(existing);
  advanceTimers.set(
    documentId,
    setTimeout(() => {
      advanceTimers.delete(documentId);
      void fetchLastSeq(documentId).then((lastSeq) => {
        if (lastSeq !== null) saveWatermark(documentId, lastSeq);
      });
    }, WATERMARK_ADVANCE_DEBOUNCE_MS),
  );
}

/// Test hook — cancel pending debounced advances (suite isolation).
export function __clearPendingWatermarkAdvances(): void {
  for (const t of advanceTimers.values()) clearTimeout(t);
  advanceTimers.clear();
}

// ---- catch-up ----------------------------------------------------------------

/// Replay one journal row through the adapter. Returns true when the row was
/// terminal (caller stops replaying after dispatching it).
function replayRow(row: JournalRowWire, adapter: CatchUpAdapter): boolean {
  if (row.type === 'patch') return false; // canvas:full owns canvas state
  if (SYNTHETIC_JOURNAL_TYPES.has(row.type)) return false; // audit rows
  if (!row.type.startsWith('agent:')) return false;
  const ev = row.payload as SyncEvent | undefined;
  if (!ev || typeof ev !== 'object' || (ev as { type?: unknown }).type !== row.type) {
    // Payload/type mismatch (foreign writer, truncated row) — skip.
    return false;
  }
  adapter.dispatch(ev);
  return TERMINAL_JOURNAL_TYPES.has(row.type);
}

/// Run the reconnect catch-up for a document. Called on every socket
/// (re)connect — first connect included (it establishes the baseline).
export async function runJournalCatchUp(
  documentId: string,
  adapter: CatchUpAdapter,
): Promise<void> {
  let watermark = loadWatermark(documentId);

  if (watermark === 0) {
    // First-ever connect on this browser (no persisted watermark): establish
    // the baseline WITHOUT replaying — historical events belong to turns this
    // client never had, and position-based replay onto a stale/empty turn
    // list would corrupt it. Fresh loads hydrate from snapshots + canvas:full.
    const page = await fetchEventsPage(documentId, Number.MAX_SAFE_INTEGER);
    if (page) saveWatermark(documentId, page.lastSeq);
    return;
  }

  // Fetch the gap window (paged until the server says we're current).
  const rows: JournalRowWire[] = [];
  let lastSeq = watermark;
  for (let page = 0; page < 20; page++) {
    const res = await fetchEventsPage(documentId, watermark);
    if (!res) break; // fetch failed — keep the old watermark, retry next reconnect
    rows.push(...res.events);
    lastSeq = res.lastSeq;
    watermark = res.events.length > 0 ? res.events[res.events.length - 1].seq : watermark;
    if (!res.truncated) break;
  }

  if (!adapter.isTurnOpen()) {
    // No open turn: the window belongs to foreign/older turns — nothing is
    // positionally safe (or needed). Square the watermark and leave.
    if (lastSeq > loadWatermark(documentId)) saveWatermark(documentId, lastSeq);
    return;
  }

  // Open turn: replay the window's agent events onto it, stopping at the
  // first terminal closure.
  for (const row of rows) {
    const wasTerminal = replayRow(row, adapter);
    if (wasTerminal) break;
  }

  // Advance to the probed lastSeq (not just the last replayed row): rows we
  // deliberately skipped (patches, post-terminal foreign turns) are accounted
  // for — the next reconnect window starts cleanly at "now".
  if (lastSeq > loadWatermark(documentId)) saveWatermark(documentId, lastSeq);
}
