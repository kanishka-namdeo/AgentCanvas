# DOX framework

- DOX is highly performant [AGENTS.md](http://AGENTS.md) hierarchy installed here

- Agent must follow DOX instructions across any edits

## Core Contract

- [AGENTS.md](http://AGENTS.md) files are binding work contracts for their subtrees

- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable [AGENTS.md](http://AGENTS.md) plus every parent [AGENTS.md](http://AGENTS.md) above it

## Read Before Editing

1. Read the root [AGENTS.md](http://AGENTS.md)

2. Identify every file or folder you expect to touch

3. Walk from the repository root to each target path

4. Read every [AGENTS.md](http://AGENTS.md) found along each route

5. If a parent [AGENTS.md](http://AGENTS.md) lists a child [AGENTS.md](http://AGENTS.md) whose scope contains the path, read that child and continue from there

6. Use the nearest [AGENTS.md](http://AGENTS.md) as the local contract and parent docs for repo-wide rules

7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning [AGENTS.md](http://AGENTS.md) when a change affects:

- purpose, scope, ownership, or responsibilities

- durable structure, contracts, workflows, or operating rules

- required inputs, outputs, permissions, constraints, side effects, or artifacts

- user preferences about behavior, communication, process, organization, or quality

- [AGENTS.md](http://AGENTS.md) creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root [AGENTS.md](http://AGENTS.md) is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index

- Child [AGENTS.md](http://AGENTS.md) files own domain-specific instructions and their own Child DOX Index

- Each parent explains what its direct children cover and what stays owned by the parent

- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child [AGENTS.md](http://AGENTS.md) when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards

- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty

- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:

- Purpose

- Ownership

- Local Contracts

- Work Guidance

- Verification

- Child DOX Index

## Style

- Keep docs concise, current, and operational

- Document stable contracts, not diary entries

- Put broad rules in parent docs and concrete details in child docs

- Prefer direct bullets with explicit names

- Do not duplicate rules across many files unless each scope needs a local version

- Delete stale notes instead of explaining history

- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain

2. Update nearest owning docs and any affected parents or children

3. Refresh every affected Child DOX Index

4. Remove stale or contradictory text

5. Run existing verification when relevant

6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child [AGENTS.md](http://AGENTS.md)

## z.ai Sandbox Operations

- This repo targets the z.ai sandbox, where the project root is `/home/z/my-project` — never a subdirectory. The one-shot bring-up runbook (scaffold replacement, `DATABASE_URL` override, process-survival rules, gateway ports, restart persistence, verification) is in `docs/zai-sandbox-setup.md`. Read it before any sandbox bring-up or restart debugging.
- The sandbox host kills every descendant of an agent tool call when it ends. Launch the dev server only via `scripts/start-dev.sh` (orphan-to-init pattern) — bare `nohup`/`setsid`/`disown` background jobs do not survive. `scripts/setup-zai-sandbox.sh` is the one-shot wrapper (env + install + DB + start + verify + persist).
- Only port `:81` (Caddy gateway) is externally exposed: default → `:3000`, other ports via `?XTransformPort=<port>`. Browser code uses relative URLs only. The only user-visible route is `/`; users preview via the Preview Panel, never localhost links.
- The project directory is ephemeral across container restarts; `/home/sync/repo.tar` is the persistence layer and boot auto-runs `.zscripts/dev.sh`. After durable changes, refresh the archive: `bash scripts/setup-zai-sandbox.sh --archive`.
- Never `bun run build` / `next start` in the sandbox — the boot flow supports the dev server on port 3000 only.

## Child DOX Index

| Path | Scope |
|------|-------|
| `src/app/AGENTS.md` | Next.js App Router: root layout, main page (tabbed 3-column layout), global styles with `--ac-*` design tokens + `[data-density="compact"]` rules |
| `src/app/api/AGENTS.md` | API routes (14): `/api/agent` (NDJSON agent run) + answers/pending/background subroutes, `/api/sessions*` server-side session persistence, `/api/plugins` + `/api/mcp/[id]`, `/api` health, `/api/pen/import` + `/api/pen/export` |
| `src/components/AGENTS.md` | Component tree root: ThemeToggle; indexes canvas/sessions/settings/ui child docs |
| `src/components/canvas/AGENTS.md` | Canvas UI components: drawing surface, floating toolbar (toolMode + undo/redo), layers, properties, agent chat + PluginUI bundle, command palette, top menu bar, .pen file menu, keyboard shortcuts dialog |
| `src/components/sessions/AGENTS.md` | Session management UI: sidebar, header, run history, status badges |
| `src/components/settings/AGENTS.md` | Settings dialog: 8-section modal (agent, LLM provider, sessions, appearance, data, shortcuts, plugins, MCP servers) |
| `src/components/ui/AGENTS.md` | shadcn/ui primitives: Radix UI wrappers, 48-component inventory |
| `src/lib/AGENTS.md` | Lib tree root: Prisma client singleton (`db.ts`), `cn()` utility; indexes the seven lib child docs |
| `src/lib/agent/AGENTS.md` | Agent layer: 97-tool base surface (79 tools.ts + 8 pen + 10 figma) + 32 plugin tools, native Pi-SDK runner + legacy test runner, client round-trip registry, classifier/planner, tool-execution-mode + alias policy, UI-quality enforcement loop |
| `src/lib/agent/skills/AGENTS.md` | Skill system: types, registry (7 skills), progressive disclosure levels, eval harness |
| `src/lib/agent/subagents/AGENTS.md` | 5 isolated-context sub-agents (web-research, design-critic, design-critic-vlm, design-brief, variant-generator) + dispatch/timeout/wall-clock-budget contracts |
| `src/lib/agent/plugins/AGENTS.md` | Plugin registry + 8 ported plugins (32 tools, gated by `settings.enabledPlugins`): ask-user-question, todo, memory, mega-compact, goal-list, background-tasks, mcp-adapter, subagents |
| `src/lib/canvas/AGENTS.md` | Canvas state: Zustand store (toolMode, undo/redo, settings injection), types, patches, clipboard + export helpers, gestures hook, Socket.IO service |
| `src/lib/llm/AGENTS.md` | LLM provider abstraction: 28 providers (26 OpenAI-compatible + 2 native), unified `LLMClient` interface, registry + factories |
| `src/lib/pen/AGENTS.md` | .pen format layer: canonical schema (v2.17, 20 node types, Pages abstraction), tree resolver (flexbox layout, variable/theme resolution, ref expansion), document helpers, converters |
| `src/lib/settings/AGENTS.md` | Settings store: AppSettings + AgentRunSettings types (incl. thinkingLevel, enabledPlugins, mcpServers), Zustand persist, PALETTES |
| `src/lib/sessions/AGENTS.md` | Session persistence: Zustand localStorage store + server-sync bridge (`/api/sessions*`), fork/restore, sweep/enforce helpers |
| `src/lib/web/AGENTS.md` | Web search + fetch: 4-provider search chain (z.ai → DDG → Startpage → Jina), 3-backend fetch pipeline (readability → z.ai page_reader → Jina), quality gates |
| `.zscripts/AGENTS.md` | Sandbox boot/build runtime: `dev.sh` boot flow (auto-run at container start), deploy artifact pipeline, `start.sh` production entrypoint |
| `docs/AGENTS.md` | Durable docs: z.ai sandbox runbook, phase design docs (design-systems, agentic-workflows, agent-performance, html-dom-renderer spec), menu-specs P0–P2 trackers |
| `examples/websocket/AGENTS.md` | Reference Socket.IO demo (gateway routing pattern; port-collision warning) |
| `mini-services/canvas-sync/AGENTS.md` | Socket.IO service for live multi-viewer canvas sync (EADDRINUSE-exit-0 twin contract) |
| `prisma/AGENTS.md` | Prisma schema: Document, Shape, AgentAction + session models (Session, SessionMessage, SessionRun) + DocumentSnapshot (document-scoped canvas timeline, shared-canvas model) |
| `scripts/AGENTS.md` | Dev scripts: dev-server + sandbox one-shot bring-up launchers, screenshot automation, intent classifier eval, token cost measurement, DOM-renderer bench corpus generator, agent-eval scenario suite, VLM output-inspection harness (vlm-inspect) |
| `tests/AGENTS.md` | Test suite: Vitest unit/integration tests (72 files / 1775 tests), shell smoke tests, CI notes |
| `research/AGENTS.md` | Read-only research: 7 web-research JSON surveys, gap-analysis + spec-compliance reports, `specs/` API snapshot cache (~74 refs) + `specs/llm-providers/` (28 provider snapshots) |

- Root-owned files: `README.md`, `LICENSE`, root tool/config files (`package.json`, `bun.lock`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `prisma.config.ts`, `components.json`, `instrumentation.ts`, `Caddyfile`, `.env.example`, `.gitignore`), `public/` static assets (logo.svg, robots.txt), and root-level project documentation. Session artifacts (`worklog.md`, `TEST_RESULTS_WORKLOG.md`, `test-results-*.json`, `tool-results/`) are transient and gitignored — do not commit them.

