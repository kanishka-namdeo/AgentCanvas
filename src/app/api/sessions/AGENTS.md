# AGENTS.md — `src/app/api/sessions/`

## Purpose

Server-side session persistence for chat sessions (the per-document chat history). DB is the source of truth; the localStorage store in `src/lib/sessions/` is a cache. Covers CRUD, cursor-paginated listing, cross-session search, tags, attachments, and per-session messages + runs.

## Ownership

- `route.ts` — GET/POST at `/api/sessions`. GET filters by `documentId` + `status` (default `active`), ordered `lastOpenedAt desc`, with message/run counts; accepts `?cursor=<ISO lastOpenedAt>` for cursor pagination (fetches cap+1 rows to detect the next page; `nextCursor` null = no more pages; page size ≤ 50). POST creates a session (`documentId` required, else 400); accepts an optional client-supplied `id` and creates the row with that id (idempotent — existing id returns the existing row, so client + server rows stay aligned and child writes never FK-fail).
- `search/route.ts` — GET `?q=...&documentId=...&scope=all|document|session`: cross-session message/prompt search (drives the search palette).
- `ensure-session.ts` — shared helper (NOT a route): creates the missing parent session shell for auto-heal writes from messages/runs POST routes.
- `[id]/route.ts` — GET/PATCH/DELETE: fetch session with messages (asc) + runs (asc); 404 if missing. PATCH updates title/status/pinned/counters/lastOpenedAt. DELETE cascades to messages + runs (schema-level) but NOT snapshots (snapshots are document-scoped — see `src/app/api/documents/`).
- `[id]/messages/route.ts` — GET/POST: list (asc) or append messages; POST with `messageId` upserts (creates the row when the server never saw the initial create — previously an unhandled P2025 500). Accepts optional `documentId` for auto-heal.
- `[id]/runs/route.ts` — POST only: create a run, or update an existing one when `runId` is passed (status/errorMessage/toolCallCount/toolCalls); increments `runCount` + bumps `lastOpenedAt`. Accepts optional `documentId` for auto-heal.
- `[id]/tags/route.ts` — GET: distinct tags across all sessions (sidebar tag filter).
- `[id]/attachments/route.ts` — POST: persists a user message's image attachment (base64 → `Attachment` row).

## Local Contracts

- All writes go through `src/lib/sessions/server-sync.ts` on the client — do not call these routes ad hoc from components.
- **Status enum validation**: `status` fields on PATCH (sessions) + POST (messages, runs) are validated against the canonical unions in `src/lib/validation/status-enums.ts` (`SessionStatus` / `MessageStatus` / `RunStatus`); an invalid value returns 400 instead of being written to the DB and crashing the UI on render.
- **Error contract**: all handlers catch errors and return structured JSON (`{ error }`) with 400/404/500 — P2025 on PATCH → 404, on DELETE → idempotent success. No raw Prisma errors in the log.
- **List cap**: GET `/api/sessions` returns at most 50 sessions (most recent first) so a legacy DB of empty shells cannot flood the client merge; `?cursor=` pages past that.
- **Auto-heal**: messages/runs POST routes accept an optional `documentId` and create the missing parent session shell when absent (via `ensure-session.ts`) — pre-fix localStorage sessions heal on their next write instead of erroring.
- **Upserts**: POST with `runId` (runs) or `messageId` (messages) creates the row when the server never saw the initial create (previously an unhandled P2025 500).
- **Client-supplied id**: POST `/api/sessions` accepts an optional `id` and creates the row with THAT id — keeps client and server rows aligned so child writes never FK-fail. Idempotent: an existing id returns the existing row.
- All routes are server-side — no `'use client'`.
- All routes MUST validate the request body shape before dispatching. Return 400 on malformed input.

## Work Guidance

- When changing the session persistence shape: update the routes here, `src/lib/sessions/server-sync.ts` (client bridge), and `prisma/schema.prisma` together.
- When adding a new session-scoped resource: add the route under `[id]/<resource>/`, document it here, and update `ensure-session.ts` if it needs auto-heal.
- When changing the cap or pagination: update both `route.ts` GET and the client merge logic in `src/lib/sessions/server-sync.ts`.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: `curl http://127.0.0.1:3000/api/sessions` — should return `{ sessions: [...] }` (≤ 50 rows, `nextCursor` set when more exist).
- Manual: `curl 'http://127.0.0.1:3000/api/sessions?cursor=2026-09-01T00:00:00.000Z'` — should return the next page.
- Manual: `curl 'http://127.0.0.1:3000/api/sessions/search?q=red&scope=all'` — should return matching messages.
- Manual: `curl http://127.0.0.1:3000/api/sessions/<id>` — should return the session with messages + runs.

## Mistakes & Lessons

### Failure Modes

- Validate every `status` field against the canonical unions in `src/lib/validation/status-enums.ts` BEFORE writing to the DB — an invalid enum value crashes the UI on the next render.
- Map P2025 on PATCH (sessions) → 404 and on DELETE → idempotent success — bubbling these as 500s breaks the client's auto-heal retries.
- Check that `documentId` is present on POST `/api/sessions` — omitting it returns 400 (the route is per-document, not global).
- Check that the client-supplied `id` (when present) is unique enough to survive a localStorage reset — collisions silently return the existing row, hiding data from the user.

### Lessons Learned

- Do POST upserts (with `runId` / `messageId`) instead of separate create-then-update — the server may have missed the initial create during a reconnect (this was previously an unhandled P2025 500).
- Do idempotent POST on `/api/sessions` (existing client-supplied id returns the existing row) — replays after reconnect must not duplicate rows, and child writes would FK-fail if the parent row was missing.
- Do cursor pagination (`?cursor=<ISO lastOpenedAt>`) on session list GET — a legacy DB of empty shells flooded the client merge under the previous 50-row cap with no way to page past.
- Do auto-heal on `[id]/messages` + `[id]/runs` POST (accept `documentId` and create the missing parent session shell) — pre-fix localStorage sessions errored on their next write instead of healing.
- Deleting a session cascades to messages and runs but NOT snapshots — `DocumentSnapshot` rows are document-scoped (plain `sessionId` provenance column, no FK); canvas history survives its chat. (The legacy `/api/sessions/[id]/snapshots` route was DELETED for this reason.)

## Child DOX Index

No child AGENTS.md files. Direct children are individual `route.ts` files under `search/` and `[id]/` subfolders — each is a single route handler with no subroutes, all documented in the Ownership section above. `ensure-session.ts` is a shared helper, not a route.
