# AGENTS.md — `src/lib/sessions/`

## Purpose

The session persistence layer: typed models for Session / Run / Message / ToolCallRecord / Snapshot, plus a Zustand store with `persist` middleware (localStorage) that survives reloads and supports fork / restore.

This is the durable record of every conversation the user has had with the agent. The canvas store bridges into this store on every prompt and every event — the session store is the source of truth for "what happened", while the canvas store is the source of truth for "what's on screen right now".

## Ownership

- `types.ts` — `Session`, `Run`, `Message`, `ToolCallRecord`, `Snapshot`, `RunStatus` state machine. Owned by this folder.
- `store.ts` — Zustand store with `persist` (localStorage). Full CRUD for sessions/runs/messages/tool-calls/snapshots. Fork via `parentId` + `forkedFromSnapshotId`. Restore via append-only new snapshot (Lovable model).
- `index.ts` — re-exports `useSessionStore`, `hydrateSessionStore`, and the types.

## Local Contracts

### Data model
```
Session (1) ──< Run (N) ──< Message (N)
                       ──< ToolCallRecord (N)
                       ──< Snapshot (N)
```
- `Session` — a conversation. Has `id`, `title`, `createdAt`, `updatedAt`, `pinned`, `archived`, `starred`, `parentId` (for forks), `forkedFromSnapshotId`.
- `Run` — one agent invocation within a session. Has `id`, `sessionId`, `status` (state machine below), `prompt`, `startedAt`, `endedAt`, `error?`.
- `Message` — one chat turn. Has `id`, `runId`, `role` (`'user' | 'assistant' | 'system'`), `text`, `toolCallIds[]`, `createdAt`.
- `ToolCallRecord` — one tool invocation. Has `id`, `runId`, `name`, `argsPreview`, `result?`, `success?`, `durationMs?`, `startedAt`, `endedAt?`.
- `Snapshot` — a canvas state captured at a point in time. Has `id`, `runId`, `document` (serialized `CanvasDocument`), `createdAt`, `bookmarked`, `label?`.

### Run status state machine
```
queued → in_progress → awaiting_tool → completed
                     ↘                ↘ failed
                                       ↘ cancelled
```
- `queued` — run created, agent not yet started.
- `in_progress` — agent is streaming.
- `awaiting_tool` — agent emitted a tool call, waiting for result (transient in the current shim; the LLM resolves tools inline).
- `completed` — agent emitted `turn_end` cleanly.
- `failed` — agent emitted an error event or threw.
- `cancelled` — user clicked stop (not yet implemented in the UI).

State transitions are append-only: a `completed` run cannot go back to `in_progress`. The store guards against this.

### Persistence
- `persist` middleware with `localStorage` key `agentcanvas.sessions.v1`.
- `skipHydration: true` to avoid SSR hydration mismatches. The canvas store calls `hydrateSessionStore()` explicitly in its `init()` action.
- Schema version is `1`. Bump + add `migrate` if the shape changes.
- The store is the ONLY writer to `localStorage['agentcanvas.sessions.v1']`. Do not write to it directly from components.

### Fork model (mirrors v0)
- `forkSession(parentSessionId, snapshotId)` creates a new Session with `parentId = parentSessionId`, `forkedFromSnapshotId = snapshotId`.
- The fork inherits the snapshot's canvas document but starts with an empty messages array.
- The parent session is untouched.

### Restore model (mirrors Lovable)
- `restoreSnapshot(snapshotId)` does NOT overwrite history. It:
  1. Loads the snapshot's canvas document.
  2. Pushes it into the canvas store.
  3. Creates a NEW Snapshot record (append-only) so the restore itself is auditable.
- This means the snapshot list grows monotonically; restores are visible in the timeline.

### Stats / derived data
- `getStats(sessionId)` returns counts (messages, runs, tool calls, snapshots). It MUST be memoized at the call site — calling it inside a Zustand selector returns a new object every render and triggers an infinite loop. (Prior bug; fixed by switching to `useMemo` over `sessionsMap`.)

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
