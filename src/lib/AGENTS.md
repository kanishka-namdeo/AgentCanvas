# AGENTS.md — `src/lib/`

## Purpose

Shared library layer root. Owns the Prisma client singleton and the shared UI utility directly, and indexes the nine lib subfolders that have their own AGENTS.md contracts (agent, canvas, design-systems, llm, pen, sessions, settings, web, icons) plus the nested agent/skills, agent/plugins, agent/subagents child docs.

## Ownership

- `db.ts` — Prisma 7 client singleton using the `@prisma/adapter-libsql` driver adapter. Reads `DATABASE_URL` (default `file:./db/custom.db`; the z.ai sandbox forces the absolute `file:/home/z/my-project/db/custom.db` — see `docs/zai-sandbox-setup.md`). Caches the client on `globalThis` in dev to survive Next.js hot reloads. Shared by all Prisma-touching API routes (`/api/sessions*`).
- `utils.ts` — the shadcn `cn()` class-merge helper (clsx + tailwind-merge), the most-imported UI utility in the component tree.
- `storage/quota-aware.ts` — shared localStorage write wrapper: detects QuotaExceededError (DOMException name/codes 22 + 1014, string fallback), tracks consecutive failures, escalates toast severity (first failure → warning toast + optional emergency callback; 3+ → persistent banner). Non-quota errors re-throw. Consumed by `sessions/store.ts` (throttled persist) + `settings/store.ts` (custom persist storage). SSR-safe (returns false when `window` is absent). Guarded by `tests/unit/quota-aware.test.ts`.
- `validation/status-enums.ts` — canonical status unions + type guards (`isValidSessionStatus` / `isValidMessageStatus` / `isValidRunStatus` / `isValidToolCallStatus`) mirroring `src/lib/sessions/types.ts`; enforced at the sessions PATCH + messages/runs POST API boundaries (invalid → 400). Guarded by `tests/unit/status-enums.test.ts`.
- `agent-error.ts` — shared agent-error classification (importable from both server and client with no server-only deps). Exports `classifyAgentError(message)` (maps a raw error string to a stable `AgentErrorClass` with `code`, `retryable`, `title`, `hint`), `classifiedAgentError(message)` (the wire shape for `agent:error` SyncEvents), and `agentErrorClassForCode(code)` (client-side display lookup). No Prisma, no Pi-SDK, no fetch — safe in the browser bundle.
- `onboarding/store.ts` — Zustand `useOnboarding` store (persisted to `agentcanvas.onboarding.v1`): tracks first-time user onboarding state (`hasCompleted`, `skipped`, `completedAt`, `selectedTemplateId`); `complete()` / `skip()` / `reset()` actions; `ONBOARDING_TEMPLATES` exports the curated starter prompts with tier badges.
- `icons/` — Lucide icon library runtime: `index.ts` exports `getLucideIcon`, `searchLucideIcons`, `lucidePromptCatalog`, `lucideIconGroupSvg`, `lucideIconInlineSvg` (SVG string emitters for server-side render paths + the agent tool `pen_search_icons`). `lucide-registry.generated.ts` is a GENERATED file (194 curated icons from `lucide-react` `__iconNode` data; do not hand-edit) — regenerate via `npx tsx scripts/generate-lucide-registry.ts` (no package.json script alias; see the script's header + `docs/lucide-icons.md`).

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

## Mistakes & Lessons

### Failure Modes

- Check the Child DOX Index here against the actual subfolder list before relying on it — a new durable subfolder with no row here is invisible to the DOX reader.
- Check that single-file utility folders (`storage/`, `validation/`, `onboarding/`, `icons/`) are still owned from this root before adding a child doc — promoting too early fragments contracts that fit a single Ownership bullet.

### Lessons Learned

- Add a child doc only when a folder grows its own contracts/workflow/quality standards; the parent's Ownership row stays the cheaper home for a single-file folder.
- Do not duplicate the Prisma client or `cn()` helper elsewhere — `db.ts` and `utils.ts` are intentionally the single owners; reach for an existing subfolder's contract before creating a new top-level module.

## Child DOX Index

| Path | Scope |
|------|-------|
| `agent/AGENTS.md` | Agent layer: 104-tool production surface (tools.ts 85 + pen-tools 8 + figma-tools 10 + 1 staged-flow gate), native Pi-SDK runner + legacy test runner, classifier/planner, plugin subsystem, sub-agents |
| `agent/subagents/AGENTS.md` | Isolated-context sub-agents: web-research, design-critic (+vlm), design-brief, variant-generator, multitask |
| `agent/skills/AGENTS.md` | Skill system: types, registry (7 skills), progressive disclosure levels |
| `agent/plugins/AGENTS.md` | Plugin registry + 8 ported plugins (32 tools): ask-user-question, todo, memory, mega-compact, goal-list, background-tasks, mcp-adapter, subagents |
| `canvas/AGENTS.md` | Canvas state: Zustand store, types/patches, clipboard, export utilities, gestures hook, Socket.IO service |
| `llm/AGENTS.md` | LLM provider abstraction: 29 providers (28 named + 1 generic `custom`), unified `LLMClient`, registry + factories |
| `pen/AGENTS.md` | .pen format layer: canonical schema (v2.17), tree resolver, document helpers, converters, Pages abstraction |
| `design-systems/AGENTS.md` | Design-system packs: registry, loader, token export, agent helper (5 packs: shadcn-default, radix-themes, vercel-geist, tailwind-catalyst, mantine-default) |
| `sessions/AGENTS.md` | Session persistence: Zustand localStorage store + server-sync bridge, fork/restore, sweep/enforce |
| `settings/AGENTS.md` | Settings store: AppSettings + AgentRunSettings types, defaults, PALETTES |
| `web/AGENTS.md` | Web search + fetch: 4-provider search chain, 3-backend fetch pipeline, quality gates |
| `icons/AGENTS.md` | Lucide icon library runtime: registry + index helpers (generated catalog + semantic search) |
