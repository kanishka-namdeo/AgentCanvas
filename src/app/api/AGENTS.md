# AGENTS.md — `src/app/api/`

## Purpose

Next.js Route Handlers: the `/api/agent` endpoint that runs the agent loop server-side and streams events back to the browser, the `/api` health-check endpoint, and the `/api/pen/import` and `/api/pen/export` endpoints for .pen file format conversion.

## Ownership

- `agent/route.ts` — the agent run endpoint. Owns the request/response contract with the frontend canvas store.
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
                               //   skillSelectionMode, llmProvider, apiKey, modelName, apiBaseUrl.
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

No child `AGENTS.md` files. This folder contains: `agent/route.ts`, `route.ts`, `pen/import/route.ts`, `pen/export/route.ts`.
