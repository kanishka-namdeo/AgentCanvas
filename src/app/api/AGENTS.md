# AGENTS.md — `src/app/api/`

## Purpose

Next.js Route Handlers. Five route families: the `/api/agent` endpoints that run the agent loop server-side (plus question-answers, background-task status, and pending-question polling), the `/api/sessions*` CRUD family for server-side session persistence (Prisma), the `/api/documents/[documentId]/snapshots*` family for the document-scoped canvas snapshot timeline (shared-canvas model — snapshots belong to the canvas, not to a chat), the `/api/plugins` + `/api/mcp` settings-support endpoints, the `/api` health check, and the `/api/pen/import` + `/api/pen/export` .pen file conversion endpoints.

## Ownership

- `agent/route.ts` — the agent run endpoint. Owns the request/response contract with the frontend canvas store.
- `agent/answers/route.ts` — POST: resolves a pending `ask_user_question` tool call (`{toolCallId, answers: string[][], cancelled}`); calls `resolveAskUserQuestion()` from `src/lib/agent/plugins/ask-user-question`. 400 if `toolCallId` missing.
- `agent/background/[id]/route.ts` — GET: background-task status by id (404 if unknown); backed by `getBackgroundTaskStatus()` from `src/lib/agent/plugins/background-tasks`. Polled by the BackgroundTaskList UI.
- `agent/pending/route.ts` — GET: `{ pending: [...] }` list of unanswered `ask_user_question` toolCallIds (frontend polls on reconnect); backed by `getPendingQuestions()`.
- `agent/approvals/route.ts` — POST: resolves a pending destructive-op approval gate (`{toolCallId, decision, edits?}`); backed by the approval-gate plugin's pending map. Same idempotent no-op contract for unknown ids as `plans`.
- `agent/plans/route.ts` — POST: resolves a pending PLAN-mode approval gate (`{planId, decision: 'build' | 'revise', feedback?}`; feedback required for `revise`) — the PlanApprovalCard submits here. GET: `{ pending: [...] }` list of plan ids awaiting a decision (diagnostics twin of `/api/agent/pending`); both backed by `src/lib/agent/plan-gate.ts`.
- `plugins/route.ts` — GET: all agent-plugin manifests (`pluginId, pluginName, description, category, defaultEnabled, toolCount, toolNames`) for Settings → Plugins; backed by `getAllPlugins()`. User toggles live client-side (`enabledPlugins` setting) — not persisted server-side.
- `sessions/route.ts` — GET/POST: server-side session persistence (DB is source of truth, localStorage is cache). GET filters by `documentId` + `status` (default `active`), ordered `lastOpenedAt desc`, with message/run counts (the snapshot `_count` include was dropped — snapshots are document-scoped now); POST creates a session (`documentId` required, else 400).
- `sessions/[id]/route.ts` — GET/PATCH/DELETE: fetch session with messages (asc) + runs (asc) (the snapshots include was dropped — snapshots are document-scoped now), 404 if missing; update title/status/pinned/counters/lastOpenedAt (`snapshotCount` dropped); cascade delete (messages + runs only — snapshots no longer cascade with their session).
- `sessions/[id]/messages/route.ts` — GET/POST: list (asc) or append messages; POST with `messageId` updates an existing message (streaming → complete).
- `sessions/[id]/runs/route.ts` — POST only: create a run, or update an existing one when `runId` is passed (status/errorMessage/toolCallCount/toolCalls); increments `runCount` + bumps `lastOpenedAt`.
- `documents/[documentId]/snapshots/route.ts` — GET/POST: the document-scoped snapshot timeline (shared-canvas model — snapshots belong to the canvas, not to any one chat). GET (`?limit=100`) lists snapshot METADATA only (document JSON excluded — too large; `createdAt desc`). POST creates/upserts a `DocumentSnapshot` from `{id, document, sessionId?, source?, runId?, messageId?, nodeCount?, label?, bookmarked?}` — IDEMPOTENT by the client-supplied `id` (an existing id returns the existing row); validates `document` is an object.
- `documents/[documentId]/snapshots/[id]/route.ts` — GET/PATCH/DELETE: single snapshot. GET returns the snapshot INCLUDING the parsed `document` JSON (404 when missing — the fetch-on-demand path for restoring `remote` placeholders); PATCH updates `{label?, bookmarked?}`; DELETE refuses bookmarked snapshots (400).
- `mcp/[id]/route.ts` — GET/POST: status + `{action: 'connect' | 'disconnect'}` control for one MCP server (placeholder registry via `src/lib/agent/plugins/mcp-adapter`; real MCP SDK wiring is a TODO in code). Used by Settings → MCP Servers.
- `route.ts` — root API health check. Returns a static JSON payload.
- `pen/import/route.ts` — .pen file import endpoint. Converts .pen JSON to CanvasDocument + CanvasPatch ops.
- `pen/export/route.ts` — .pen file export endpoint. Converts CanvasDocument to .pen JSON for download.

## Local Contracts

### `/api/agent` (`agent/route.ts`)

**Request**: `POST /api/agent` with JSON body:
```ts
{
  documentId: string;          // defaults to 'default' if omitted
  prompt: string;              // required — returns 400 if empty
  canvasState: CanvasDocument; // snapshot of the canvas at request time (field name: canvasState)
  settings?: AgentRunSettings; // optional — temperature, maxIterations, planFirst, defaultPalette,
                               //   skillSelectionMode, llmProvider, apiKey, modelName, apiBaseUrl,
                               //   thinkingLevel, enabledPlugins, mcpServers.
                               //   Falls back to DEFAULT_SETTINGS when omitted.
}
```

**Response**: a chunked `application/x-ndjson`-style response (NOT a single JSON blob). Each line is a JSON object with a `type` field:
- `{ type: 'patch', patch: CanvasPatch, toolCallId?: string }`
- `{ type: 'agent_event', event: SyncEvent }`

**Contract**:
- The route MUST start the agent runner via `runAgent({ documentId, prompt, canvas, settings })` from `src/lib/agent/runner.ts`.
- The route MUST stream events as they arrive — do not buffer the entire run before responding.
- The route MUST set `Content-Type: application/x-ndjson; charset=utf-8` and disable buffering (`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`).
- The route uses the `canvasState` field from the request body directly — no DB lookup. If `canvasState` is omitted, a blank default CanvasDocument is used.
- The route MUST close the stream after the runner completes. If the runner throws, emit an `agent_event` with `{ type: 'agent:error', message }` and close the stream (do not return 500 mid-stream — the client is already reading).
- The route is the ONLY server-side consumer of the runner. Do not call the runner from elsewhere.

**HTTP fallback**:
- The frontend canvas store calls this endpoint when the WebSocket connection to `mini-services/canvas-sync/` is unavailable. Both paths MUST produce identical event shapes — the canvas store does not branch on transport.
- When the WebSocket IS available, the canvas store prefers it (lower latency, bidirectional). The HTTP path is the fallback.

### `/api/agent/answers`, `/api/agent/pending`, `/api/agent/background/[id]`, `/api/agent/plans`, `/api/agent/approvals`
- Backed by in-memory plugin state in `src/lib/agent/plugins/` (or `plan-gate.ts` for plans) — no DB. All exist so the browser can interact with blocking/background plugin tools while a run is in flight.
- `/api/agent/answers` resolves the blocked `ask_user_question` tool call (the PluginUI dialog submits here via the canvas store's `submitQuestionAnswers`).
- `/api/agent/pending` is polled on reconnect so a reload doesn't orphan an unanswered question.
- `/api/agent/background/[id]` is polled by the BackgroundTaskList UI while background tasks run.
- `/api/agent/plans` (POST) resolves the PLAN-mode approval triad — `build` hands the approved plan to the runner for a build-toolset execution session, `revise` feeds the user's notes back as the `submit_plan` tool result; (GET) lists pending plan ids for reconnect diagnostics.
- `/api/agent/approvals` (POST) resolves the destructive-op approval card (`approve` / `reject` with optional edits).

### `/api/sessions*` family
- Server-side persistence via Prisma (`db.session`, `db.sessionMessage`, `db.sessionRun` from `src/lib/db`; canvas snapshots live in `db.documentSnapshot` behind the `/api/documents/[documentId]/snapshots*` routes — see below). The DB is the source of truth; the localStorage store (see `src/lib/sessions/AGENTS.md`) is a cache.
- **Client-supplied session id**: POST `/api/sessions` accepts an optional `id` (the client's localStorage session id) and creates the row with THAT id — this keeps client and server rows aligned so child writes never FK-fail. The POST is idempotent: an existing id returns the existing row.
- **Auto-heal**: the runs/messages POST routes accept an optional `documentId` and create the missing parent session shell when absent (see `ensure-session.ts`) — pre-fix localStorage sessions heal on their next write instead of erroring.
- **Upserts**: POST with `runId` (runs) or `messageId` (messages) upserts — creates the row when the server never saw the initial create (previously an unhandled P2025 500).
- **List cap**: GET `/api/sessions` returns at most 50 sessions (most recent first) so a legacy DB of empty shells cannot flood the client merge.
- **Error contract**: all handlers catch errors and return structured JSON (`{ error }`) with 400/404/500 — P2025 on PATCH → 404, on DELETE → idempotent success. No raw Prisma errors in the log.
- All writes go through `src/lib/sessions/server-sync.ts` on the client — do not call these routes ad hoc from components.
- Snapshot list GET (`/api/documents/[documentId]/snapshots`) excludes the `document` JSON (too large for list payloads); the single-snapshot GET includes it (fetch-on-demand for remote placeholders at restore).
- Deleting a session cascades to messages and runs (schema-level `onDelete: Cascade`) but NOT snapshots — `DocumentSnapshot` rows are document-scoped (plain `sessionId` provenance column, no FK), so canvas history survives its chat.

### `/api/documents/[documentId]/snapshots*` family
- The document-scoped snapshot timeline (shared-canvas model): snapshots belong to the CANVAS (`documentId`), with `sessionId`/`messageId`/`runId` provenance columns — deleting a chat never deletes its snapshots. Follows the Next 16 `params: Promise<{...}>` await pattern used by sibling routes.
- `GET /api/documents/[documentId]/snapshots?limit=100` → `{ snapshots: ServerDocSnapshot[] }` — METADATA only (no `document` JSON), `createdAt desc`.
- `POST /api/documents/[documentId]/snapshots` → upsert by client-supplied `id` (idempotent — replays after reconnect don't duplicate rows); validates `document` is an object before stringify; returns `{ snapshot }`.
- `GET /api/documents/[documentId]/snapshots/[id]` → `{ snapshot }` INCLUDING the parsed `document` JSON (404 when missing) — the fetch-on-demand path the canvas store uses when restoring a `remote` placeholder.
- `PATCH /api/documents/[documentId]/snapshots/[id]` body `{ label?, bookmarked? }` → `{ snapshot }`.
- `DELETE /api/documents/[documentId]/snapshots/[id]` → `{ ok: true }`; REFUSES bookmarked snapshots (400).
- The legacy `/api/sessions/[id]/snapshots` route was DELETED (obsolete under the shared-canvas model).

### `/api/plugins` + `/api/mcp/[id]`
- Read-only plugin manifests (GET) and MCP server connect/disconnect control (POST). Both exist to serve SettingsDialog sections 7 (Plugins) and 8 (MCP Servers).
- MCP connect/disconnect currently registers/unregisters a placeholder server — real MCP SDK transport is a tracked TODO.

### `/api` (`route.ts`)
- `GET /api` returns `{ message: "Hello, world!" }`.
- Used by uptime checks and the frontend's initial connectivity probe.
- Do not add side effects (no DB writes, no auth).

### `/api/pen/import` (`pen/import/route.ts`)

**Request**: `POST /api/pen/import` with JSON body:
```ts
{
  pen: PenDocument;           // the .pen file contents
  documentId?: string;        // optional, defaults to 'default'
  mode?: "replace" | "merge"; // optional, defaults to 'replace'
}
```

**Response**: JSON with the converted document and patches:
```ts
{
  document: CanvasDocument;   // the converted canvas document
  patches: CanvasPatch[];     // the patches to apply (clear + bulk_add + tokens + set_theme_axis)
}
```

**Contract**:
- The route MUST validate the .pen document structure using `isPenDocument()`.
- The route MUST convert the .pen document to CanvasDocument using `penToCanvas()`.
- The route MUST resolve the .pen tree to populate `canvas.shapes` using `resolvePenTree()`.
- The route MUST extract variables as tokens using `variablesToTokens()`.
- In `replace` mode, the route MUST emit a `clear` patch before the `bulk_add`.
- The route MUST emit a `bulk_add` patch with the converted children tree.
- The route MUST emit `tokens` and `set_theme_axis` patches if the .pen file contains variables/themes.
- The route MUST catch conversion errors and return a 500 with a structured error message.

### `/api/pen/export` (`pen/export/route.ts`)

**Request**: `POST /api/pen/export` with JSON body:
```ts
{
  document: CanvasDocument;  // the canvas document to export (must have a `shapes` array)
  filename?: string;         // optional, defaults to document.name ?? 'canvas' + '.pen'
}
```

**Response**: JSON file download with `Content-Disposition: attachment` header.

**Contract**:
- The route MUST validate that the request contains a valid CanvasDocument with a `shapes` array. Returns 400 if missing.
- The route MUST convert the CanvasDocument to PenDocument using `canvasToPen()`.
- The route MUST serialize the PenDocument using `serializePenDocument()`.
- The route MUST set `Content-Type: application/json; charset=utf-8` and `Content-Disposition: attachment; filename="..."` headers.
- The route MUST catch conversion errors and return a 500 with a structured error message.

### General API rules
- All routes are server-side — no `'use client'`.
- All routes MUST validate the request body shape before dispatching. Return 400 on malformed input.
- All routes MUST catch top-level errors and return a structured error response — never let an exception propagate as a 500 with a stack trace in production.
- Do not add new API routes without a parent-level decision; when adding one, document it here in the same commit.

## Work Guidance

- When changing the event stream shape: update `agent/route.ts`, `src/lib/agent/runner.ts` (`AgentStreamEvent`), `src/lib/canvas/store.ts` (`_onSync` handler), and `mini-services/canvas-sync/index.ts` (broadcast). All four are coupled.
- When changing the session persistence shape: update the routes here, `src/lib/sessions/server-sync.ts` (client bridge), and `prisma/schema.prisma` together.
- When adding auth: add it as a middleware in `src/middleware.ts` (does not exist yet), not per-route. The current app has no auth.
- When debugging a stream that hangs: check that the runner is actually yielding events (add `console.error` in the runner), check that the response headers are set before the first write, check that no proxy between the client and the route is buffering (the dev server does not buffer; production behind Caddy might).

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: `curl -N -X POST http://127.0.0.1:3000/api/agent -H 'Content-Type: application/json' -d '{"documentId":"test","prompt":"create a red rectangle","canvasState":{"id":"test","name":"test","viewport":{},"background":"#fff","shapes":[],"tokens":{"colors":[],"textStyles":[]}}}'` — should stream events until `turn_end` (note the field is `canvasState`, not `canvas`).
- Manual: `curl http://127.0.0.1:3000/api` — should return the health JSON.
- Manual: `curl http://127.0.0.1:3000/api/sessions` — should return `{"sessions":[...]}`.
- Manual: `curl http://127.0.0.1:3000/api/plugins` — should return plugin manifests.
- In the browser: open the app, type a prompt, verify the agent panel streams tokens + tool calls; open Settings → Plugins, verify the plugin list loads.

## Child DOX Index

No child `AGENTS.md` files. This folder contains: `agent/route.ts`, `agent/answers/route.ts`, `agent/approvals/route.ts`, `agent/background/[id]/route.ts`, `agent/client-responses/route.ts`, `agent/pending/route.ts`, `agent/plans/route.ts`, `plugins/route.ts`, `sessions/route.ts`, `sessions/[id]/route.ts`, `sessions/[id]/messages/route.ts`, `sessions/[id]/runs/route.ts`, `documents/[documentId]/snapshots/route.ts`, `documents/[documentId]/snapshots/[id]/route.ts`, `mcp/[id]/route.ts`, `route.ts`, `pen/import/route.ts`, `pen/export/route.ts`.
