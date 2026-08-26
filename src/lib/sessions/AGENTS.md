# AGENTS.md — `src/lib/sessions/`

## Purpose

The session persistence layer: typed models for Session / Run / Message / ToolCallRecord / Snapshot, a Zustand store with `persist` middleware (localStorage) that survives reloads and supports fork / restore, and a server-sync bridge (`server-sync.ts`) to the Prisma-backed `/api/sessions*` + `/api/documents/[documentId]/snapshots*` REST APIs — the server DB is the source of truth; localStorage is the fast cache.

**Shared-canvas model (Figma/Cursor-style)**: the canvas Document is THE shared artifact. A Session is a conversation context attached to a `documentId` — it no longer owns canvas state. Multiple chats attach to one document and mutate ONE canvas; switching chats rebuilds only the transcript, never swaps the document. This store is the durable record of every conversation ("what happened") plus the document-scoped snapshot timeline (the canvas's version history, with per-chat provenance), while the canvas store is the source of truth for "what's on screen right now".

## Ownership

- `types.ts` — `Session`, `Run`, `Message`, `ToolCallRecord`, `Snapshot`, `RunStatus` state machine. Owned by this folder.
- `store.ts` — Zustand store with `persist` (localStorage). Full CRUD for sessions/runs/messages/tool-calls + a DOCUMENT-scoped snapshot registry: `listSnapshots(documentId)`, `captureSnapshot(documentId, document, { sessionId?, source?, sourceRunId?, sourceMessageId?, label?, createdBy? })`, `restoreSnapshot(documentId, snapshotId)` (append-only 'restore' snapshot), and NEW `ingestServerSnapshot` (upserts a server snapshot row into the registry, marking `remote: true` when no document payload came along). Fork is a CONVERSATION fork (`forkSession` — message-prefix copy; `forkSessionFromSnapshot` is REMOVED — its old meaning is now restore). Also `deleteSnapshot` (doc-scoped), `sweepIdleSessions`, `enforceSessionCap`, `estimateLocalStorageUsage` helpers.
- `index.ts` — re-exports `useSessionStore`, `hydrateSessionStore`, `sweepIdleSessions`, `enforceSessionCap`, `estimateLocalStorageUsage`, and the types.
- `server-sync.ts` — client-side bridge from the localStorage session store to the server Prisma API: `/api/sessions*` for sessions/messages/runs (`fetchServerSessions`, `fetchServerSessionsStrict`, `createServerSession`, `updateServerSession`, `deleteServerSession`, `appendServerMessage`, `syncServerRun`, `exportSessionJSONL`) and `/api/documents/[documentId]/snapshots*` for the document snapshot timeline (`captureDocumentSnapshot` — POST, idempotent by client id; `fetchDocumentSnapshots` — list, metadata-only; `fetchDocumentSnapshot` — single, with document JSON; `updateDocumentSnapshot` — PATCH label/bookmark; `deleteDocumentSnapshot` — DELETE). Silently fails when the server is unreachable — localStorage stays the fast cache. The SessionSidebar's export action uses `exportSessionJSONL` (server-backed, `.jsonl`) with a local `.json` fallback.

**Session-id contract (bug fix)**: `createServerSession` passes the client's localStorage session id — the server row is created with the SAME id, so run/message/snapshot syncs never FK-fail. Previously the server generated its own cuid, every child write failed with ForeignKeyConstraintViolation, and the hydrate merge loop re-created a new shell per reload (2,733 orphans at discovery — cleaned by `scripts/cleanup-orphan-sessions.ts`). The merge in `hydrateSessionStore` inserts server sessions DIRECTLY (server id, no `createSession` re-trigger) and skips empty shells (no messages/runs).

**Ghost-session reconciliation (bug fix)**: `hydrateSessionStore` uses `fetchServerSessionsStrict` (returns `null` on unreachable/non-OK vs the authoritative array — plain `fetchServerSessions` collapses both to `[]` and cannot drive deletion decisions). When the server answers for a document, local EMPTY sessions (no messages/runs) whose ids are missing from the server list are swept from the store — these are rows deleted server-side (another device, the orphan cleanup script) that previously lingered in the sidebar forever and could re-create orphan rows when clicked. Never swept: sessions with local content (possible unsynced offline work) and the ACTIVE session (ensure-session re-creates its server row on next activity — idempotent self-heal). Guarded by `tests/unit/ghost-session-reconcile.test.ts`.

**Document-snapshot hydration (shared canvas)**: after the session merge, `hydrateSessionStore` ALSO merges server document-snapshot metadata — for each known documentId it calls `fetchDocumentSnapshots` and `ingestServerSnapshot`s every server snapshot missing locally (metadata-only `remote: true` placeholders; the heavy `document` JSON is fetched on demand at restore). Local snapshots are never swept.

## Local Contracts

### Data model
```
Document (1) ──< Session (N) ──< Run (N) ──< Message (N)
              │                         ──< ToolCallRecord (N)
              └──< Snapshot (N)    // document-scoped; sessionId = provenance
```
- `Session` — a conversation context on a shared canvas (no longer owns canvas state). Has `id`, `documentId`, `title`, `status` (`'active' | 'archived'`), `pinned`, `starred`, `parentId`, `forkedFromMessageId`, `forkedFromSnapshotId` (always `null` under the shared-canvas model — kept for compat), `isRoot`, `currentRunId`, `lastRunId`, `model`, `messageCount`, `runCount`, `toolCallCount`, `messageIds[]`, `runIds[]`, `createdAt`, `updatedAt`, `lastOpenedAt`, `archivedAt`. NOTE: `currentSnapshotId` and `snapshotIds` are REMOVED — sessions do not track snapshots.
- `Run` — one agent invocation within a session. Has `id`, `sessionId`, `status` (state machine below), `trigger` (`'user_message' | 'resume' | 'retry' | 'fork' | 'restore'`), `prompt`, `model`, `toolCallIds[]`, `stepCount`, `errorMessage`, `resultMessageId`, `createdAt`, `startedAt`, `completedAt`, `cancelledAt`, `durationMs`.
- `Message` — one chat turn. Has `id`, `sessionId`, `runId`, `role` (`'user' | 'assistant' | 'system' | 'tool'`), `text`, `toolCalls[]` (embedded `ToolCallRecord` objects), `status` (`'streaming' | 'complete' | 'error' | 'cancelled'`), `error?`, `snapshotId`, `createdAt`, `completedAt`.
- `ToolCallRecord` — one tool invocation. Has `id`, `runId`, `sessionId`, `messageId`, `stepIndex`, `name`, `argsPreview`, `status` (`'pending' | 'running' | 'success' | 'error' | 'cancelled'`), `summary`, `patchSummary`, `startedAt`, `endedAt`, `durationMs`.
- `Snapshot` — a canvas state captured at a point in time, scoped to a DOCUMENT (the timeline belongs to the canvas). Has `id`, `documentId` (owning document), `sessionId` (provenance — the chat whose turn produced it; informational, may reference a since-deleted session, null for system captures), `parentSnapshotId`, `source` (`'turn_end' | 'fork' | 'restore' | 'manual'`), `sourceRunId`, `sourceMessageId`, `document` (serialized `CanvasDocument`), `nodeCount`, `label`, `bookmarked`, `remote?` (true when hydrated from the server LIST endpoint, which omits the heavy `document` JSON — a metadata placeholder until `fetchDocumentSnapshot` fills it in on restore; boot-time latest-snapshot hydration skips remote entries), `createdAt`, `createdBy` (`'agent' | 'user' | 'system'`).

### Run status state machine
```
queued → in_progress → awaiting_tool → in_progress (loop per tool)
           ↘                            ↘
        cancelling → cancelled        completed | failed | incomplete
```
- `queued` — run created, agent not yet started.
- `in_progress` — agent is streaming.
- `awaiting_tool` — agent emitted a tool call, waiting for result.
- `cancelling` — cancel requested while in progress or awaiting tool.
- `cancelled` — cancel finalized.
- `completed` — agent emitted `turn_end` cleanly.
- `failed` — agent emitted an error event or threw.
- `incomplete` — run ended without a clean completion (partial result).

State transitions are append-only: a `completed` run cannot go back to `in_progress`. The store guards against this.

### Persistence
- `persist` middleware with `localStorage` key `agentcanvas.sessions.v1` (key unchanged).
- `skipHydration: true` to avoid SSR hydration mismatches. The canvas store calls `hydrateSessionStore()` explicitly in its `init()` action.
- Schema version is `2`. The v1 → v2 `migrate` re-keys session-owned snapshots to document scope: each snapshot's `documentId` is derived from its owner session's `documentId` (fallback `'demo'`), `sessionId` is kept as provenance, `remote` is forced `false`; `currentSnapshotId` + `snapshotIds` are stripped from every session.
- `hydrateSessionStore()` merges server document-snapshot metadata after the session merge (see Document-snapshot hydration under Ownership above).
- The store is the ONLY writer to `localStorage['agentcanvas.sessions.v1']`. Do not write to it directly from components.

### Fork model (conversation fork — shared canvas)
- `forkSession(parentSessionId, fromMessageId)` creates a new Session with `parentId = parentSessionId`, `forkedFromMessageId`, `forkedFromSnapshotId: null`, `isRoot: false`, title `Fork of <parent>` — then copies the parent's MESSAGE PREFIX (all messages, or up to & including `fromMessageId` when found) as NEW messages (new ids, `sessionId` = fork id, `runId: null`, `toolCalls: []`, streaming → complete). Runs and toolCalls are NOT copied.
- The fork is a conversation fork only: the canvas is untouched — parent and fork share ONE document. Sets `activeSessionByDoc[doc] = fork.id`.
- `forkSessionFromSnapshot` is REMOVED — its old meaning (seed a chat from a past canvas state) is now `restoreSnapshot` + the canvas store's restore action.
- The parent session is untouched.

### Restore model (document-scoped, append-only)
- `restoreSnapshot(documentId, snapshotId)` does NOT overwrite history and does NOT mutate any session. It:
  1. Guards that the snapshot belongs to `documentId`.
  2. Appends a NEW document-scoped Snapshot (deep copy of the target document, `source: 'restore'`, `createdBy: 'user'`, label `Restored from <label|id>`) — the restore itself is auditable — and server-syncs it via `captureDocumentSnapshot` (fire-and-forget).
- The canvas store's `restoreSnapshot(snapshotId)` action drives this, swaps the live document, and broadcasts a `document:restore` ClientEvent so all viewers follow (see `../canvas/AGENTS.md`).
- The document's snapshot timeline grows monotonically; restores are visible in the timeline.

### Snapshot management (document-scoped)
- `captureSnapshot(documentId, document, opts)` — appends a document-scoped snapshot (`parentSnapshotId` = the document's newest existing snapshot; `nodeCount = document.shapes.length`; NO session mutation). Called automatically on `turn_end` / `stopAgent` (respecting `snapshotCadence` setting) and manually via the History panel's "Capture current state" button. Server-syncs via `captureDocumentSnapshot` (fire-and-forget).
- `deleteSnapshot(snapshotId)` — permanently deletes a snapshot from the document registry. Refuses to delete bookmarked snapshots (the user marked them as keepers). NO session bookkeeping. Server-syncs via `deleteDocumentSnapshot` (fire-and-forget).
- `bookmarkSnapshot` / `labelSnapshot` — unchanged locally, plus fire-and-forget `updateDocumentSnapshot` sync.
- When the per-document cap (`maxSnapshotsPerCanvas` setting) is exceeded, the canvas store's `turn_end` handler auto-deletes the document's oldest non-bookmarked snapshots via `deleteSnapshot()` (remote placeholders are excluded from the cap count).
- `deleteSession(id)` cascades messages/runs/toolCalls but NOT snapshots — deleting a chat never deletes the canvas's version history. `clearAllForDocument(documentId)` deletes all sessions AND all snapshots of the document.

### Session lifecycle helpers (standalone functions)
- `sweepIdleSessions(threshold)` — archives any active session whose `lastOpenedAt` is older than the given threshold ('never' / '7d' / '30d'). Called on app mount in `page.tsx`. Returns the count archived.
- `enforceSessionCap(maxRetained)` — archives the oldest non-pinned, non-starred active sessions when the total count exceeds `maxRetained`. Pinned + starred sessions are protected. Called on app mount in `page.tsx`. Returns the count archived.
- `estimateLocalStorageUsage()` — returns byte sizes for `agentcanvas.sessions.v1`, `agentcanvas.settings.v1`, and `agentcanvas-theme` localStorage keys, plus `total` and `percentageOfQuota` (currently always `null`). Used by the Settings dialog's "Storage usage" display.

### Stats / derived data
- `getStats(documentId?)` returns a `SessionStats` object (totalSessions, activeSessions, archivedSessions, totalRuns, totalMessages, totalToolCalls, totalSnapshots — document-scoped count under the shared-canvas model). Optionally filtered by `documentId`. It MUST be memoized at the call site — calling it inside a Zustand selector returns a new object every render and triggers an infinite loop. (Prior bug; fixed by switching to `useMemo`.)

## Work Guidance

- When adding a new message role: update `types.ts`, the `persist` migrate function, and the `MessageRole` union in `components/sessions/RunHistoryPanel.tsx`.
- When adding a new run status: update the state machine diagram above, the `StatusBadge` color map, and the `RunHistoryPanel` filter.
- When changing the localStorage schema: bump the persist version, write a `migrate` function, test that an old localStorage payload upgrades cleanly.
- The session store is read-heavy from the UI — prefer `useMemo` over selectors that return new objects.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: create a session, run the agent, reload the page — the session + messages + tool calls + snapshots MUST reappear.
- Manual: fork a chat — the fork copies the parent's message prefix (no runs/tool calls) and shares the same canvas.
- Manual: restore a snapshot — a new 'restore' snapshot should appear in the document timeline, the shared canvas should revert, and other viewers should follow.
- Check `localStorage['agentcanvas.sessions.v1']` in the browser console — should be a single JSON blob with the full store shape.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../agent/AGENTS.md` (Agent layer), `../canvas/AGENTS.md` (Canvas state).*
