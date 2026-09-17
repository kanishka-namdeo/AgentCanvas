# AGENTS.md — `prisma/`

## Purpose

The Prisma schema + SQLite datasource. Defines the `Document`, `Shape`, `AgentAction`, `AgentEvent` (the OpenHands-style append-only agent event journal), `MutationClock` (Phase B R1 per-(document, client) exactly-once clock), and `Session`, `SessionMessage`, `SessionAttachment`, `SessionRun`, `DocumentSnapshot` models (server-side session + canvas-snapshot + attachment persistence, consumed by the `/api/sessions*` + `/api/documents/[documentId]/snapshots*` routes and `src/lib/sessions/server-sync.ts`).

## Ownership

- `schema.prisma` — the single source of truth for the database shape. Owned by this folder.
- `db/custom.db` — the SQLite database file (root-owned, gitignored in production). Owned by the root, not this folder.
- The Prisma client is generated to `node_modules/.prisma/client/` via `bun run db:generate`.

## Local Contracts

### Datasource
- Provider: `sqlite`.
- URL: from `DATABASE_URL` env var (typically `file:db/custom.db`).
- The DB file lives at `db/custom.db` (relative to repo root). Do not move it without updating `DATABASE_URL`.

### Prisma 7 driver-adapter pattern

This project was migrated to **Prisma 7**, which removed the `url` property from the `datasource` block in `schema.prisma`. The connection URL now lives in **`prisma.config.ts`** (at the repo root), and the Prisma client is constructed with a driver adapter (`@prisma/adapter-libsql`) in `src/lib/db.ts`:

```ts
// prisma.config.ts
import path from "node:path";
import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  migrations: { path: path.join(__dirname, "prisma", "migrations") },
  datasource: { url: process.env.DATABASE_URL ?? "file:./db/custom.db" },
});
```

```ts
// src/lib/db.ts
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql"; // ← note the lowercase `Sql`
const adapter = new PrismaLibSql({ url: databaseUrl }); // ← pass Config, not a Client
export const db = new PrismaClient({ log: ["query"], adapter });
```

The generated client is now output to `node_modules/.prisma/client/` (set in `schema.prisma` `generator.client.output`), and `@prisma/client` re-exports from there. Imports in app code stay the same (`import { PrismaClient } from "@prisma/client"`).

### Models

#### `Document`
- `id` (cuid, PK), `name` (default "Untitled"), `viewport` (JSON string, default "{}"), `background` (hex, default "#f8fafc"), `createdAt`, `updatedAt`. Has many `Shape` and `AgentAction` (cascade delete). `@@index([updatedAt])` (the `/api/documents` list query sorts `updatedAt desc`).

#### `Shape`
- `id` (cuid, PK), `documentId` (FK), `type` (free string column — the TS `LayerType` union in `src/lib/canvas/types.ts` has 16 values, so treat it as an open set), `name`, position (`x`, `y`), size (`width`, `height`), `rotation` (deg), `opacity` (0..1), `fill` (hex), `stroke` (hex), `strokeWidth`, `radius`, `text` (nullable, text-only), `fontSize`, `textColor` (hex), `parentId` (nullable, for groups), `zIndex`, `locked`, `visible`, `createdAt`, `updatedAt`.
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
- **DEPRECATED 2026-08-28** — zero writers since it was added; kept for schema archaeology. The live journal is `AgentEvent` below. Do not add new writers.

#### `AgentEvent` (append-only agent event journal — OpenHands-style event sourcing, Phase A)
- `id` (cuid, PK), `documentId`, `seq` (monotonic per-document journal watermark), `type` (the SyncEvent discriminator verbatim — lifecycle events carry the `agent:` prefix; plus `patch` for canvas mutations + `patch_dropped` / `agent:tool_call_interrupted` audit rows), `toolCallId?`, `payload` (JSON), `createdAt`.
- Indexes: `@@unique([documentId, seq])`, `@@index([documentId, createdAt])`, `@@index([documentId, type])`, `@@index([type, createdAt])`.
- Written by `src/lib/agent/event-journal.ts` from the NDJSON route (`/api/agent`) for EVERY significant agent event (patches, tool_call_start/end, message_start/end, turn_end / turn_cancelled, agent:error / agent:stuck, model_info, skill_selected, plan, critique). High-frequency deltas (message_delta / thinking_delta / presence) are deliberately NOT journaled — they are ephemeral UX, not durable state. Boot-time recovery (`src/lib/agent/boot-recovery.ts`) scans for `tool_call_start` rows without a matching `tool_call_end` and appends synthetic `agent:tool_call_interrupted` observations.
- **Seq allocation is multi-bundle safe**: no in-memory seq counter — every row re-reads the journal head with collision retry, because `instrumentation.ts` (socket bundle) and route handlers are SEPARATE Next.js module graphs (two runtime instances whose cached counters would silently collide on `@@unique([documentId, seq])` and drop rows).

#### `MutationClock` (Phase B R1 — per-(document, client) exactly-once clock)
- `id` (cuid, PK), `documentId`, `clientId`, `lastMutationId` (the Replicache `lastMutationID` — every accepted user patch is journaled as a `user_patch` `AgentEvent` row AND stamped here), `updatedAt`.
- Indexes: `@@unique([documentId, clientId])`, `@@index([documentId])`.
- Served read-side by the events API (`lastMutationIDChanges`) + the agent status route so reconnecting clients can prune their offline outbox + re-anchor their mutation counter. A retried/replayed mutation with `clientMutationId <= lastMutationId` answers `duplicate` instead of double-applying; a gap (`> lastMutationId + 1`) is rejected so out-of-order flushes surface instead of silently reordering the append-only canvas.

#### Session + snapshot models (server-side persistence — live)
- `Session` — the server-side mirror of the client session (a conversation context on a shared canvas): `id`, `documentId`, `title`, `status` (`active` | `archived`), `pinned`, `model`, counter fields (`messageCount`, `runCount`, `toolCallCount` — `snapshotCount` and the `snapshots` relation were DROPPED), `lastOpenedAt`, `parentSessionId` (fork tracking), `tags` (JSON string array — free-form sidebar tag filter), timestamps. Written by `/api/sessions*` routes via `src/lib/sessions/server-sync.ts` — the DB is the source of truth, localStorage the cache. Index: `@@index([documentId, status, lastOpenedAt])` (equality columns first, sort column last — prefix-covers the old single-column indexes).
- `SessionMessage` — one chat turn: `id`, `sessionId` (FK, cascade), `role`, `content`, `status`, `error`, `runId`, `diffSummary?` (JSON array of the turn's canvas-mutation records rolled up into the "+N −M" diff card; assistant messages only), `createdAt`. Indexes: `@@index([sessionId, createdAt])` + `@@index([status, createdAt])` (boot-recovery streaming scan).
- `SessionAttachment` — image attachment on a user message (paste / paperclip / drop / canvas snapshot): `id` (CLIENT-generated id — upserts are idempotent, re-syncing never duplicates rows), `messageId` (FK, cascade), `name`, `mimeType`, `sizeBytes`, `data` (raw base64, no `data:` prefix — the client downscales to ≤1280px + re-encodes BEFORE upload so each row is bounded at ~1.1MB), `createdAt`. Index: `@@index([messageId])`.
- `SessionRun` — one agent invocation: `id`, `sessionId` (FK, cascade), `prompt`, `status` (`queued` | `in_progress` | `completed` | `failed` | `cancelled`), `errorMessage`, `toolCallCount`, `toolCalls` (JSON), `inputTokens` / `outputTokens` / `costUsd` (per-run cost roll-up from `agent:context_update` events), `createdAt`, `updatedAt` (2026-09-11, nullable `DateTime?` — added via `prisma db push`; required columns cannot be added to populated SQLite tables without `--force-reset`) mirrors each status/cost update so stale-activity reconciliation distinguishes long-lived-but-active runs from genuinely stuck ones (client `Run.updatedAt`, see `../lib/sessions/AGENTS.md`). Indexes: `@@index([sessionId, createdAt])` + `@@index([status, createdAt])`.
- `DocumentSnapshot` — canvas snapshot, DOCUMENT-scoped (shared-canvas model — the snapshot timeline belongs to the canvas): `id`, `documentId` (owning canvas), `sessionId` / `messageId` / `runId` (PROVENANCE — plain string columns, NOT FKs, so deleting a chat never deletes canvas history; the old `@@index([sessionId])` was dropped — sessionId is provenance-only with no readers), `document` (serialized CanvasDocument JSON), `source` (default `"turn_end"`; `'server'` marks Phase C fold checkpoints), `nodeCount`, `label`, `bookmarked`, `lastSeq?` (Phase C R2 FOLD CHECKPOINT marker — when set, the row is a server-written fold of every journal mutation with seq ≤ lastSeq; NULL = client timeline capture, display/restore only, never a fold anchor), `tombstones?` (Phase C R2 — JSON array of node ids deleted at checkpoint time, so deletes below the compaction line still suppress resurrection on `canvas:full` reconcile), `createdAt`. Replaces the legacy `SessionSnapshot`; served by `/api/documents/[documentId]/snapshots*`. Indexes: `@@index([documentId, source, createdAt])`, `@@index([documentId, createdAt])`, `@@index([documentId, lastSeq])`.
- `SessionMessage` + `SessionRun` cascade-delete with their `Session`; `DocumentSnapshot` does NOT (it outlives its provenance session).
- **Legacy backfill**: `scripts/migrate-snapshots-to-doc.ts` copies every `SessionSnapshot` row into `DocumentSnapshot` (`documentId` = the session's `documentId`, `sessionId` = the old owning session). Idempotent — skips when the target is already migrated. Migration order (SQLite, no migrations folder): add `DocumentSnapshot` (keep `SessionSnapshot`) → `bunx prisma db push` → run the backfill → remove `SessionSnapshot` from the schema → `bunx prisma db push` again.

### Migration rules
- Dev: `bun run db:push --accept-data-loss` applies schema changes directly to SQLite (drops+recreates tables as needed — dev only).
- Production: `bun run db:migrate` creates a migration file in `prisma/migrations/` (does not exist yet — no migrations have been cut).
- After ANY schema change: run `bun run db:generate` to regenerate the Prisma client, then restart the dev server.
- Schema changes that drop columns WILL lose data in dev (SQLite has limited ALTER TABLE). For production, cut a proper migration.

### Sync with TypeScript types
- `prisma/schema.prisma` `Shape` ⟷ `src/lib/canvas/types.ts` `Shape`.
- `prisma/schema.prisma` `Document` ⟷ `src/lib/canvas/types.ts` `CanvasDocument` (note: `CanvasDocument` is now a **.pen tree model** — it carries `children: PenChild[]`, `variables`, `themes` as the source of truth, plus derived `shapes`/`tokens`/`background` caches. The Prisma model is a **flat Shape[]** and is **stale** — it doesn't model the tree, variables, or themes. Migrating canvas persistence to Prisma would require a tree table with adjacency list). The `heatmap` field was REMOVED for .pen format purity.
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

Note: `prisma.config.ts` lives at the **repo root** (not in `prisma/`) because that's where the Prisma 7 CLI looks for it. It's owned by this folder conceptually but physically co-located with `package.json`.
