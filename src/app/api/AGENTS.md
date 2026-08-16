# AGENTS.md — `src/app/api/`

## Purpose

Next.js Route Handlers: the `/api/agent` endpoint that runs the agent loop server-side and streams events back to the browser, and the `/api` health-check endpoint.

## Ownership

- `agent/route.ts` — the agent run endpoint. Owns the request/response contract with the frontend canvas store.
- `route.ts` — root API health check. Returns a static JSON payload.

## Local Contracts

### `/api/agent` (`agent/route.ts`)

**Request**: `POST /api/agent` with JSON body:
```ts
{
  documentId: string;
  prompt: string;
  canvas: CanvasDocument;  // snapshot of the canvas at request time
}
```

**Response**: a chunked `text/event-stream`-style response (NOT a single JSON blob). Each chunk is a serialized `AgentStreamEvent`:
- `{ kind: 'patch', patch: CanvasPatch, toolCallId?: string }`
- `{ kind: 'agent_event', event: SyncEvent }`

**Contract**:
- The route MUST start the agent runner via `runAgent(options)` from `src/lib/agent/runner.ts`.
- The route MUST stream events as they arrive — do not buffer the entire run before responding.
- The route MUST set `Content-Type: text/event-stream` and disable buffering (`Cache-Control: no-cache, no-transform`, `Connection: keep-alive`).
- The route MUST handle the case where the canvas store sent a stale `documentId` — load the document via `getCanvasDocument(documentId)` from `src/lib/canvas/server.ts`, fall back to the `canvas` field in the request body if the DB has no such document.
- The route MUST emit a final `turn_end` event and close the stream. If the runner throws, emit an `error` event with the message and a 200 status (do not return 500 mid-stream — the client is already reading).
- The route is the ONLY server-side consumer of the runner. Do not call the runner from elsewhere.

**HTTP fallback**:
- The frontend canvas store calls this endpoint when the WebSocket connection to `mini-services/canvas-sync/` is unavailable. Both paths MUST produce identical event shapes — the canvas store does not branch on transport.
- When the WebSocket IS available, the canvas store prefers it (lower latency, bidirectional). The HTTP path is the fallback.

### `/api` (`route.ts`)
- `GET /api` returns `{ ok: true, service: 'agentcanvas', time: <epoch_ms> }`.
- Used by uptime checks and the frontend's initial connectivity probe.
- Do not add side effects (no DB writes, no auth).

### General API rules
- All routes are server-side — no `'use client'`.
- All routes MUST validate the request body shape before dispatching. Return 400 on malformed input.
- All routes MUST catch top-level errors and return a structured error response — never let an exception propagate as a 500 with a stack trace in production.
- Do not add new API routes without a parent-level decision. The current surface is intentionally minimal.

## Work Guidance

- When changing the event stream shape: update `agent/route.ts`, `src/lib/agent/runner.ts` (`AgentStreamEvent`), `src/lib/canvas/store.ts` (`_onSync` handler), and `mini-services/canvas-sync/index.ts` (broadcast). All four are coupled.
- When adding auth: add it as a middleware in `src/middleware.ts` (does not exist yet), not per-route. The current app has no auth.
- When debugging a stream that hangs: check that the runner is actually yielding events (add `console.error` in the runner), check that the response headers are set before the first write, check that no proxy between the client and the route is buffering (the dev server does not buffer; production behind Caddy might).

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: `curl -N -X POST http://127.0.0.1:3000/api/agent -H 'Content-Type: application/json' -d '{"documentId":"test","prompt":"create a red rectangle","canvas":{"id":"test","name":"test","viewport":{},"background":"#fff","shapes":[],"tokens":{"colors":[],"textStyles":[]}}}'` — should stream events until `turn_end`.
- Manual: `curl http://127.0.0.1:3000/api` — should return the health JSON.
- In the browser: open the app, type a prompt, verify the agent panel streams tokens + tool calls.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `agent/route.ts`, `route.ts`.
