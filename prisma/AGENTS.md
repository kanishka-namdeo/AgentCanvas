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
- URL: from `DATABASE_URL` env var (typically `file:db/custom.db`).
- The DB file lives at `db/custom.db` (relative to repo root). Do not move it without updating `DATABASE_URL`.

### Models

#### `Document`
- `id` (cuid, PK), `name` (default "Untitled"), `viewport` (JSON string, default "{}"), `background` (hex, default "#f8fafc"), `createdAt`, `updatedAt`.
- Has many `Shape` and `AgentAction` (cascade delete).

#### `Shape`
- `id` (cuid, PK), `documentId` (FK), `type` (string enum: "rectangle" | "ellipse" | "text" | "line" | "frame" | "group" | "path" | "image"), `name`, position (`x`, `y`), size (`width`, `height`), `rotation` (deg), `opacity` (0..1), `fill` (hex), `stroke` (hex), `strokeWidth`, `radius`, `text` (nullable, text-only), `fontSize`, `textColor` (hex), `parentId` (nullable, for groups), `zIndex`, `locked`, `visible`, `createdAt`, `updatedAt`.
- Indexes: `@@index([documentId])`, `@@index([parentId])`.
- This model MUST stay in sync with `CanvasShape` in `src/lib/canvas/types.ts`. Field names + types must match exactly. Defaults must match.

### Known schema drift

The Prisma `Shape` model is currently **out of sync** with the TypeScript `Shape` type in `src/lib/canvas/types.ts`. The TypeScript type has these extended fields that the Prisma model does NOT have:

- `autoLayout?: AutoLayout | null` — JSON object with `direction`, `gap`, `padding`, `alignX`, `alignY`.
- `tokenBinding?: TokenBinding | null` — JSON object with `fillToken`, `textToken`, `strokeToken`.
- `componentId?: string | null`.
- `points?: PathPoint[] | null` — array of `{x, y}` (for path shapes).
- `closed?: boolean` — for path shapes.
- `src?: string | null` — for image shapes.
- `radii?: CornerRadii | null` — JSON object with `topLeft`, `topRight`, `bottomRight`, `bottomLeft`.
- `gradient?: GradientFill | null` — JSON object with `type`, `angle`, `stops`.
- `shadow?: ShadowEffect | null` — JSON object with `x`, `y`, `blur`, `color`, `spread`, `inset`.
- `blur?: number`.
- `maskId?: string | null`.

All of these fields are optional in the TypeScript type, so the Prisma model still works for basic shapes. However, extended features (paths, images, gradients, shadows, blur, masking, auto-layout, token bindings, components) **cannot be persisted to the database** until the schema is updated.

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
- **Current state**: the sync is **incomplete** — the Prisma `Shape` model is missing the extended fields listed in "Known schema drift" above. When updating the Prisma schema to match, all of these fields would need to be added as optional JSON or nullable columns.

## Work Guidance

- When adding a field to `Shape`: update `schema.prisma`, `src/lib/canvas/types.ts`, `src/lib/canvas/patch.ts` (default), `src/lib/agent/tools.ts` (tool schema if agent can set it), `src/components/canvas/PropertiesPanel.tsx` (form field), `src/components/canvas/LayersPanel.tsx` (display if relevant).
- When adding a new model: add it to `schema.prisma`, run `db:push` + `db:generate`, add the loader in `src/lib/canvas/server.ts` if it needs to be hydrated.
- Do not check the `db/custom.db` file into git (it is dev data). The `.gitignore` should already exclude it.
- **When adding extended shape fields to the Prisma schema**: add them as optional (`?`) JSON or nullable columns to avoid breaking existing data. Run `bun run db:push` then `bun run db:generate`. Update `server.ts` serialization if needed.

## Verification

- `bun run db:generate` — should regenerate the client without errors.
- `bun run db:push` — should apply schema to SQLite.
- Use `bunx prisma studio` to inspect the database visually. (The `sqlite3` CLI is not available on Windows by default.)

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `schema.prisma`. (No `migrations/` folder yet.)
