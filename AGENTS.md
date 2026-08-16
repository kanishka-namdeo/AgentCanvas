# AGENTS.md — AgentCanvas (root DOX rail)

- This repository follows the DOX framework: a hierarchy of `AGENTS.md` files that act as binding work contracts for their subtrees.
- Any agent (human or AI) editing this repo MUST read the root `AGENTS.md`, walk from the repo root to each target path, and read every `AGENTS.md` found along each route before editing. Re-read in the current session — do not rely on memory.
- After every meaningful change, run a DOX closeout pass: update the nearest owning `AGENTS.md` and any affected parents/children, refresh Child DOX Indexes, remove stale or contradictory text.

## Purpose

AgentCanvas is a Figma-like design tool where the primary user of the canvas is an AI agent driven by the Pi Agent SDK (`@earendil-works/pi-coding-agent`). The agent exposes 54 tools (defined via `defineTool()` with TypeBox schemas) that mutate a canvas document: core shape ops (create/update/delete/list/select/clear/background), layer organization (duplicate/group/ungroup/organize), alignment, z-order (bring-to-front/send-to-back/move-forward/move-backward/reorder), text & copy generation, design tokens (update/apply/generate/bind/unbind/list), auto-layout, components (create/instantiate), generators (wireframe/user-flow/diagram), analytics & audit (heatmap prediction, design audit), export (JSON/SVG/PNG/code), search & filter (find/bulk-update/find-replace), advanced shape effects (path, boolean ops, masking, gradient fill, shadow, blur, per-corner radii), assets (image upload, icon search, image generation), and state (lock/visible/undo/redo). A human user chats with the agent in natural language; the agent reasons and emits canvas patches that render live in the browser.

The app is a Next.js 16 + React 19 + TypeScript monorepo with:
- A Zustand canvas store (frontend, single source of truth for the React UI).
- A Zustand session store (frontend, persisted to `localStorage`) that survives reloads and supports fork/restore.
- An HTTP API route (`/api/agent`) that runs the agent loop server-side and streams events back via Server-Sent Events-style chunked response.
- An optional Socket.IO mini-service (`mini-services/canvas-sync/`) for live multi-viewer broadcast.
- A Prisma + SQLite persistence layer (currently used only for `Document`/`Shape`/`AgentAction` models; session/run/message persistence is client-side via `localStorage`).

## Ownership

- **Repo owner**: project maintainer (single team, no per-folder owners yet).
- **Canvas state**: owned by `src/lib/canvas/` — the Zustand store is the single source of truth for the React UI. Do not mutate canvas state from outside the store's actions.
- **Agent loop**: owned by `src/lib/agent/` — the runner + 54 tool definitions. Tool definitions are the contract between the LLM and the canvas; changing a tool's schema is a breaking change for the agent.
- **Session persistence**: owned by `src/lib/sessions/` — Session/Run/Message/ToolCallRecord/Snapshot models + Zustand store with `persist` middleware. The canvas store bridges into this store; do not write to the session store directly from UI components.
- **UI components**: owned by their respective folders (`src/components/canvas/`, `src/components/sessions/`, `src/components/ui/`).
- **Design tokens**: owned by `src/app/globals.css` (the `--ac-*` custom properties). All UI components MUST consume tokens via the `.ac-text-*`, `.ac-border-*`, `.ac-surface-*`, `.ac-active-row`, `.ac-focus-ring`, `.ac-transition`, `.ac-hide-scrollbar` utility classes — do NOT hardcode `slate-{n}` / `zinc-{n}` color literals in components.
- **Database schema**: owned by `prisma/schema.prisma`. Schema changes require `bun run db:push` (or `db:migrate`) and a Prisma client regen via `bun run db:generate`.

## Local Contracts

### Tech stack (do not change without a parent-level decision)
- Next.js 16 (App Router, `output: "standalone"`)
- React 19, TypeScript 5
- Tailwind CSS 4 (via `@tailwindcss/postcss`)
- shadcn/ui (Radix primitives + `class-variance-authority`)
- Zustand 5 for state
- Prisma 6 + SQLite (file at `db/custom.db`, `DATABASE_URL` from `.env`)
- `@earendil-works/pi-coding-agent` for the agent SDK surface
- `z-ai-web-dev-sdk` as the LLM shim (sandbox has no Anthropic/OpenAI key; the runner drives the loop with ZAI but speaks the Pi `AgentSessionEvent` protocol so it can swap back to native Pi without touching consumers)

### Hard rules
- **No `any` in new code.** Use `unknown` + narrowing, or proper TypeBox types. (Existing `tools.ts`/`runner.ts`/`patch.ts` have pre-existing `any` — clean up opportunistically, do not add more.)
- **No inline color literals in components.** Use the `--ac-*` design tokens.
- **No direct DOM mutation in React components.** Use Zustand actions or local `useState`.
- **No `console.log` in committed code** unless the file already has a logging convention (e.g. `runner.ts`, `mini-services/canvas-sync/index.ts`).
- **`'use client'` directive required** on any file that uses hooks, Zustand, or browser APIs. Server components must not import from `src/lib/canvas/store.ts`, `src/lib/sessions/store.ts`, or any `src/components/**` file that is client-only.
- **Canvas patches are append-only.** The session store records every tool call; restoring a snapshot creates a NEW snapshot (Lovable model), never overwrites history.
- **Tool schema changes are breaking.** Adding a new tool is safe; renaming, removing, or changing the parameter schema of an existing tool invalidates prior session replays.
- **All files MUST live under the repo root.** Final deliverables go to `download/` (repo root); generation scripts go to `scripts/`.

### LLM shim policy
- The runner (`src/lib/agent/runner.ts`) currently drives the loop with `z-ai-web-dev-sdk`. The event stream still mirrors Pi's `AgentSessionEvent` union.
- To switch back to native Pi: replace the ZAI call site in `runner.ts` with `createAgentSession` from `@earendil-works/pi-coding-agent`. Consumers (the API route, the canvas store's event handler) should not need to change.
- Do NOT add a second LLM driver. There is one shim, one swap point.

### File output policy (for AI agents working in this repo)
- Generation scripts (Python/Node/Shell longer than ~10 lines) MUST be saved to `scripts/` before execution — no inline `python -c` or heredoc pipes.
- Final user-facing deliverables (documents, images, datasets) go to `download/` (repo root).
- Append-only work log at `worklog.md` (repo root) — read it before working, append a new section after finishing (format: `---` separator + Task ID + Agent + Task + Work Log + Stage Summary).

## Work Guidance

### Dev workflow
- `bun install` to install deps (lockfile is `bun.lock`).
- `bun run dev` starts Next.js on port 3000 (logs to `dev.log`).
- `bun run lint` runs ESLint 9 with `eslint-config-next`.
- `bun run db:push` applies schema changes to SQLite (accepts data loss — dev only).
- `bun run db:generate` regenerates the Prisma client after schema changes.
- `bun run build` produces a standalone build in `.next/standalone/`.

### When fixing a bug
1. Reproduce it (screenshot or console error).
2. Search the codebase for the failing pattern (e.g. `.toFixed(` calls when the error is `s.x.toFixed is not a function`).
3. Fix at the source — prefer type guards / `Number()` coercion over `try/catch` swallows.
4. Verify the fix in the browser via `scripts/screenshot-ui-after.ts` or manual inspection.
5. Append a worklog entry.

### When adding a UI feature
1. Check `src/app/globals.css` for existing design tokens before introducing new colors.
2. Prefer composing shadcn/ui primitives from `src/components/ui/` over building raw HTML.
3. Keep panel layouts consistent with the 4-pane layout in `src/app/page.tsx`.
4. Capture before/after screenshots to `download/<feature-name>/`.

### When adding an agent tool
1. Define the tool in `src/lib/agent/tools.ts` using `defineTool()` + TypeBox schema.
2. Implement execution in the `executeTool` switch.
3. Add the tool to the system prompt's tool catalog in `runner.ts`.
4. Document the tool's contract in `src/lib/agent/AGENTS.md`.

## Verification

- **TypeScript**: `bunx tsc --noEmit` (note: `next.config.ts` sets `ignoreBuildErrors: true`, so `bun run build` will NOT catch type errors — run `tsc` explicitly).
- **Lint**: `bun run lint`.
- **Build**: `bun run build`.
- **Runtime smoke test**: `bun run dev` then open `http://127.0.0.1:3000/`, type a prompt, verify the agent produces shapes on the canvas.
- **UI regression**: `bunx tsx scripts/screenshot-ui-after.ts` captures 5 states to `download/ui-polish-after/`.
- **Tests**: `bun run test` runs the Vitest suite (unit + integration tests). Manual screenshots via `scripts/screenshot-ui-after.ts` supplement automated tests.

## User Preferences

(Record durable behavior changes requested by the user here. None recorded yet beyond what is encoded in the contracts above.)

## Child DOX Index

Direct child `AGENTS.md` files. Each owns its subtree; read the nearest one before editing any file in its scope.

| Path | Scope |
|------|-------|
| `src/lib/agent/AGENTS.md` | 54 Pi Agent SDK tool definitions + the agent runner loop (LLM shim, event stream, system prompt). |
| `src/lib/canvas/AGENTS.md` | Canvas types, Zustand store (single source of truth for the UI), patch application, Socket.IO canvas-sync service. |
| `src/lib/sessions/AGENTS.md` | Session/Run/Message/ToolCallRecord/Snapshot types + persisted Zustand store (localStorage, fork/restore). |
| `src/components/canvas/AGENTS.md` | Canvas UI: `Canvas`, `Toolbar`, `LayersPanel`, `PropertiesPanel`, `AgentPanel`. |
| `src/components/sessions/AGENTS.md` | Session UI: `SessionSidebar`, `SessionHeader`, `RunHistoryPanel`, `StatusBadge`. |
| `src/components/ui/AGENTS.md` | shadcn/ui primitives (Radix + CVA). Do not hand-edit unless syncing upstream. |
| `src/app/AGENTS.md` | Next.js App Router: root `layout.tsx`, `page.tsx` (4-pane layout), `globals.css` (the `--ac-*` design token system). |
| `src/app/api/AGENTS.md` | API routes: `/api/agent` (SSE-style agent run endpoint) and `/api` (health check). |
| `scripts/AGENTS.md` | Dev/run/screenshot shell + TS scripts. |
| `mini-services/canvas-sync/AGENTS.md` | Standalone Socket.IO service for live canvas broadcast. |
| `prisma/AGENTS.md` | Prisma schema (`Document`, `Shape`, `AgentAction` models) + SQLite datasource. |
| `research/AGENTS.md` | Read-only research notes (JSON). Reference only — do not edit. |
| `tests/AGENTS.md` | Runtime build shell scripts (Python/DB container smoke tests). |

Root-owned files (no child `AGENTS.md`): `package.json`, `bun.lock`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `components.json`, `Caddyfile`, `instrumentation.ts`, `worklog.md`, `db/custom.db`, `public/`, `download/`, `examples/`, `tool-results/`, `src/components/ThemeToggle.tsx` (small standalone client component — toggles the `.dark` class on `<html>`; documented in `src/app/AGENTS.md` under "Dark mode"), `src/lib/db.ts` (Prisma client singleton), `src/lib/utils.ts` (shared utility functions), `src/hooks/use-mobile.ts` (responsive breakpoint hook), `src/hooks/use-toast.ts` (toast notification hook).
