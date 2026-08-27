# Shared Canvas Spec — "Multiple chats per canvas" (Figma/Cursor model)

**Status: BINDING CONTRACT** for the refactor. All implementation tasks (core, server, UI, tests) follow this document. Task IDs: CORE (main agent), S-1 (server), U-1 (UI), T-1 (tests+docs).

## 1. Principles

1. **The canvas Document is THE shared artifact**, keyed by `documentId`. All chat sessions attached to a document mutate ONE canvas.
2. **A Session is a conversation context** (`documentId` FK + messages/runs). It no longer owns canvas state.
3. **`switchSession()` never touches `document`.** Switching chats swaps only the transcript (`turns`) + active pointer.
4. **`newSession()` continues from the current shared canvas** (no EMPTY_DOC reset).
5. **Snapshots are document-scoped** with session provenance (`sessionId`, `sourceRunId`, `sourceMessageId`). Timeline = per-document, append-only.
6. **Restore reverts the shared canvas** (append-only new `'restore'` snapshot) AND broadcasts to other viewers.
7. **Fork = conversation fork.** `forkSession` copies the parent's message prefix (up to `fromMessageId`) into a new chat. Canvas untouched (shared). `forkSessionFromSnapshot` is REMOVED (its old meaning is now `restore`).
8. **Deleting a chat never deletes document snapshots** (they belong to the canvas). `clearAllForDocument` deletes both.

## 2. Type contracts

### `src/lib/sessions/types.ts`

```ts
// Session — REMOVE `currentSnapshotId` and `snapshotIds`. Everything else unchanged.
// Snapshot — re-keyed:
export interface Snapshot {
  id: string;
  /// Owning document — snapshots are document-scoped (shared canvas model).
  documentId: string;
  /// Provenance: the chat whose turn produced this snapshot (informational;
  /// the session may since have been deleted). Null for system captures.
  sessionId: string | null;
  parentSnapshotId: string | null;
  source: SnapshotSource;            // 'turn_end' | 'fork' | 'restore' | 'manual'
  sourceRunId: string | null;
  sourceMessageId: string | null;
  document: CanvasDocument;
  nodeCount: number;
  label: string | null;
  bookmarked: boolean;
  /// True when this entry was hydrated from the SERVER list endpoint, which
  /// omits the heavy `document` JSON — the payload is a metadata placeholder
  /// until `fetchDocumentSnapshot` fills it in on restore. Boot-time
  /// latest-snapshot hydration SKIPS remote entries.
  remote?: boolean;
  createdAt: string;
  createdBy: 'agent' | 'user' | 'system';
}
```

Update the header comment: sessions no longer "contain" snapshots; document owns them.

### `src/lib/canvas/types.ts` — ClientEvent

Add variant: `{ type: 'document:restore'; documentId: string; document: CanvasDocument }`.

### `src/lib/settings/types.ts` + `store.ts`

Rename `maxSnapshotsPerSession: number` → `maxSnapshotsPerCanvas: number` (default 50, comment "Max canvas snapshots per document. Oldest non-bookmarked auto-deleted."). Settings persist `version: 4` with migrate `v3 → v4` mapping `maxSnapshotsPerSession` → `maxSnapshotsPerCanvas` (preserve value; delete old key). Update `useAgentRunSettings` selector + `DEFAULT_SETTINGS`.

## 3. Session store contract (`src/lib/sessions/store.ts`)

State shape: unchanged keys (`sessions`, `runs`, `messages`, `toolCalls`, `snapshots`, `activeSessionByDoc`). `snapshots` registry now holds document-scoped `Snapshot`s.

```ts
// CHANGED signatures (same names):
listSnapshots: (documentId: string) => Snapshot[];   // was sessionId; filter snapshots by documentId, sort createdAt DESC (newest first) — matches old order
captureSnapshot: (documentId: string, document: CanvasDocument, opts?: {
  sessionId?: string | null; source?: SnapshotSource; sourceRunId?: string;
  sourceMessageId?: string; label?: string; createdBy?: 'agent' | 'user' | 'system';
}) => Snapshot;
restoreSnapshot: (documentId: string, snapshotId: string) => Snapshot | undefined;
// REMOVED: forkSessionFromSnapshot
// NEW:
ingestServerSnapshot: (snap: {
  id: string; documentId: string; sessionId: string | null; messageId?: string | null;
  runId?: string | null; source?: string; nodeCount?: number; label?: string | null;
  bookmarked?: boolean; createdAt?: string; document?: CanvasDocument;
}) => Snapshot | undefined;  // upsert into registry (adopt server id); marks remote=true when no document payload
```

Semantics:
- `captureSnapshot(documentId, doc, opts)`: appends to registry; `parentSnapshotId` = newest existing snapshot of that document (by createdAt); `nodeCount = document.shapes.length`; **no session mutation**; server-syncs via `captureDocumentSnapshot` (fire-and-forget, guarded `typeof window`).
- `restoreSnapshot(documentId, snapshotId)`: guard `snap.documentId === documentId`; appends a NEW `'restore'` snapshot (deep copy of target doc, `createdBy: 'user'`, label `Restored from <label|id>`); server-syncs the new snapshot too; returns it.
- `deleteSnapshot(snapshotId)`: registry delete; refuse bookmarked; server-syncs `deleteDocumentSnapshot` (fire-and-forget); NO session bookkeeping.
- `bookmarkSnapshot` / `labelSnapshot`: unchanged locally + NEW fire-and-forget `updateDocumentSnapshot` sync.
- `forkSession(parentId, fromMessageId)`: creates the fork (`parentId`, `forkedFromMessageId`, `forkedFromSnapshotId: null`, `isRoot: false`, title `Fork of <parent>`), then copies the parent's message prefix (all messages, or up to & including `fromMessageId` when found) as NEW messages (`newId('msg')`, `sessionId: fork.id`, `runId: null`, `toolCalls: []`, `snapshotId: null`, `feedback: undefined`, streaming→complete). Runs/toolCalls are NOT copied. Sets `activeSessionByDoc[doc] = fork.id`. No snapshot/canvas changes.
- `deleteSession(id)`: cascades messages/runs/toolCalls (unchanged) but **NOT snapshots**; clears active pointer as before.
- `clearAllForDocument(documentId)`: deletes all sessions AND all snapshots with that documentId.
- `getStats(documentId?)`: `totalSnapshots` = count of snapshots filtered by documentId (or all).
- `makeSession`: drop `currentSnapshotId`/`snapshotIds` fields.
- **Persist**: `version: 2` + `migrate(persisted, version)`: for each snapshot set `documentId` from its owner session (`snapshots[s.sessionId].documentId`, fallback `'demo'`), keep `sessionId` as provenance, set `remote: false`; strip `currentSnapshotId` + `snapshotIds` from every session. Keep key `agentcanvas.sessions.v1` + `skipHydration: true`.
- `hydrateSessionStore()`: session merge unchanged EXCEPT `hasContent` = messages>0 || runs>0 (drop `_count.snapshots`), and the ghost-sweep "empty" check drops `snapshotIds` (messageIds/runIds only). NEW after the session merge: for each known documentId, `fetchDocumentSnapshots(docId)` → for every server snapshot absent locally, `ingestServerSnapshot` (metadata-only, `remote: true`). Never sweeps local snapshots.
- Header comments updated to the shared-canvas model.

### `src/lib/sessions/server-sync.ts`

```ts
// REPLACES captureServerSnapshot:
export async function captureDocumentSnapshot(payload: {
  id: string; documentId: string; sessionId?: string | null; document: unknown;
  source?: string; runId?: string | null; messageId?: string | null;
  nodeCount?: number; label?: string | null;
}): Promise<boolean>  // POST /api/documents/{documentId}/snapshots  (idempotent by id)
export async function fetchDocumentSnapshots(documentId: string): Promise<ServerDocSnapshot[] | null> // GET list (metadata only); null = unreachable
export async function fetchDocumentSnapshot(documentId: string, id: string): Promise<ServerDocSnapshot | null> // GET one (with document JSON)
export async function updateDocumentSnapshot(documentId: string, id: string, updates: { label?: string | null; bookmarked?: boolean }): Promise<boolean> // PATCH
export async function deleteDocumentSnapshot(documentId: string, id: string): Promise<boolean> // DELETE
export interface ServerDocSnapshot {
  id: string; documentId: string; sessionId: string | null; messageId: string | null;
  runId: string | null; source: string; nodeCount: number; label: string | null;
  bookmarked: boolean; createdAt: string; document?: unknown; // present only on single-GET
}
```
`ServerSession`: drop `snapshotCount` and `_count.snapshots`. `updateServerSession` Pick drops `snapshotCount`. All calls silent-fail (existing pattern).

## 4. Canvas store contract (`src/lib/canvas/store.ts`)

- **`init(documentId)`**: unchanged through session pick/create + `set({ activeSessionId })`. Then load the DOCUMENT's newest snapshot: `const latest = ss.listSnapshots(documentId)[0]; if (latest && !latest.remote) set({ document: { ...latest.document, id: documentId } });` else keep current doc (`id` set). No session-title naming. Then `_syncTurnsFromSession()`; socket wiring unchanged.
- **`switchSession(sessionId)`**: keep agentBusy guard (copy: "Stop the agent before switching chats."); validate `session.documentId === documentId`; `setActiveSession`; `set({ activeSessionId, queuedPrompts: [] })`; **NO document swap, NO measuredBounds/checkpoint clearing**; `_syncTurnsFromSession()`.
- **`newSession()`**: `createSession(documentId, { title: 'New chat' })` → `switchSession(session.id)` (now safe — no canvas swap) → return id.
- **`forkActiveSession(fromMessageId)`**: `forkSession(activeSessionId, fromMessageId ?? null)` → `switchSession(fork.id)` → return id. No snapshot lookup.
- **`stopAgent`**: snapshot capture → `captureSnapshot(documentId, document, { sessionId: last.sessionId, source: 'turn_end', sourceRunId, sourceMessageId, createdBy: 'user' })`.
- **`turn_end`**: cadence counter unchanged (`sess.runCount`); capture → `captureSnapshot(documentId, document, { sessionId: last.sessionId, sourceRunId, sourceMessageId, createdBy: 'agent' })`; cap trim → per-document: `const docSnaps = listSnapshots(documentId)` (excluding `remote` entries), if `docSnaps.length >= maxSnapshotsPerCanvas` trim oldest non-bookmarked. Ordering (capture → endRun → queue flush) preserved.
- **NEW action `restoreSnapshot: (snapshotId: string) => Promise<void>`**:
  1. `snap = ss.getSnapshot(id)`; guard `snap.documentId === documentId`.
  2. Resolve doc: if `snap.remote` → `const full = await fetchDocumentSnapshot(documentId, snap.id)`; on failure toast error + return; else `ss.ingestServerSnapshot(full)` and use `full.document`. Else deep-copy `snap.document`.
  3. `ss.restoreSnapshot(documentId, snap.id)` (append-only capture + server sync).
  4. `set({ document: { ...resolvedDoc, id: documentId }, measuredBounds: {}, checkpoints: [], lastCheckpointSignature: null })`.
  5. Broadcast: `socket.emit('client', { type: 'document:restore', documentId, document: get().document })` (only if connected).
- **`_onSync` `canvas:full`**: keep replace, ADD empty-guard: skip when incoming doc is empty (`children` empty AND `shapes.length === 0`) while local doc is non-empty AND `!agentBusy` (protects snapshot-hydrated state from a restarted empty WS service).
- Store interface + JSDoc comments updated.

## 5. Server contract (Task S-1)

### Prisma (`prisma/schema.prisma`)

Replace `SessionSnapshot` with:
```prisma
/// A canvas snapshot — point-in-time capture of a DOCUMENT (shared canvas
/// model). Keyed by documentId; sessionId/messageId/runId are provenance.
model DocumentSnapshot {
  id         String   @id @default(cuid())
  documentId String
  sessionId  String?
  messageId  String?
  runId      String?
  document   String
  source     String   @default("turn_end")
  nodeCount  Int      @default(0)
  label      String?
  bookmarked Boolean  @default(false)
  createdAt  DateTime @default(now())
  @@index([documentId])
  @@index([sessionId])
}
```
`Session` model: drop `snapshotCount` + `snapshots SessionSnapshot[]` relation.

**Migration order (SQLite, no migrations folder):** (1) add `DocumentSnapshot` (keep `SessionSnapshot`) → `bunx prisma db push`; (2) run backfill `scripts/migrate-snapshots-to-doc.ts` (copies every `SessionSnapshot` row → `DocumentSnapshot` with `documentId = session.documentId`, `sessionId = old sessionId`; idempotent — skips when target already migrated); (3) remove `SessionSnapshot` from schema → `bunx prisma db push` (drops the legacy table after data is safe).

### API routes

- **NEW `src/app/api/documents/[documentId]/snapshots/route.ts`**:
  - `GET ?limit=100` → `{ snapshots: ServerDocSnapshot[] }` (NO `document` JSON; orderBy createdAt desc).
  - `POST` body `{ id, document, sessionId?, source?, runId?, messageId?, nodeCount?, label?, bookmarked? }` → upsert by `id` (idempotent; returns `{ snapshot }`). Validate `document` is an object; stringify.
- **NEW `src/app/api/documents/[documentId]/snapshots/[id]/route.ts`**:
  - `GET` → `{ snapshot }` INCLUDING parsed `document` JSON (404 when missing).
  - `PATCH` body `{ label?, bookmarked? }` → `{ snapshot }`.
  - `DELETE` → `{ ok: true }` (refuse when `bookmarked` → 400).
- **`src/app/api/sessions/[id]/snapshots/route.ts`**: DELETE the file (obsolete).
- **`src/app/api/sessions/[id]/route.ts`**: GET include drops `snapshots`; PATCH drops `snapshotCount`.
- **`src/app/api/sessions/route.ts`**: GET `_count` include drops `snapshots`.
- Follow existing route conventions (Next 16 `params: Promise<{...}>` await pattern used by sibling routes — copy it).

### WebSocket services

- **`src/lib/canvas/server.ts`** (in-process, has Prisma access):
  - `subscribe` handler: when `documents` has NO entry for the documentId, seed from DB before replying — dynamic `import('@/lib/db')`, `db.documentSnapshot.findFirst({ where: { documentId }, orderBy: { createdAt: 'desc' } })`, `JSON.parse(row.document)` as `CanvasDocument` (fallback to the current empty doc on any error). Emit `canvas:full` with the seeded doc. Make the handler async.
  - NEW `document:restore` case: `ensureDocument(event.documentId)`; `state.document = event.document`; broadcast `canvas:full` to ALL subscribers of that doc.
- **`mini-services/canvas-sync/index.ts`**: add the same `document:restore` case (no DB seed — standalone flavor).
- **`scripts/cleanup-orphan-sessions.ts`**: session-emptiness check that referenced `snapshots: { none: {} }` → drop that clause (snapshots no longer session-scoped); keep message/run emptiness.

## 6. UI contract (Task U-1)

- **`SessionSidebar.tsx`**: stats memo — `totalSnapshots` now via `getStats(documentId)` (already doc-scoped). Footer copy: "N canvas snapshots". Row-click + busy-disable unchanged (switch no longer swaps canvas — update any tooltip/copy implying canvas state). "Fork this chat" flow unchanged (`forkSession(id, null)` + `switchSession(fork.id)`). Subtitle/copy: chats share one canvas ("Chats in this canvas").
- **`RunHistoryPanel.tsx`** (History tab):
  - Snapshot list: `useSessionStore((s) => s.listSnapshots)(documentId)` (doc-scoped; newest first). Each card shows provenance chat title (`useSessionStore.getState().getSession(snap.sessionId)?.title ?? 'Deleted chat'`).
  - Restore → `useCanvasStore.getState().restoreSnapshot(snap.id)` (async, handles remote fetch + broadcast). REMOVE the old local `setState({ document })` path.
  - REMOVE "Fork from this snapshot" action (superseded by Restore).
  - Wire the previously-stubbed "Delete snapshot" context action → `deleteSnapshot(snap.id)`.
  - "Capture current state" → `captureSnapshot(documentId, document, { sessionId: activeSessionId, source: 'manual', createdBy: 'user' })`.
  - `isActive` (current badge): compare `snap.id` to the newest doc snapshot id.
  - Runs list: unchanged.
- **`SessionHeader.tsx`**: fork buttons keep calling `forkActiveSession` (conversation fork). Update copy/tooltip that implied canvas forking. Empty-state copy: "No active chat — click New chat to begin" fine.
- **`AgentPanel.tsx`**: `forkActiveSession` call sites unchanged semantically (conversation fork). Button copy: "Fork chat from this message" (already correct). `/new-chat` command unchanged. `attachCanvasSnapshot` UNTOUCHED (PNG attach — different feature).
- **`SettingsDialog.tsx`**: `handleClearSnapshots` → iterate `listSnapshots(documentId)` non-bookmarked → `deleteSnapshot`. Rename setting field UI `maxSnapshotsPerSession` → `maxSnapshotsPerCanvas` (label "Max canvas snapshots"). Keep all other settings wiring.
- **`page.tsx`**: no structural change (documentId stays `'demo'`; `init` + `onNewChat` unchanged calls). Only touch if copy/props need it.
- **`TopMenuBar.tsx`**: copy-only if needed.
- **`VersionHistoryDialog.tsx`**: UNTOUCHED (ephemeral checkpoint system, separate by design).
- All user-facing copy must reflect: chats are conversations on ONE shared canvas; snapshots/version history belong to the canvas.

## 7. Test contract (Task T-1)

Update (behavior changes):
- `tests/integration/session-bridge.test.ts` — INVERT switch/newSession assertions: switching sessions PRESERVES `document` (same shapes/identity); newSession does NOT clear canvas; snapshot capture asserts doc-scoped (documentId + sessionId provenance); fork = conversation prefix copy sharing the canvas; deleteSession keeps doc snapshots.
- `tests/integration/conversation.test.ts` — snapshot accumulation via `listSnapshots(documentId)`.
- `tests/integration/pipeline.test.ts` — capture assertions re-keyed.
- `tests/unit/ghost-session-reconcile.test.ts` — fetch stubs drop `_count.snapshots`; add document-snapshot hydration case (GET /api/documents/*/snapshots stub → ingestServerSnapshot merge).
- Any test seeding `currentSnapshotId`/`snapshotIds` or reading them — strip.
- Settings: tests referencing `maxSnapshotsPerSession` → `maxSnapshotsPerCanvas`.

NEW `tests/unit/shared-canvas.test.ts` (the acceptance suite):
1. switchSession preserves document identity + content.
2. newSession keeps canvas; creates empty conversation; is active.
3. captureSnapshot is doc-scoped with session provenance; newest-first listing.
4. restoreSnapshot appends 'restore' snapshot + reverts document (via canvas store action incl. broadcast emit — mock socket).
5. forkSession copies message prefix (runs/toolCalls not copied); canvas unchanged; parent untouched.
6. deleteSession keeps document snapshots.
7. persist migrate v1→v2 (session-owned → doc-scoped; fields stripped).
8. turn_end captures ONE doc snapshot across two different sessions (chats share the canvas lineage).

## 8. DOX updates (Task T-1, binding per root AGENTS.md)

`src/lib/sessions/AGENTS.md`, `src/lib/canvas/AGENTS.md`, `src/app/api/AGENTS.md`, `prisma/AGENTS.md`, `src/components/sessions/AGENTS.md`, `tests/AGENTS.md`, plus README architecture/feature paragraphs describing the chat↔canvas relationship.

## 9. Hard rules (repo conventions)

- No `any` in new code. No `console.log`. `'use client'` on hook files. Append-only snapshots. Follow the AGENTS.md DOX chain for every file touched.
- Keep dependency direction: canvas/store → sessions (never sessions → canvas at runtime; type-only imports OK).
- All server-sync calls: fire-and-forget with silent failure, `typeof window !== 'undefined'` guarded.
