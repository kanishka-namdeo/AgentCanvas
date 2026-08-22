# AGENTS.md — `src/lib/`

## Purpose

Shared library layer root. Owns the Prisma client singleton and the shared UI utility directly, and indexes the seven lib subfolders that have their own AGENTS.md contracts.

## Ownership

- `db.ts` — Prisma 7 client singleton using the `@prisma/adapter-libsql` driver adapter. Reads `DATABASE_URL` (default `file:./db/custom.db`; the z.ai sandbox forces the absolute `file:/home/z/my-project/db/custom.db` — see `docs/zai-sandbox-setup.md`). Caches the client on `globalThis` in dev to survive Next.js hot reloads. Shared by all Prisma-touching API routes (`/api/sessions*`).
- `utils.ts` — the shadcn `cn()` class-merge helper (clsx + tailwind-merge), the most-imported UI utility in the component tree.

## Local Contracts

- Import shared lib modules from feature code via the `@/lib/...` alias only.
- `db.ts` is the ONLY place a `PrismaClient` may be constructed — never instantiate Prisma elsewhere.
- Schema changes start in `prisma/schema.prisma` + `prisma.config.ts` (repo root), then `bun run db:generate` + `bun run db:push` (see `prisma/AGENTS.md`).

## Work Guidance

- New shared modules that don't fit an existing subfolder land here with an Ownership entry; prefer extending the owning subfolder when one exists.
- A new subfolder becomes a child doc when it grows its own contracts (follow the DOX rules in the root `AGENTS.md`).

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run db:push` — schema in sync (uses the same client config).
- Manual: `curl http://localhost:3000/api/sessions` returns session JSON — proves the db singleton initializes inside a route.

## Child DOX Index

| Path | Scope |
|------|-------|
| `agent/AGENTS.md` | Agent layer: 88-tool surface (tools.ts + pen-tools + figma-tools), native Pi-SDK runner + legacy test runner, classifier/planner, plugin subsystem, sub-agents |
| `agent/skills/AGENTS.md` | Skill system: types, registry (7 skills), progressive disclosure levels |
| `agent/plugins/AGENTS.md` | Plugin registry + 8 ported plugins (32 tools): ask-user-question, todo, memory, mega-compact, goal-list, background-tasks, mcp-adapter, subagents |
| `canvas/AGENTS.md` | Canvas state: Zustand store, types/patches, clipboard, export utilities, gestures hook, Socket.IO service |
| `llm/AGENTS.md` | LLM provider abstraction: 28 providers (26 OpenAI-compatible + 2 native), unified `LLMClient`, registry + factories |
| `pen/AGENTS.md` | .pen format layer: canonical schema (v2.17), tree resolver, document helpers, converters, Pages abstraction |
| `sessions/AGENTS.md` | Session persistence: Zustand localStorage store + server-sync bridge, fork/restore, sweep/enforce |
| `settings/AGENTS.md` | Settings store: AppSettings + AgentRunSettings types, defaults, PALETTES |
| `web/AGENTS.md` | Web search + fetch: 4-provider search chain, 3-backend fetch pipeline, quality gates |
