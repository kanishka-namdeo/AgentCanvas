// Client-side reconnect catch-up on the agent event journal.
//
// The server journals every significant agent event (AgentEvent table, per-
// document monotonic `seq`) and exposes it at
// GET /api/documents/[documentId]/events?afterSeq=N. This module is the
// CONSUMER: it turns that read API into reconnect recovery.
//
// WHAT IT FIXES
// -------------
// A socket.io disconnect (network blip, laptop sleep, page reload) during an
// agent turn means the client misses live sync events. The canvas itself is
// already covered — canvas-sync re-sends `canvas:full` to every (re)subscriber.
// The journal covers agent state: the turn's CLOSURE (turn_end / error) for
// the client that held the turn open, and — since Phase B — whole MISSED
// turns, reconstructed with content from `agent:user_message` +
// `agent:turn_final` rows (the OpenHands "events are the transcript" /
// LibreChat `aggregatedContent` patterns).
//
// WATERMARK MODEL
// ---------------
// The client keeps a per-document watermark = the journal seq it has
// definitely accounted for, persisted in localStorage (survives reload).
// It advances at exactly two points:
//   1. When a terminal agent event is processed LIVE (_onSync →
//      scheduleWatermarkAdvance, debounced) — so a clean session keeps the
//      watermark at the last closed turn's boundary.
//   2. After a catch-up run completes (replayed or skipped-and-advanced).
// Live deltas/streaming events do NOT advance it: they carry no seq (journal
// writes are deliberately fire-and-forget server-side), and a watermark that
// moved mid-turn would hide the very gap we want to replay.
//
// REPLAY SAFETY (Phase B: identity-based, unbounded)
// ---------------------------------------------------
// Phase A replayed ONLY onto an open last turn and stopped at the first
// terminal (position-based guards — the handlers were "last turn"-attributed
// and historical events could corrupt an unrelated turn). Phase B makes
// replay identity-idempotent instead, so the ENTIRE gap window replays:
//   a) `agent:user_message` / `agent:turn_final` rows carry the client
//      session/run/message ids (R3) — the _onSync handlers adopt them BY ID,
//      so a row whose effect already exists locally is a no-op, and a row
//      for a turn never seen CREATES the turn (message_start synthesizes the
//      assistant placeholder when the last turn isn't one).
//   b) Terminal rows dispatch too — in journal order they attribute to the
//      turn their own user_message/message_start rows just created, and the
//      handlers' own guards (terminal-state checks, id-deduped tool calls)
//      absorb duplicates.
//   c) Patches are STILL never replayed: `canvas:full` on resubscribe owns
//      canvas state, and re-applying patches against the refreshed document
//      would double-apply (the C1 dedup set cannot catch patches the client
//      never applied). Same for `user_patch` rows (they exist for durability
//      + audit; canvas state arrives via the relay's document, not the log).
//   d) The first-connect baseline stays: a client with NO watermark is new
//      to this document — it baselines to the journal head instead of
//      importing history its sessions never knew.
//
// LIMITATIONS (documented, deliberate): tool-call detail inside replayed
// turns attaches to the turn but does not create session-store ToolCall
// records (those are keyed by the originating client's run ids); patch-op
// diff summaries for missed turns are not reconstructed (canvas effects
// arrive via canvas:full / snapshots).

import type { SyncEvent } from './types';

const WATERMARK_STORAGE_KEY = 'agentcanvas.journal-watermark.v1';

/// Terminal journal rows — replayed like any other row now (their handlers'
/// own guards make them idempotent); kept as a set for watermark-advance
/// triggers and consumers that care about closure boundaries.
const TERMINAL_JOURNAL_TYPES = new Set([
  'agent:turn_end',
  'agent:turn_cancelled',
  'agent:error',
  'agent:stuck',
]);

/// Synthetic (non-SyncEvent) journal row types — audit records, never
/// dispatchable to _onSync.
const SYNTHETIC_JOURNAL_TYPES = new Set(['agent:tool_call_interrupted', 'patch_dropped']);

/// Journal row types that are NEVER dispatched — canvas state belongs to
/// the relay's document + `canvas:full`, not the event log.
const UNDISPATCHED_JOURNAL_TYPES = new Set(['patch', 'user_patch']);

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
  /// Replicache-style per-client mutation clocks (R1, additive): the outbox
  /// prunes every entry with id <= its client's entry here.
  lastMutationIDChanges?: Record<string, number>;
  /// Phase C (R2) compaction awareness: seq covered by the newest server
  /// fold checkpoint (null = none yet).
  snapshotSeq?: number | null;
  /// Phase C (R2): minimum seq still present in the journal (null = empty).
  /// A watermark below this cannot replay a contiguous window.
  oldestSeq?: number | null;
}

/// Adapter the host store provides — keeps this module testable without
/// importing the zustand store (no circular import: store → catchup only).
export interface CatchUpAdapter {
  /// Dispatch a replayed SyncEvent (the store routes it through _onSync).
  dispatch: (ev: SyncEvent) => void;
  /// Optional: receive the server's per-client mutation clocks with the
  /// catch-up response — the host prunes its offline outbox by the
  /// Replicache `id <= lastMutationID` rule.
  onMutationClock?: (changes: Record<string, number>) => void;
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
/// terminal (informational since Phase B — replay no longer stops, but
/// callers/tests use it for closure-boundary assertions).
function replayRow(row: JournalRowWire, adapter: CatchUpAdapter): boolean {
  if (UNDISPATCHED_JOURNAL_TYPES.has(row.type)) return false; // canvas:full owns canvas state
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
/// (re)connect (first connect included — it establishes the baseline) and,
/// REST-first (R4), once on mount BEFORE the socket attaches when the status
/// endpoint reports a live run.
export async function runJournalCatchUp(
  documentId: string,
  adapter: CatchUpAdapter,
): Promise<void> {
  let watermark = loadWatermark(documentId);

  if (watermark === 0) {
    // First-ever connect on this browser (no persisted watermark): establish
    // the baseline WITHOUT replaying — historical events belong to turns this
    // client never had. Fresh loads hydrate from snapshots + canvas:full.
    // (Identity-idempotent replay would be SAFE here, but importing a foreign
    // history into a fresh session's transcript is wrong, not unsafe.)
    const page = await fetchEventsPage(documentId, Number.MAX_SAFE_INTEGER);
    if (page) {
      saveWatermark(documentId, page.lastSeq);
      reportMutationClock(page, adapter);
    }
    return;
  }

  // Fetch the gap window (paged until the server says we're current).
  //
  // Too-old watermark (Phase C R2): compaction prunes journal rows a server
  // checkpoint already covers. If rows below our watermark are gone, the
  // window is not contiguous — replaying the surviving fragment would
  // surface a PARTIAL history (missing turns mid-gap). Replicache's bad-cookie
  // rule: full refetch, never an error. Here that means: re-baseline to the
  // journal head WITHOUT replay (canvas state arrives via canvas:full, the
  // transcript via the sessions store hydration) and let the mutation clocks
  // prune the outbox.
  const firstPage = await fetchEventsPage(documentId, watermark);
  // Contiguity: the replay needs rows (watermark, head] with no hole at the
  // start — the oldest surviving row may sit AT watermark+1 (already-
  // consumed row at the watermark itself is fine); only a row MISSING at
  // watermark+1 (oldestSeq beyond it) is a bad cookie.
  if (firstPage && typeof firstPage.oldestSeq === 'number' && watermark + 1 < firstPage.oldestSeq) {
    saveWatermark(documentId, firstPage.lastSeq);
    reportMutationClock(firstPage, adapter);
    return;
  }

  const rows: JournalRowWire[] = [];
  let lastSeq = watermark;
  let lastMutationIDChanges: Record<string, number> | undefined;
  let res: EventsResponse | null = firstPage;
  for (let page = 0; page < 20; page++) {
    if (!res) break; // fetch failed — keep the old watermark, retry next reconnect
    rows.push(...res.events);
    lastSeq = res.lastSeq;
    lastMutationIDChanges = res.lastMutationIDChanges ?? lastMutationIDChanges;
    watermark = res.events.length > 0 ? res.events[res.events.length - 1].seq : watermark;
    if (!res.truncated) break;
    res = await fetchEventsPage(documentId, watermark);
  }

  // Unbounded replay (R3): the whole window, in journal order. Every row's
  // effect is identity-idempotent in the _onSync handlers (messageId adoption,
  // terminal-state guards, id-deduped tool calls), so rows whose turn the
  // client already holds partially are no-ops and rows for turns it never
  // saw create them with content.
  for (const row of rows) {
    replayRow(row, adapter);
  }

  if (lastMutationIDChanges) {
    reportMutationClock({ lastMutationIDChanges } as EventsResponse, adapter);
  }

  // Advance to the probed lastSeq (not just the last replayed row): rows we
  // deliberately skipped (patches, post-terminal foreign turns) are accounted
  // for — the next reconnect window starts cleanly at "now".
  if (lastSeq > loadWatermark(documentId)) saveWatermark(documentId, lastSeq);
}

function reportMutationClock(page: EventsResponse, adapter: CatchUpAdapter): void {
  if (!page.lastMutationIDChanges || typeof page.lastMutationIDChanges !== 'object') return;
  adapter.onMutationClock?.(page.lastMutationIDChanges);
}
