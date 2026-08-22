# AGENTS.md — `mini-services/canvas-sync/`

## Purpose

A standalone Socket.IO service that maintains per-document canvas state in memory and broadcasts every canvas patch + agent event to every subscribed viewer. This is the live multi-viewer transport; the HTTP `/api/agent` endpoint is the single-viewer fallback.

## Ownership

- `index.ts` — the entire service. Creates an HTTP server, attaches Socket.IO, manages an in-memory `Map<documentId, DocState>`, handles client subscriptions, applies patches, fans out events.
- `package.json` — declares `socket.io` as the only dependency. `bun install` inside this folder to install (separate `bun.lock` from the root).

## Local Contracts

### Transport contract
- **Port**: 3003 (hardcoded in `index.ts`, configured in the root `Caddyfile`, exposed via `XTransformPort`).
- **Path**: `/` (must NOT change — Caddy uses it for routing).
- **CORS**: `origin: '*'` (dev only — tighten for production).
- **Heartbeat**: `pingTimeout: 60000`, `pingInterval: 25000`.
- **EADDRINUSE exits 0**: in the z.ai sandbox, `next dev` boots an in-process copy of this service via `instrumentation.ts` while `.zscripts/dev.sh` also starts this standalone one — whoever binds `:3003` second exits cleanly. A stopped standalone instance with the port still serving is healthy, not a failure. See `docs/zai-sandbox-setup.md`.

### Event protocol
The service speaks the same `ClientEvent` / `SyncEvent` unions defined in `src/lib/canvas/types.ts`. It is a pure relay — it does not invent event kinds. All events are sent/received on the `client` / `sync` socket channels.

**Client → server (`ClientEvent`)**:
- `subscribe` `{ documentId }` — join a document's room. The service sends back a `canvas:full` with current state and broadcasts a `presence` update.
- `canvas:patch` `{ patch }` — apply a canvas patch. The service finds the sender's subscribed document, applies it via `applyPatchToCanvas`, and broadcasts to other subscribers.
- `canvas:request_full` `{ documentId }` — request a full document snapshot. The service responds with `canvas:full`.
- `agent:prompt` `{ documentId, prompt, settings? }` — start an agent run. The service calls `/api/agent` via HTTP fetch (NDJSON stream) and fans out every event to all subscribers.

**Server → client (`SyncEvent`)**:
- `canvas:patch` `{ patch, toolCallId? }` — a canvas mutation was applied.
- `canvas:full` `{ document }` — full document snapshot (sent on subscribe / request).
- `agent:message_start`, `agent:message_delta`, `agent:message_end` — assistant chat stream.
- `agent:thinking_delta` — model thinking tokens.
- `agent:tool_call_start`, `agent:tool_call_end` — tool invocation lifecycle.
- `agent:turn_end` — agent finished processing.
- `agent:error` — agent error.
- `agent:skill_selected`, `agent:plan`, `agent:plan_step_update` — planning/skill events.
- `agent:subagent_dispatch`, `agent:subagent_result` — sub-agent delegation events.
- `presence` `{ viewerCount }` — subscriber count changed.

### In-memory state
- `documents: Map<string, DocState>` where `DocState = { document: CanvasDocument, subscribers: Set<string> }`.
- On `subscribe`: if the document is not in the map, create an empty one. (In production this would load from Prisma; for the demo, the first subscriber triggers an empty document.)
- On `prompt`: the service calls `POST /api/agent` via HTTP fetch, streams the response, and fans out every event to all subscribers.
- Patches are applied to the in-memory document via `applyPatchToCanvas` from `../../src/lib/canvas/patch.ts` — the same pure function the frontend uses.

### Coupling
- This service imports from `../../src/lib/canvas/types.ts` and `../../src/lib/canvas/patch.ts`. Changes to those files affect this service.
- This service calls `/api/agent` (owned by `src/app/api/agent/route.ts`) to run the agent. Changes to the runner or the route contract affect this service.
- The TypeScript import path uses `.ts` extensions (Bun resolves them; Node would not without `--experimental-specifier-resolution=node` or a build step).

### When to use this vs HTTP
- The frontend canvas store prefers this service when available (lower latency, bidirectional).
- If the WebSocket connection fails, the canvas store falls back to `POST /api/agent` (SSE-style chunked response). Both paths produce identical event shapes.
- In the z.ai sandbox the in-process twin (started by `instrumentation.ts` alongside `next dev`) usually owns port 3003; the HTTP fallback covers every other case. Do not assume this standalone process is the one serving.

## Work Guidance

- When changing the event protocol: update `src/lib/canvas/types.ts` (the `SyncEvent` / `ClientEvent` unions), this service's event handlers, the canvas store's `_onSync` handler, and `/api/agent/route.ts`. All four are coupled.
- When changing the port: update `index.ts`, the root `Caddyfile`, and any launch scripts in `scripts/`.
- When adding a new client → server message: add the type, add the socket handler, add the canvas store dispatch.
- Do not add persistence to this service — it is intentionally in-memory. Persistence is the session store's job (via the canvas store bridge).

## Verification

- `cd mini-services/canvas-sync && bun install` — installs `socket.io`.
- `bash scripts/start-canvas-sync.sh` — starts the service on port 3003.
- `curl http://127.0.0.1:3003/` — should return the Socket.IO handshake payload (not a 404).
- Manual: with the service running, open the app — the top status bar should show "connected" (not "local-only").

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `index.ts`, `package.json`, `bun.lock`.
