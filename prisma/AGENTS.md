# AGENTS.md — `prisma/`

## Purpose

The Prisma schema + SQLite datasource. Defines the `Document`, `Shape`, and `AgentAction` models used for server-side persistence of canvas state and the agent action audit log.

## Ownership

- `schema.prisma` — the single source of truth for the database shape. Owned by this folder.
- `db/custom.db` — the SQLite database file (root-owned, gitignored in production). Owned by the root, not this folder.
- The Prisma client is generated to `node_modules/.prisma/client/` via `bun run db:generate`.

## Local Contracts

### Datasource
- Provider: `sqlite`.
- URL: from `DATABASE_URL` env var (typically `file:/home/z/my-project/db/custom.db`).
- The DB file lives at `db/custom.db` (relative to repo root). Do not move it without updating `DATABASE_URL`.

### Models

#### `Document`
- `id` (cuid, PK), `name` (default "Untitled"), `viewport` (JSON string, default "{}"), `background` (hex, default "#f8fafc"), `createdAt`, `updatedAt`.
- Has many `Shape` and `AgentAction` (cascade delete).

#### `Shape`
- `id` (cuid, PK), `documentId` (FK), `type` (string enum: "rectangle" | "ellipse" | "text" | "line" | "frame" | "group"), `name`, position (`x`, `y`), size (`width`, `height`), `rotation` (deg), `opacity` (0..1), `fill` (hex), `stroke` (hex), `strokeWidth`, `radius`, `text` (nullable, text-only), `fontSize`, `textColor` (hex), `parentId` (nullable, for groups), `zIndex`, `locked`, `visible`, `createdAt`, `updatedAt`.
- Indexes: `@@index([documentId])`, `@@index([parentId])`.
- This model MUST stay in sync with `CanvasShape` in `src/lib/canvas/types.ts`. Field names + types must match exactly. Defaults must match.

#### `AgentAction`
- `id` (cuid, PK), `documentId` (FK), `tool` (Pi tool name), `arguments` (JSON string), `result` (JSON string), `success` (bool), `durationMs` (int), `createdAt`.
- Index: `@@index([documentId])`.
- Audit log of every tool call. Currently written by... nobody (the runner emits events but does not persist them to this table; the session store handles persistence client-side via localStorage). This table is reserved for future server-side replay.

### Migration rules
- Dev: `bun run db:push --accept-data-loss` applies schema changes directly to SQLite (drops+recreates tables as needed — dev only).
- Production: `bun run db:migrate` creates a migration file in `prisma/migrations/` (does not exist yet — no migrations have been cut).
- After ANY schema change: run `bun run db:generate` to regenerate the Prisma client, then restart the dev server.
- Schema changes that drop columns WILL lose data in dev (SQLite has limited ALTER TABLE). For production, cut a proper migration.

### Sync with TypeScript types
- `prisma/schema.prisma` `Shape` ⟷ `src/lib/canvas/types.ts` `Shape`.
- `prisma/schema.prisma` `Document` ⟷ `src/lib/canvas/types.ts` `CanvasDocument` (note: `CanvasDocument` also includes `tokens` and `heatmap` which are NOT in the Prisma model — they are in-memory only for now).
- Changing one without the other will cause type errors in `src/lib/canvas/server.ts`.

## Work Guidance

- When adding a field to `Shape`: update `schema.prisma`, `src/lib/canvas/types.ts`, `src/lib/canvas/patch.ts` (default), `src/lib/agent/tools.ts` (tool schema if agent can set it), `src/components/canvas/PropertiesPanel.tsx` (form field), `src/components/canvas/LayersPanel.tsx` (display if relevant).
- When adding a new model: add it to `schema.prisma`, run `db:push` + `db:generate`, add the loader in `src/lib/canvas/server.ts` if it needs to be hydrated.
- Do not check the `db/custom.db` file into git (it is dev data). The `.gitignore` should already exclude it.

## Verification

- `bun run db:generate` — should regenerate the client without errors.
- `bun run db:push` — should apply schema to SQLite.
- `bunx prisma studio` — opens a GUI to inspect the DB.
- `sqlite3 db/custom.db ".tables"` — should list `Document`, `Shape`, `AgentAction`, `_prisma_migrations`.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `schema.prisma`. (No `migrations/` folder yet.)
