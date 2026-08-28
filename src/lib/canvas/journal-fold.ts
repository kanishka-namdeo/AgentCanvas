// Server-side journal fold (Phase C, R2) — server-authoritative canvas state.
//
// Before this module the socket service's in-memory document was seeded from
// the NEWEST client-POSTed DocumentSnapshot: every mutation the journal
// captured after that snapshot (agent patches since Task 3, user patches
// since Phase B) was LOST on a service restart — the fold's whole reason to
// exist. The research roadmap (download/canvas-durability-research.md §5 R2,
// the Figma checkpoint + journal-tail model) prescribes:
//
//   server document  =  newest fold checkpoint  +  journal tail replay
//
//   - hydrateDocumentFromJournal: checkpoint (DocumentSnapshot with lastSeq
//     set, source='server') → fold every patch / user_patch / document_restore
//     AgentEvent row with seq > checkpoint.lastSeq, in seq order. Fallback
//     for pre-Phase-C documents: newest client snapshot + rows newer than
//     the snapshot's createdAt. Writes a bootstrap checkpoint so the next
//     restart is checkpoint-anchored.
//   - writeServerCheckpoint: DocumentSnapshot { source:'server', lastSeq,
//     tombstones } on turn boundaries + an interval tick. lastSeq is only
//     claimed AFTER a journal quiescence check (the ROUTE bundle journals
//     agent patches from a different module instance — its writeChain is not
//     awaitable here; we wait for the head to go stable instead).
//   - maybeCompactJournal: rows ≤ snapshotSeq - KEEP_TAIL are prunable once
//     the prunable window exceeds COMPACT_MIN_ROWS. Stale clients detect
//     this via the events API's `oldestSeq` and re-baseline (Replicache's
//     "bad cookie → full refetch, never an error" rule).
//   - Tombstones (tldraw/Figma GC semantics): node ids deleted server-side
//     ride every canvas:full as `deletedIds` so reconcile drops them instead
//     of resurrecting them as "local-only adds" (the Phase-A known
//     limitation). Checkpoints persist the tombstone set so compaction
//     cannot erase it.
//
// Ordering caveat (documented, accepted): the route bundle and this module
// allocate seqs from fresh head reads (see event-journal.ts), so two journal
// rows written at the SAME instant from different bundles may land in an
// order that swaps their wall-clock enqueue order. For canvas mutations this
// is the same class of race as two viewers editing simultaneously — the
// version/nonce reconcile resolves it — and it is strictly better than the
// alternative (silent row loss on a seq collision).
//
// Testability: same pattern as user-patch-journal — no socket/port
// dependency, DB imported dynamically (`await import('../db')`) so tests can
// run against a temp SQLite via a module-scope DATABASE_URL, and every
// public function degrades to a no-op/null on DB failure (journal failures
// must never break the live stream).

import type { CanvasDocument, CanvasPatch } from './types';
import { applyPatchToCanvas } from './patch';
import {
  getJournalEvents,
  getJournalLastSeq,
  deleteJournalRowsUpTo,
  appendSyntheticJournalEvent,
  flushJournal,
  type JournalRow,
} from '../agent/event-journal';

/// Tombstone cap — FIFO beyond this (tldraw caps its tombstone list too).
export const TOMBSTONE_CAP = 2000;

/// Rows kept below a checkpoint's lastSeq as a safety tail: reconnecting
/// clients with a watermark inside the tail still replay a contiguous
/// window; older ones re-baseline.
const KEEP_TAIL = 500;

/// Don't compact (churn guard) until the prunable window is at least this
/// many rows — compaction runs on checkpoint writes, which happen at every
/// turn boundary.
const COMPACT_MIN_ROWS = 1000;

/// Quiescence probe budget for turn-boundary checkpoints (see module doc).
const QUIESCE_ROUNDS = 5;
const QUIESCE_WAIT_MS = 150;

/// Fold page size (getJournalEvents caps at 1000).
const FOLD_PAGE = 1000;

export interface FoldHydration {
  document: CanvasDocument;
  tombstones: Set<string>;
  /// Seq the fold started from (0 = folded from empty).
  baseSeq: number;
  /// Seq of the last row actually folded (what the bootstrap checkpoint
  /// claims) — NOT a re-read head, so in-flight rows stay above it.
  foldedThroughSeq: number;
  foldedMutations: number;
}

// ---- pure helpers -------------------------------------------------------------

export function emptyDocument(documentId: string): CanvasDocument {
  return {
    id: documentId,
    name: 'Untitled',
    version: '2.17',
    children: [],
    variables: undefined,
    themes: undefined,
    background: '#f8fafc',
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
}

/// Every node id in the .pen tree (children + nested), depth-first.
export function collectAllNodeIds(doc: CanvasDocument): string[] {
  type WalkNode = { id: string; children?: unknown };
  const out: string[] = [];
  const walk = (nodes: WalkNode[]) => {
    for (const n of nodes ?? []) {
      out.push(n.id);
      if (Array.isArray(n.children)) walk(n.children as WalkNode[]);
    }
  };
  walk((doc.children ?? []) as WalkNode[]);
  return out;
}

/// Node ids a patch touches (for R9a delta context). `global: true` means
/// the op can affect nodes it does not name (clear / undo / tokens / page
/// ops / ungroup …) — callers must treat the whole canvas as changed.
export function patchTouchedNodeIds(patch: CanvasPatch): { ids: Set<string>; global: boolean } {
  const ids = new Set<string>();
  switch (patch.op) {
    case 'add':
    case 'update':
      if (patch.shapeId) ids.add(patch.shapeId);
      return { ids, global: false };
    case 'bulk_add':
      for (const s of patch.shapes ?? []) if (s?.id) ids.add(s.id);
      return { ids, global: false };
    case 'add_subtree':
      if (patch.shapeId) ids.add(patch.shapeId);
      return { ids, global: false };
    case 'update_many':
      for (const u of patch.updates ?? []) if (u?.id) ids.add(u.id);
      return { ids, global: false };
    case 'remove':
      if (patch.shapeId) ids.add(patch.shapeId);
      for (const id of patch.shapeIds ?? []) ids.add(id);
      return { ids, global: false };
    case 'duplicate':
    case 'group':
    case 'align':
    case 'reparent':
    case 'mark_slot':
      for (const id of patch.shapeIds ?? []) ids.add(id);
      return { ids, global: false };
    case 'ungroup':
      // Ungroup re-parents every child of the group — the patch names only
      // the group id; the children are unnamed here.
      if (patch.groupId) ids.add(patch.groupId);
      return { ids, global: true };
    default:
      // clear / background / tokens / viewport / undo / redo / zorder /
      // reorder / set_variable / theme / page / component ops …
      return { ids, global: true };
  }
}

/// Update a tombstone set for a patch ABOUT TO BE applied (needs the
/// PRE-apply document for `clear`, which names nothing). Re-adds clear
/// tombstones (an add with a previously-deleted id — undo-style re-create).
export function trackPatchTombstones(
  docBefore: CanvasDocument,
  patch: CanvasPatch,
  tombstones: Set<string>,
  cap = TOMBSTONE_CAP,
): void {
  const push = (id: string) => {
    tombstones.delete(id); // re-add resets recency (FIFO by insertion order)
    tombstones.add(id);
    // FIFO cap enforced HERE (not just at fold time): the live lane in the
    // socket service (applyAndTrack) calls this per patch and never runs
    // foldTail's end-of-fold enforcement — without this check the set grows
    // without bound on a long-lived document.
    while (tombstones.size > cap) {
      const oldest = tombstones.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === id) break;
      tombstones.delete(oldest);
    }
  };
  switch (patch.op) {
    case 'remove': {
      if (patch.shapeId) push(patch.shapeId);
      for (const id of patch.shapeIds ?? []) push(id);
      return;
    }
    case 'clear': {
      for (const id of collectAllNodeIds(docBefore)) push(id);
      return;
    }
    case 'add':
    case 'bulk_add':
    case 'add_subtree':
    case 'duplicate':
    case 'group': {
      // New nodes cannot be tombstoned; but an explicit id MAY re-create a
      // deleted node (undo) — clear its tombstone so it isn't dropped by
      // the next reconcile.
      const { ids } = patchTouchedNodeIds(patch);
      for (const id of ids) tombstones.delete(id);
      if (patch.op === 'group' && patch.groupId) tombstones.delete(patch.groupId);
      return;
    }
    default:
      return;
  }
}

function enforceTombstoneCap(tombstones: Set<string>, cap: number): void {
  while (tombstones.size > cap) {
    const oldest = tombstones.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    tombstones.delete(oldest);
  }
}

/// Extract the CanvasPatch from a folded journal row's payload, or null when
/// the row is not a canvas mutation.
function patchFromRow(row: JournalRow): CanvasPatch | null {
  if (row.type === 'patch') {
    const p = (row.payload as { patch?: unknown } | null)?.patch;
    return p && typeof p === 'object' ? (p as CanvasPatch) : null;
  }
  if (row.type === 'user_patch') {
    const p = (row.payload as { patch?: unknown } | null)?.patch;
    return p && typeof p === 'object' ? (p as CanvasPatch) : null;
  }
  return null;
}

// ---- fold ---------------------------------------------------------------------

/// Fold every canvas mutation above `baseSeq` onto `doc`, in journal order.
/// Paged; mutation rows only (transcript rows are skipped). Returns the last
/// seq SEEN (foldedThroughSeq) — never a re-read head.
async function foldTail(
  documentId: string,
  doc: CanvasDocument,
  tombstones: Set<string>,
  baseSeq: number,
): Promise<{ doc: CanvasDocument; throughSeq: number; mutations: number }> {
  let current = doc;
  let throughSeq = baseSeq;
  let mutations = 0;
  let after = baseSeq;
  for (let page = 0; page < 50; page++) {
    const rows = await getJournalEvents(documentId, after, FOLD_PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      const patch = patchFromRow(row);
      if (patch) {
        trackPatchTombstones(current, patch, tombstones);
        current = applyPatchToCanvas(current, patch);
        mutations++;
      } else if (row.type === 'document_restore') {
        const snapshotId = (row.payload as { snapshotId?: unknown } | null)?.snapshotId;
        if (typeof snapshotId === 'string') {
          const restored = await loadSnapshotDocument(snapshotId, documentId);
          if (restored) {
            current = restored;
            tombstones.clear();
            mutations++;
          }
        }
      }
      throughSeq = row.seq;
    }
    after = rows[rows.length - 1].seq;
    if (rows.length < FOLD_PAGE) break;
  }
  enforceTombstoneCap(tombstones, TOMBSTONE_CAP);
  return { doc: current, throughSeq, mutations };
}

async function loadSnapshotDocument(
  snapshotId: string,
  documentId: string,
): Promise<CanvasDocument | null> {
  try {
    const { db } = await import('../db');
    const row = await db.documentSnapshot.findUnique({ where: { id: snapshotId } });
    if (!row || row.documentId !== documentId) return null;
    const parsed = JSON.parse(row.document) as CanvasDocument;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return { ...parsed, id: documentId };
  } catch {
    return null;
  }
}

function parseCheckpointTombstones(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

/// Reconstruct the server-authoritative document from durable state ONLY:
/// newest fold checkpoint + journal tail. This is what a process restart
/// hands the first subscriber — the "user edits lost on server restart"
/// gap's end-to-end closure (Phase B journaled them; this replays them).
///
/// Also writes a BOOTSTRAP checkpoint covering exactly what was folded (so
/// the next restart is checkpoint-anchored even for legacy documents that
/// only ever had client snapshots). Best-effort: a failure here still
/// returns the folded document.
export async function hydrateDocumentFromJournal(documentId: string): Promise<FoldHydration> {
  let doc: CanvasDocument | null = null;
  let baseSeq = 0;
  let tombstones = new Set<string>();

  try {
    const { db } = await import('../db');
    const checkpoint = await db.documentSnapshot.findFirst({
      where: { documentId, lastSeq: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (checkpoint && typeof checkpoint.lastSeq === 'number') {
      const parsed = JSON.parse(checkpoint.document) as CanvasDocument;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = { ...parsed, id: documentId };
        baseSeq = checkpoint.lastSeq;
        tombstones = parseCheckpointTombstones(checkpoint.tombstones);
      }
    }
    if (!doc) {
      // Legacy document (pre-Phase-C): best base = newest client snapshot;
      // fold only rows NEWER than the snapshot's creation (approximate —
      // the snapshot's own seq coverage was never recorded).
      const snap = await db.documentSnapshot.findFirst({
        where: { documentId },
        orderBy: { createdAt: 'desc' },
      });
      if (snap) {
        const parsed = JSON.parse(snap.document) as CanvasDocument;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          doc = { ...parsed, id: documentId };
          const marker = await db.agentEvent.findFirst({
            where: { documentId, createdAt: { lte: snap.createdAt } },
            orderBy: { seq: 'desc' },
            select: { seq: true },
          });
          baseSeq = marker?.seq ?? 0;
        }
      }
    }
  } catch {
    // DB unavailable — fold from empty over whatever reads succeed below.
  }

  const startDoc = doc ?? emptyDocument(documentId);
  const folded = await foldTail(documentId, startDoc, tombstones, baseSeq);

  // Bootstrap checkpoint: claims EXACTLY foldedThroughSeq (in-flight rows
  // stay above it — no quiescence needed on this path).
  if (folded.throughSeq > baseSeq || doc === null) {
    void writeCheckpointRow(
      documentId,
      folded.doc,
      tombstones,
      folded.throughSeq,
    ).catch(() => {});
  }

  return {
    document: folded.doc,
    tombstones,
    baseSeq,
    foldedThroughSeq: folded.throughSeq,
    foldedMutations: folded.mutations,
  };
}

// ---- checkpoints ---------------------------------------------------------------

async function writeCheckpointRow(
  documentId: string,
  document: CanvasDocument,
  tombstones: Set<string>,
  lastSeq: number,
): Promise<void> {
  const { db } = await import('../db');
  // Skip a no-op checkpoint (same lastSeq already claimed — turn boundary +
  // interval tick racing).
  const existing = await db.documentSnapshot.findFirst({
    where: { documentId, source: 'server' },
    orderBy: { createdAt: 'desc' },
    select: { lastSeq: true },
  });
  if (existing && typeof existing.lastSeq === 'number' && existing.lastSeq >= lastSeq) return;
  await db.documentSnapshot.create({
    data: {
      id: `ckpt-${documentId}-${lastSeq}-${Date.now().toString(36)}`,
      documentId,
      document: JSON.stringify(document),
      source: 'server',
      nodeCount: collectAllNodeIds(document).length,
      label: 'server checkpoint',
      lastSeq,
      tombstones: JSON.stringify([...tombstones]),
    },
  });
}

/// Wait until the journal head stops moving (the route bundle's writeChain
/// is not awaitable from THIS module instance — we probe instead). Returns
/// the stable head, or the last-seen head after the round budget (a live
/// run keeps it moving; callers avoid checkpointing mid-run anyway).
async function awaitJournalQuiescence(documentId: string): Promise<number> {
  await flushJournal(); // flush THIS instance's chain (user patches).
  let head = await getJournalLastSeq(documentId).catch(() => 0);
  for (let i = 0; i < QUIESCE_ROUNDS; i++) {
    await new Promise((resolve) => setTimeout(resolve, QUIESCE_WAIT_MS));
    const again = await getJournalLastSeq(documentId).catch(() => head);
    if (again === head) return head;
    head = again;
  }
  return head;
}

/// Write a server checkpoint for the CURRENT in-memory document. Called at
/// turn boundaries (after the stream closed) and on the interval tick. The
/// quiescence probe guarantees lastSeq covers every row whose effect the
/// in-memory document already contains (a row landing after the probe gets
/// a seq > lastSeq and re-folds on the next cold start — but its effect is
/// in the doc, so it MUST be ≤ lastSeq; hence the wait).
export async function writeServerCheckpoint(
  documentId: string,
  document: CanvasDocument,
  tombstones: Set<string>,
): Promise<{ lastSeq: number; pruned: number } | null> {
  try {
    const lastSeq = await awaitJournalQuiescence(documentId);
    if (lastSeq <= 0) return null;
    await writeCheckpointRow(documentId, document, tombstones, lastSeq);
    const pruned = await maybeCompactJournal(documentId, lastSeq);
    return { lastSeq, pruned };
  } catch {
    return null;
  }
}

/// Prune rows the newest checkpoint fully covers, keeping a safety tail.
/// Runs only when the prunable window is large enough to be worth a
/// deleteMany. Returns rows pruned (0 when skipped).
export async function maybeCompactJournal(
  documentId: string,
  snapshotSeq: number,
): Promise<number> {
  try {
    const floor = snapshotSeq - KEEP_TAIL;
    if (floor <= 0) return 0;
    // Cheap existence probe for prunable rows before issuing the delete.
    const { db } = await import('../db');
    const oldest = await db.agentEvent.findFirst({
      where: { documentId },
      orderBy: { seq: 'asc' },
      select: { seq: true },
    });
    if (!oldest) return 0;
    if (oldest.seq > floor) return 0;
    if (floor - oldest.seq < COMPACT_MIN_ROWS) return 0;
    return await deleteJournalRowsUpTo(documentId, floor);
  } catch {
    return 0;
  }
}

// ---- restore journaling ---------------------------------------------------------

/// Persist a document:restore as durable history: a timeline snapshot row +
/// a tiny `document_restore` journal event pointing at it. The fold applies
/// the event by loading the row, so restores survive restarts (previously a
/// restart re-seeded from "newest snapshot", which a restore did NOT
/// create). Returns the snapshot id, or null on failure (caller keeps the
/// in-memory replace either way — same as today).
export async function journalDocumentRestore(
  documentId: string,
  document: CanvasDocument,
): Promise<string | null> {
  try {
    const { db } = await import('../db');
    const snapshotId = `restore-${documentId}-${Date.now().toString(36)}`;
    await db.documentSnapshot.create({
      data: {
        id: snapshotId,
        documentId,
        document: JSON.stringify(document),
        source: 'restore',
        nodeCount: collectAllNodeIds(document).length,
        label: 'restore',
      },
    });
    // Journal AFTER the row exists — a fold that reads this event must find
    // its snapshot.
    appendSyntheticJournalEvent(documentId, 'document_restore', undefined, { snapshotId });
    return snapshotId;
  } catch {
    return null;
  }
}

// ---- delta context (R9a) ---------------------------------------------------------

/// Node ids changed since `sinceSeq` (per-turn canvas watermark) for the
/// delta LLM context. Returns null when anything global happened (or the
/// window is too big to enumerate) — callers fall back to a full snapshot.
export async function computeChangedNodeIdsSince(
  documentId: string,
  sinceSeq: number,
): Promise<{ nodeIds: string[] | null; throughSeq: number }> {
  try {
    const ids = new Set<string>();
    let after = sinceSeq;
    let throughSeq = sinceSeq;
    let scanned = 0;
    // Page budget: 3 × 1000 rows. Exhausting it with a FULL last page means
    // more rows remain — the window is too big to enumerate, fall back to a
    // full snapshot instead of reporting a partial delta.
    for (let page = 0; page < 3; page++) {
      const rows = await getJournalEvents(documentId, after, FOLD_PAGE);
      if (rows.length === 0) break;
      for (const row of rows) {
        const patch = patchFromRow(row);
        if (patch) {
          const touched = patchTouchedNodeIds(patch);
          if (touched.global) return { nodeIds: null, throughSeq };
          for (const id of touched.ids) ids.add(id);
          scanned++;
        }
        throughSeq = row.seq;
      }
      after = rows[rows.length - 1].seq;
      if (rows.length < FOLD_PAGE) break;
      if (page === 2) return { nodeIds: null, throughSeq };
    }
    if (scanned > 3000) return { nodeIds: null, throughSeq };
    return { nodeIds: [...ids], throughSeq };
  } catch {
    return { nodeIds: null, throughSeq: sinceSeq };
  }
}

/// Newest server checkpoint's lastSeq for a document (null when none) —
/// served by the events API as `snapshotSeq`.
export async function getCheckpointSeq(documentId: string): Promise<number | null> {
  try {
    const { db } = await import('../db');
    const row = await db.documentSnapshot.findFirst({
      where: { documentId, source: 'server' },
      orderBy: { createdAt: 'desc' },
      select: { lastSeq: true },
    });
    return typeof row?.lastSeq === 'number' ? row.lastSeq : null;
  } catch {
    return null;
  }
}
