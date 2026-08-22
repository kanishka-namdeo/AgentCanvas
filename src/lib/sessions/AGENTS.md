# AGENTS.md — `src/lib/sessions/`

## Purpose

The session persistence layer: typed models for Session / Run / Message / ToolCallRecord / Snapshot, a Zustand store with `persist` middleware (localStorage) that survives reloads and supports fork / restore, and a server-sync bridge (`server-sync.ts`) to the Prisma-backed `/api/sessions*` REST API — the server DB is the source of truth; localStorage is the fast cache.

This is the durable record of every conversation the user has had with the agent. The canvas store bridges into this store on every prompt and every event — the session store is the source of truth for "what happened", while the canvas store is the source of truth for "what's on screen right now".

## Ownership

- `types.ts` — `Session`, `Run`, `Message`, `ToolCallRecord`, `Snapshot`, `RunStatus` state machine. Owned by this folder.
- `store.ts` — Zustand store with `persist` (localStorage). Full CRUD for sessions/runs/messages/tool-calls/snapshots. Fork via `parentId` + `forkedFromSnapshotId`. Restore via append-only new snapshot (Lovable model). Includes `forkSessionFromSnapshot`, `deleteSnapshot`, `sweepIdleSessions`, `enforceSessionCap`, `estimateLocalStorageUsage` helpers.
- `index.ts` — re-exports `useSessionStore`, `hydrateSessionStore`, `sweepIdleSessions`, `enforceSessionCap`, `estimateLocalStorageUsage`, and the types.
- `server-sync.ts` — client-side bridge from the localStorage session store to the server Prisma API (`/api/sessions*`): `fetchServerSessions`, `createServerSession`, `updateServerSession`, `deleteServerSession`, `appendServerMessage`, `syncServerRun`, `captureServerSnapshot`, `exportSessionJSONL`. Silently fails when the server is unreachable — localStorage stays the fast cache. The SessionSidebar's export action uses `exportSessionJSONL` (server-backed, `.jsonl`) with a local `.json` fallback.

## Local Contracts

### Data model
```
Session (1) ──< Run (N) ──< Message (N)
                       ──< ToolCallRecord (N)
                       ──< Snapshot (N)
```
- `Session` — a conversation. Has `id`, `documentId`, `title`, `status` (`'active' | 'archived'`), `pinned`, `starred`, `parentId`, `forkedFromMessageId`, `forkedFromSnapshotId`, `isRoot`, `currentSnapshotId`, `currentRunId`, `lastRunId`, `model`, `messageCount`, `runCount`, `toolCallCount`, `messageIds[]`, `runIds[]`, `snapshotIds[]`, `createdAt`, `updatedAt`, `lastOpenedAt`, `archivedAt`.
- `Run` — one agent invocation within a session. Has `id`, `sessionId`, `status` (state machine below), `trigger` (`'user_message' | 'resume' | 'retry' | 'fork' | 'restore'`), `prompt`, `model`, `toolCallIds[]`, `stepCount`, `errorMessage`, `resultMessageId`, `createdAt`, `startedAt`, `completedAt`, `cancelledAt`, `durationMs`.
- `Message` — one chat turn. Has `id`, `sessionId`, `runId`, `role` (`'user' | 'assistant' | 'system' | 'tool'`), `text`, `toolCalls[]` (embedded `ToolCallRecord` objects), `status` (`'streaming' | 'complete' | 'error' | 'cancelled'`), `error?`, `snapshotId`, `createdAt`, `completedAt`.
- `ToolCallRecord` — one tool invocation. Has `id`, `runId`, `sessionId`, `messageId`, `stepIndex`, `name`, `argsPreview`, `status` (`'pending' | 'running' | 'success' | 'error' | 'cancelled'`), `summary`, `patchSummary`, `startedAt`, `endedAt`, `durationMs`.
- `Snapshot` — a canvas state captured at a point in time. Has `id`, `sessionId`, `parentSnapshotId`, `source` (`'turn_end' | 'fork' | 'restore' | 'manual'`), `sourceRunId`, `sourceMessageId`, `document` (serialized `CanvasDocument`), `nodeCount`, `label`, `bookmarked`, `createdAt`, `createdBy` (`'agent' | 'user' | 'system'`).

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
- `persist` middleware with `localStorage` key `agentcanvas.sessions.v1`.
- `skipHydration: true` to avoid SSR hydration mismatches. The canvas store calls `hydrateSessionStore()` explicitly in its `init()` action.
- Schema version is `1`. Bump + add `migrate` if the shape changes.
- The store is the ONLY writer to `localStorage['agentcanvas.sessions.v1']`. Do not write to it directly from components.

### Fork model (mirrors v0)
- `forkSession(parentSessionId, fromMessageId)` creates a new Session with `parentId = parentSessionId`, `forkedFromSnapshotId = parent.currentSnapshotId`. Seeds the fork from the parent's CURRENT snapshot (latest state).
- `forkSessionFromSnapshot(parentSessionId, snapshotId)` creates a new Session seeded from a SPECIFIC snapshot's document (not the parent's currentSnapshotId). Used by the RunHistoryPanel's "Fork from this snapshot" action + the AgentPanel's "Fork from this message" action (when a matching snapshot is found). The snapshot must belong to the parent session.
- The fork inherits the snapshot's canvas document but starts with an empty messages array.
- The parent session is untouched.

### Restore model (mirrors Lovable)
- `restoreSnapshot(sessionId, snapshotId)` does NOT overwrite history. It:
  1. Creates a NEW Snapshot record (append-only) with `source: 'restore'` and `parentSnapshotId` pointing at the restored snapshot, so the restore itself is auditable.
  2. Sets the session's `currentSnapshotId` to the new snapshot.
- This means the snapshot list grows monotonically; restores are visible in the timeline.

### Snapshot management
- `deleteSnapshot(snapshotId)` — permanently deletes a snapshot. Refuses to delete bookmarked snapshots (the user marked them as keepers). Updates the parent session's `snapshotIds` list. If the session's `currentSnapshotId` was pointing at the deleted snapshot, repoints it to the most recent remaining snapshot.
- `captureSnapshot(sessionId, document, opts)` — captures a canvas state. Called automatically on `turn_end` (respecting `snapshotCadence` setting) and manually via the History panel's "Capture current state" button.
- When `maxSnapshotsPerSession` is exceeded, the canvas store's `turn_end` handler auto-deletes the oldest non-bookmarked snapshots via `deleteSnapshot()`.

### Session lifecycle helpers (standalone functions)
- `sweepIdleSessions(threshold)` — archives any active session whose `lastOpenedAt` is older than the given threshold ('never' / '7d' / '30d'). Called on app mount in `page.tsx`. Returns the count archived.
- `enforceSessionCap(maxRetained)` — archives the oldest non-pinned, non-starred active sessions when the total count exceeds `maxRetained`. Pinned + starred sessions are protected. Called on app mount in `page.tsx`. Returns the count archived.
- `estimateLocalStorageUsage()` — returns byte sizes for `agentcanvas.sessions.v1`, `agentcanvas.settings.v1`, and `agentcanvas-theme` localStorage keys, plus `total` and `percentageOfQuota` (currently always `null`). Used by the Settings dialog's "Storage usage" display.

### Stats / derived data
- `getStats(documentId?)` returns a `SessionStats` object (totalSessions, activeSessions, archivedSessions, totalRuns, totalMessages, totalToolCalls, totalSnapshots). Optionally filtered by `documentId`. It MUST be memoized at the call site — calling it inside a Zustand selector returns a new object every render and triggers an infinite loop. (Prior bug; fixed by switching to `useMemo`.)

## Work Guidance

- When adding a new message role: update `types.ts`, the `persist` migrate function, and the `MessageRole` union in `components/sessions/RunHistoryPanel.tsx`.
- When adding a new run status: update the state machine diagram above, the `StatusBadge` color map, and the `RunHistoryPanel` filter.
- When changing the localStorage schema: bump the persist version, write a `migrate` function, test that an old localStorage payload upgrades cleanly.
- The session store is read-heavy from the UI — prefer `useMemo` over selectors that return new objects.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: create a session, run the agent, reload the page — the session + messages + tool calls + snapshots MUST reappear.
- Manual: fork a session — the new session should have the parent's canvas but no messages.
- Manual: restore a snapshot — a new snapshot should appear in the list, the canvas should revert to the restored state.
- Check `localStorage['agentcanvas.sessions.v1']` in the browser console — should be a single JSON blob with the full store shape.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../agent/AGENTS.md` (Agent layer), `../canvas/AGENTS.md` (Canvas state).*
