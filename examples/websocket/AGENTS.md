# AGENTS.md — `examples/websocket/`

## Purpose

Reference z.ai-scaffold Socket.IO chat demo (server + React client). Not wired into the app — it exists to illustrate the sandbox gateway's WebSocket routing pattern.

## Ownership

- `server.ts` — reference Socket.IO chat server: port 3003, path `'/'`, CORS `*`.
- `frontend.tsx` — reference React chat client connecting via `io('/?XTransformPort=3003')` — the canonical example of the gateway port-routing pattern required in the z.ai sandbox.

## Local Contracts

- **Port collision warning**: this demo hardcodes port 3003, which collides with the canvas-sync service — and unlike canvas-sync it has NO EADDRINUSE handler. NEVER run it alongside the app.
- Browser clients must use `io('/?XTransformPort=<port>')` — never `io('http://localhost:<port>')` (see root `AGENTS.md` "z.ai Sandbox Operations").
- `eslint.config.mjs` ignores `examples/**` — do not copy lint-exempt patterns into `src/`.

## Work Guidance

- Treat as read-only reference material; the real service is now the in-process `src/lib/canvas/server.ts` (the standalone `mini-services/canvas-sync/` was deleted, leaving only `.gitkeep`).

## Verification

- None — reference only. (Do NOT start it; see port collision warning.)

## Mistakes & Lessons

### Failure Modes

- Check that port `:3003` is free (and that the real app is not running) before starting this demo, because it hardcodes the same port the in-process canvas-sync service uses and has no EADDRINUSE handler.

### Lessons Learned

- Do not run this demo alongside the app, because the standalone `mini-services/canvas-sync/` service was deleted for exactly this collision and the in-process twin in `src/lib/canvas/server.ts` now owns `:3003`.
- Treat this folder as read-only reference for the gateway `XTransformPort` routing pattern; do not lift its code into `src/`, because `eslint.config.mjs` deliberately ignores `examples/**`.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
