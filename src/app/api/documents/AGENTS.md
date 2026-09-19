# AGENTS.md — `src/app/api/documents/`

## Purpose

The `/api/documents*` family — documents (canvas containers) and their document-scoped resources: agent-run status, the append-only event journal, the snapshot timeline (shared-canvas model — snapshots belong to the canvas, not to any one chat), and variant promotion (designer-workflow-parity: promoting a parked variant from Explorations into the active page).

## Ownership

- `route.ts` — GET: list documents (most recent first).
- `[documentId]/route.ts` — GET/PATCH (rename + viewport + background)/DELETE: one document (id + name + viewport + background). PATCH upserts a missing row (UI-audit round 2 — the seed 'demo' document has no DB row until the user renames it; the rename materializes it server-side under the same id).
- `[documentId]/agent/status/route.ts` — GET: live agent-run status for the document (run registry + event-journal tail; drives `RunStopButton` + reconnect recovery).
- `[documentId]/events/route.ts` — GET `?afterSeq=N&limit=M`: the append-only agent event journal feed (reconnect catch-up, mutation clocks).
- `[documentId]/snapshots/route.ts` — GET/POST: the document-scoped snapshot timeline. GET (`?limit=100`) lists snapshot METADATA only (document JSON excluded — too large; `createdAt desc`). POST creates/upserts a `DocumentSnapshot` from `{id, document, sessionId?, source?, runId?, messageId?, nodeCount?, label?, bookmarked?}` — IDEMPOTENT by the client-supplied `id` (an existing id returns the existing row); validates `document` is an object.
- `[documentId]/snapshots/[id]/route.ts` — GET/PATCH/DELETE: single snapshot. GET returns the snapshot INCLUDING the parsed `document` JSON (404 when missing — the fetch-on-demand path for restoring `remote` placeholders); PATCH updates `{label?, bookmarked?}`; DELETE refuses bookmarked snapshots (400).
- `[documentId]/variants/promote/route.ts` — POST: promotes a parked variant from the Explorations page into the active page. Request body: `{ sectionId: string }` (the parked section node id from `agent:alternatives_parked`). Resolves the section, journals a `variant_promote` row (payload `{ sectionId, fromPage, toPage }` — the semantic audit record; the fold replays it idempotently), removes the active page's existing children, and copies the parked section's children into the active page. Returns `{ ok: true, document }` (the updated document JSON — the canvas store adopts it via `promoteAlternative` and broadcasts `document:restore`). 400 if `sectionId` is missing or the section doesn't exist; 409 if the document is busy (an agent run is live). The route reuses the `document:restore` broadcast path (components never emit socket events directly) — the promote route's journal row is the durable record; the broadcast is the live-sync signal.

## Local Contracts

- All routes are server-side — no `'use client'`.
- All routes follow the Next 16 `params: Promise<{...}>` await pattern (params are async).
- **Shared-canvas model**: snapshots belong to the CANVAS (`documentId`), with `sessionId`/`messageId`/`runId` provenance columns — deleting a chat never deletes its snapshots.
- **Snapshot list GET excludes `document` JSON** (too large for list payloads); the single-snapshot GET includes it (fetch-on-demand for `remote` placeholder restores).
- **Snapshot POST is idempotent by client-supplied `id`** — replays after reconnect don't duplicate rows.
- **Snapshot DELETE refuses bookmarked snapshots** (400) — bookmarked snapshots are protected from accidental loss.
- **Variant promote is journaled, not directly applied** — the `variant_promote` journal row is the durable record; the broadcast is the live-sync signal. The fold replays it idempotently.
- **Variant promote refuses if the document is busy** (an agent run is live) — returns 409 to prevent write conflicts with an in-flight agent.
- All routes MUST validate the request body shape before dispatching. Return 400 on malformed input.
- All routes MUST catch top-level errors and return a structured error response — never let an exception propagate as a 500 with a stack trace in production.

## Work Guidance

- When changing the snapshot shape: update `[documentId]/snapshots/route.ts`, `[documentId]/snapshots/[id]/route.ts`, the canvas store's snapshot restore path, AND `prisma/schema.prisma` together.
- When changing the event journal shape: update `[documentId]/events/route.ts`, `src/lib/agent/journal.ts`, and the canvas store's reconnect catch-up handler together.
- When adding a new document-scoped resource: add the route under `[documentId]/<resource>/`, document it here, and decide whether it needs a journal entry (semantic audit record) or just a direct DB write.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: `curl http://127.0.0.1:3000/api/documents` — should return `{ documents: [...] }`.
- Manual: `curl http://127.0.0.1:3000/api/documents/<id>` — should return the document row.
- Manual: `curl http://127.0.0.1:3000/api/documents/<id>/snapshots?limit=10` — should return `{ snapshots: [...] }` (metadata only, no `document` JSON).
- Manual: `curl http://127.0.0.1:3000/api/documents/<id>/snapshots/<sid>` — should return `{ snapshot: { ..., document: {...} } }` (with parsed `document` JSON).
- Manual: `curl 'http://127.0.0.1:3000/api/documents/<id>/events?afterSeq=0&limit=50'` — should return the journal tail.

## Mistakes & Lessons

### Failure Modes

- Check that `document` is an object before `JSON.stringify` on snapshot POST — large or non-object payloads would 500 mid-write.
- Check that the snapshot POST is idempotent by client-supplied `id` — replays after reconnect must not duplicate rows.
- Check that snapshot DELETE refuses bookmarked snapshots (400) — without this, a misclick destroys a curated restore point.
- Check that variant promote refuses when the document is busy (409) — applying a promote mid-run corrupts the agent's view of the canvas.
- Check that `[documentId]/events` GET respects `afterSeq` + `limit` — a missing `afterSeq` returns the full journal tail (potentially huge).

### Lessons Learned

- Do document-scoped snapshots (sessionId is a provenance column with no FK) — deleting a chat MUST NOT delete its snapshots; the shared-canvas model means canvas history survives its chat. (The legacy `/api/sessions/[id]/snapshots` route was DELETED for this reason.)
- Do snapshot list GET WITHOUT the `document` JSON — the JSON is too large for list payloads; fetch it on demand from the single-snapshot GET.
- Do PATCH upserts on `/api/documents/[documentId]` (missing row materializes server-side) — the seed 'demo' document had no DB row until the user renamed it, and the PATCH used to fail with a 404.
- Do journal + broadcast for variant promote (NOT a direct DB write) — the journal row is the durable, replayable audit record; the broadcast is just the live-sync signal. Without the journal, a mid-promote reload would lose the intent.

## Child DOX Index

No child AGENTS.md files. Direct children are individual `route.ts` files under `[documentId]/` subfolders (`agent/status/`, `events/`, `snapshots/`, `snapshots/[id]/`, `variants/promote/`) — each is a single route handler with no subroutes, all documented in the Ownership section above.
