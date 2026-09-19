# AGENTS.md — `src/app/api/design-systems/`

## Purpose

Read-only design-system pack registry. Lists available design-system packs (each pack ships metadata + a `tokens.css` of CSS custom properties that components can opt into). Drives the Settings → Design Systems tab.

## Ownership

- `route.ts` — GET: design-system pack registry (names + metadata). Returns `{ designSystems: [...] }`.
- `[name]/route.ts` — GET: one pack's full metadata (404 if unknown).
- `[name]/tokens/route.ts` — GET: one pack's `tokens.css` (text/css; 404 if the pack is unknown).

## Local Contracts

- All routes are server-side — no `'use client'`.
- All routes are READ-ONLY. No POST/PATCH/DELETE — the pack registry is a static asset, not user-editable.
- All routes follow the Next 16 `params: Promise<{...}>` await pattern.
- The `tokens.css` route MUST set `Content-Type: text/css; charset=utf-8`.
- Unknown pack names return 404 (not an empty 200) — the consumer (`tokens.css` loader) needs a hard signal that the pack is missing, not an empty stylesheet.

## Work Guidance

- When adding a new design-system pack: add the pack definition under `src/lib/design-systems/` (or wherever packs are registered), update the registry's index, and document the pack's tokens here.
- When changing the registry shape: update `route.ts` + the Settings → Design Systems consumer together.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: `curl http://127.0.0.1:3000/api/design-systems` — should return `{ designSystems: [...] }`.
- Manual: `curl http://127.0.0.1:3000/api/design-systems/<name>` — should return the pack metadata, or 404.
- Manual: `curl http://127.0.0.1:3000/api/design-systems/<name>/tokens` — should return `text/css`, or 404.

## Mistakes & Lessons

### Failure Modes

- Check that the `tokens.css` route sets `Content-Type: text/css; charset=utf-8` — a missing or wrong Content-Type makes the browser refuse to apply the stylesheet.
- Check that unknown pack names return 404 (not an empty 200) — the consumer needs a hard signal that the pack is missing.

### Lessons Learned

- Do NOT accept POST/PATCH/DELETE on this family — the pack registry is a static asset; making it user-editable would desync the client cache (which expects the pack list to be stable per build).

## Child DOX Index

No child AGENTS.md files. Direct children are individual `route.ts` files under `[name]/` subfolders (`route.ts`, `tokens/route.ts`) — each is a single route handler with no subroutes, all documented in the Ownership section above.
