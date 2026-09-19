# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here

- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees

- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md

2. Identify every file or folder you expect to touch

3. Walk from the repository root to each target path

4. Read every AGENTS.md found along each route

5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there

6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules

7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities

- durable structure, contracts, workflows, or operating rules

- required inputs, outputs, permissions, constraints, side effects, or artifacts

- user preferences about behavior, communication, process, organization, or quality

- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index

- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index

- Each parent explains what its direct children cover and what stays owned by the parent

- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards

- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty

- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:

- Purpose

- Ownership

- Local Contracts

- Work Guidance

- Verification

- Mistakes & Lessons

- Child DOX Index

## Mistakes & Lessons

Every doc that owns a boundary also owns the mistakes it has made.

- Failure Modes: anticipated pitfalls — things that tend to break or that the agent should check for proactively. One forward-looking bullet each ("Check X before Y").
- Lessons Learned: distilled takeaways from actual mistakes, corrections, or user pushback. Write them as forward-looking rules, not post-mortems ("Do X, not Y, because Z").

Update rule: after any non-trivial mistake, correction, or user pushback, add one distilled lesson (or failure mode) to the closest owning AGENTS.md in the same DOX pass. Delete a lesson once it is fully internalized in the Work Guidance. Keep entries concise; if a lesson accumulates enough detail to become a durable rule, promote it into Work Guidance and remove it here.

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

7. Review the Mistakes & Lessons sections of all affected docs — did this task reveal a new failure mode or lesson? Add one if so; promote any that have matured into Work Guidance.

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md

## z.ai Sandbox Operations

- This repo targets the z.ai sandbox, where the project root is `/home/z/my-project` — never a subdirectory. The one-shot bring-up runbook (scaffold replacement, `DATABASE_URL` override, process-survival rules, gateway ports, restart persistence, verification) is in `docs/zai-sandbox-setup.md`. Read it before any sandbox bring-up or restart debugging.
- The sandbox host kills every descendant of an agent tool call when it ends. Launch the dev server only via `scripts/start-dev.sh` (orphan-to-init pattern) — bare `nohup`/`setsid`/`disown` background jobs do not survive. `scripts/setup-zai-sandbox.sh` is the one-shot wrapper (env + install + DB + start + verify + persist).
- Only port `:81` (Caddy gateway) is externally exposed: default → `:3000`, other ports via `?XTransformPort=<port>`. Browser code uses relative URLs only. `/` is the landing page and `/app` is the workspace (both user-visible); users preview via the Preview Panel, never localhost links.
- The project directory is ephemeral across container restarts; `/home/sync/repo.tar` is the persistence layer and boot auto-runs `.zscripts/dev.sh`. After durable changes, refresh the archive: `bash scripts/setup-zai-sandbox.sh --archive`.
- Never `bun run build` / `next start` in the sandbox — the boot flow supports the dev server on port 3000 only.

## LLM Endpoint Access Policy

- Endpoint presets (defined in `src/lib/llm/endpoint-presets.ts`) must **never be invoked directly** — no curl, bash, wget, fetch, or any other out-of-app tooling may send requests to a preset's base URL. This is a durable user directive recorded 2026-09-07 and applies to every future event, session, and agent working in this repo.
- All interaction with endpoint presets flows through the app's own code and HTTP surface only: the Settings → LLM provider "Endpoint presets" chips, `POST /api/models` (the app's own endpoint preflight), and `POST /api/agent` (the app's own runner — the pi-ai resolver builds the synthetic openai-completions Model against the preset base URL).
- Scripts that verify endpoints must import the preset from `@/lib/llm/endpoint-presets` and drive the app's API — never embed the URL or query the endpoint themselves. Endpoint health is measured exactly the way end users experience it: through the app.

## Child DOX Index

Direct children of the root. Deeper nodes are reachable by walking each parent's own Child DOX Index — DOX convention is "direct children only" per parent.

| Path | Scope |
|------|-------|
| `src/app/AGENTS.md` | Next.js App Router: root layout, landing page (`/`), workspace page (`/app`), opengraph image, `--ac-*` design tokens in `globals.css`. Indexes 6 child docs under `src/app/api/`. |
| `src/components/AGENTS.md` | Component tree root: shared ThemeToggle + ErrorBoundary; indexes 7 child docs (canvas, sessions, settings, design-systems, ui, landing, onboarding). |
| `src/lib/AGENTS.md` | Lib tree root: Prisma client singleton (`db.ts`), `cn()` utility; indexes 9 child docs (agent, canvas, design-systems, llm, pen, sessions, settings, web, icons). |
| `.zscripts/AGENTS.md` | Sandbox boot/build runtime: `dev.sh` boot flow (auto-run at container start), deploy artifact pipeline, `start.sh` production entrypoint. |
| `docs/AGENTS.md` | Durable docs: z.ai sandbox runbook, phase design docs (design-systems, agentic-workflows, agent-performance, html-dom-renderer spec), menu-specs trackers, superpowers plans/specs. |
| `examples/websocket/AGENTS.md` | Reference Socket.IO demo (read-only; gateway routing pattern; port-collision warning with the in-process canvas-sync on :3003). |
| `mini-services/AGENTS.md` | Reserved deploy-target boundary for standalone microservices (currently empty — historical `canvas-sync` retired on :3003 collision with its in-process twin in `src/lib/canvas/server.ts`). |
| `prisma/AGENTS.md` | Prisma schema: `Document`, `Shape`, `AgentEvent` (live journal), `MutationClock`, `Session`, `SessionRun`, `DocumentSnapshot` (document-scoped canvas timeline, shared-canvas model). |
| `research/AGENTS.md` | Read-only research: 7 web-research JSON surveys, gap-analysis + spec-compliance + shared-canvas-spec reports, `specs/` API snapshot cache (~74 refs) + `specs/llm-providers/` (29 provider snapshots) + `best-practices/` (18 perf research snapshots). |
| `research-context/AGENTS.md` | Read-only UX research context JSON: competing-tool UI snapshots + project UX probes (Cline / OpenCode / Claude Code / cursor-ui / chat-attach / model-selector / vision-badges / pd-* probes). Reference-only, not imported by app code. |
| `scripts/AGENTS.md` | Dev scripts: dev-server + sandbox one-shot bring-up launchers, screenshot automation, landing video capture harness (video-capture) + landing video probe, intent classifier eval, token cost measurement, DOM-renderer bench corpus generator, agent-eval scenario suite, VLM output-inspection harness (vlm-inspect). |
| `tests/AGENTS.md` | Test suite: Vitest 5 unit/integration tests, shell smoke tests, CI notes. |

Root-owned files (no child doc — owned by this root): `README.md`, `LICENSE`, root tool/config files (`package.json`, `bun.lock`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `prisma.config.ts`, `components.json`, `instrumentation.ts`, `Caddyfile`, `.env.example`, `.gitignore`), `public/` static assets (logo.svg, robots.txt, `public/landing/` marketing media — 7 PNGs (4 screenshots + 3 video poster stills) + 3 MP4s: the Hero + FeatureGallery cuts landed by the 2026-09-19 video pass, replacing the legacy `core-*.mp4` b-roll). Session artifacts (`worklog.md`, `TEST_RESULTS_WORKLOG.md`, `test-results-*.json`, `tool-results/`) are transient and gitignored — do not commit them.
