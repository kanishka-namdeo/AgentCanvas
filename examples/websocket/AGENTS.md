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

- Treat as read-only reference material; the real service is `mini-services/canvas-sync/`.

## Verification

- None — reference only. (Do NOT start it; see port collision warning.)

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
