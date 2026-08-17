# Architecture — AgentCanvas Runtime

> How the runtime pieces fit together: Zustand stores, patch pipeline,
> .pen resolver, agent loop, Socket.IO fanout. Read this before
> refactoring anything in `src/lib/`.

---

## 1. The data flow at a glance

```
                ┌─────────────────────────────────────────────┐
                │                  Browser                     │
                │                                             │
                │  ┌──────────┐    ┌──────────┐  ┌─────────┐  │
                │  │  React   │◄──►│  Canvas  │  │ Session │  │
                │  │   UI     │    │  Store   │◄─┤  Store  │  │
                │  └────┬─────┘    │(Zustand) │  │(Zustand)│  │
                │       │          └────┬─────┘  └────┬────┘  │
                │       │               │             │       │
                │       │       socket.io-client      │       │
                └───────┼────────────────┼─────────────┼───────┘
                        │                │             │
                        │ direct fetch   │ WebSocket   │
                        │ (fallback)     ▼             │
                        ▼            ┌────────────────────────┐
                ┌────────────────┐   │  canvas-sync service   │
                │ POST /api/agent│   │  (Socket.IO :3003)     │
                │ (Next.js route)│   │                        │
                │                │   │  broadcasts patches +  │
                │  runAgent()    │◄──┤  agent_events           │
                │  ├─ system     │   └────────────────────────┘
                │  │  prompt     │
                │  ├─ tool       │
                │  │  catalog    │
                │  ├─ canvas     │
                │  │  snapshot   │
                │  └─ LLM loop   │
                │       │        │
                │       ▼        │
                │  z-ai-web-dev- │
                │  sdk (OpenAI   │
                │  compat)       │
                │                │
                │  executeTool() │
                │  ├─ pen_create_*
                │  ├─ pen_set_*
                │  └─ … 62 tools │
                └───────┬────────┘
                        │
                        ▼
                ┌─────────────────────┐
                │  Prisma + SQLite    │
                │  ├─ Document        │
                │  ├─ Shape           │
                │  └─ AgentAction     │
                └─────────────────────┘
```

---

## 2. The .pen tree is the source of truth

The canvas's model is the **.pen tree** — `CanvasDocument.children` is
an array of `PenChild` (discriminated union on `type`). The flat
`shapes[]` and `tokens` fields on `CanvasDocument` are **derived
render caches**, recomputed on every mutation by `resolvePenTree()`.

This mirrors pen.dev's architecture: the tree is the model;
rendering computes layout.

### 2.1 The mutation contract

Every mutation goes through a `CanvasPatch`:

```ts
interface CanvasPatch {
  op: 'add' | 'update' | 'remove' | 'clear' | 'background' | 'select' |
      'bulk_add' | 'update_many' | 'duplicate' | 'group' | 'ungroup' |
      'align' | 'tokens' | 'zorder' | 'reorder' | 'viewport' |
      'undo' | 'redo' |
      'set_theme_axis' | 'set_node_theme' | 'set_variable' | 'mark_slot';
  shapeId?: string;
  shape?: Partial<Shape> & Record<string, unknown>;
  // … op-specific fields
  summary: string;       // human-readable; used by the agent
}
```

Patches are:

1. **Append-only** — never mutate history in place.
2. **Replayable** — applying the same patch sequence to the same
   starting state produces the same final state.
3. **Broadcastable** — patches are the unit of Socket.IO sync.

### 2.2 The patch applier

`src/lib/canvas/patch.ts` exports `applyPatch(doc, patch): CanvasDocument`.
It:

1. Mutates the .pen tree according to `patch.op`.
2. Recomputes `doc.shapes` via `resolvePenTree(doc.children)`.
3. Recomputes `doc.tokens` via `tokensFromVariables(doc.variables)`.
4. Returns the new doc.

The applier is **pure** — same input → same output. The Zustand store
wraps it with subscribe/notify.

### 2.3 The resolver

`src/lib/pen/resolve.ts` exports `resolvePenTree(children, ctx): Shape[]`.
It:

1. Walks the tree depth-first.
2. Computes absolute positions (parent x/y + child x/y, modulo
   Auto Layout which recomputes positions for non-absolute children).
3. Expands `PenRef` nodes into their resolved Component subtree,
   applying `descendants` overrides.
4. Resolves `$variable` references against `ctx.variables` (with the
   active theme).
5. Assigns depth-first `zIndex` for SVG rendering convenience.
6. Returns a flat `Shape[]` ready for the SVG renderer.

---

## 3. Zustand stores

### 3.1 Canvas store — `src/lib/canvas/store.ts`

```ts
interface CanvasStore {
  document: CanvasDocument;
  selectedIds: Set<string>;
  history: { past: CanvasPatch[]; future: CanvasPatch[] };

  // actions
  applyPatch(patch: CanvasPatch): void;
  undo(): void;
  redo(): void;
  select(ids: string[]): void;
  setViewport(vp: Viewport): void;
  // …
}
```

Persisted to `localStorage` via Zustand's `persist` middleware.

### 3.2 Session store — `src/lib/sessions/store.ts`

```ts
interface SessionStore {
  sessions: Record<string, Session>;
  activeSessionId: string | null;

  createSession(name?: string): Session;
  forkSession(sessionId: string, fromMessageId?: string): Session;
  restoreSnapshot(sessionId: string, snapshotId: string): void;
  // …
}
```

Sessions contain `Run[]` → `Message[]` → `ToolCallRecord[]` →
`Snapshot[]`. All client-side; the API surface is designed to swap
to Prisma later by replacing the storage adapter.

### 3.3 Settings store — `src/lib/settings/store.ts`

Holds `AgentRunSettings` (model, temperature, max tool calls, etc.)
and the UI theme.

---

## 4. The agent loop

`src/lib/agent/runner.ts` exports `runAgent(req): AsyncGenerator<AgentEvent>`.

```
runAgent(req):
  1. Build system prompt:
     - Tool catalog (~62 tools)
     - Canvas snapshot (textual render of the .pen tree)
     - Active variables + themes
     - Hard rules (no `any`, append-only patches, etc.)
  2. Add the user's prompt as a user message.
  3. Loop:
     a. Call z-ai-web-dev-sdk.chat.completions.create({ messages, tools })
        - tools = the Zod schemas of our 62 pen_* tools
     b. Parse the response:
        - If finish_reason='tool_calls':
            for each tool_call:
              - Emit 'agent:tool_call_start'
              - Call executeTool(tool_call.name, tool_call.args)
              - Emit 'agent:tool_call_end' with success/failure
              - Apply returned patches to the canvas
              - Append the tool result to messages
            Continue the loop.
        - If finish_reason='stop':
            Emit the final text via 'agent:message_delta' + 'agent:message_end'
            Emit 'agent:turn_end'
            Break.
  4. Yield events as they happen (streaming).
```

### 4.1 Streaming protocol

The agent emits newline-delimited JSON events:

```
{"type":"agent:message_start","role":"assistant"}
{"type":"agent:thinking_delta","text":"The user wants a login screen..."}
{"type":"agent:tool_call_start","toolCallId":"tc_1","toolName":"pen_create_frame","argsPreview":"{width:375,...}"}
{"type":"agent:tool_call_end","toolCallId":"tc_1","success":true,"summary":"Created frame 'phone'"}
{"type":"canvas:patch","patch":{"op":"add","shape":{"type":"frame",...},"summary":"add frame"}}
{"type":"agent:turn_end"}
```

### 4.2 LLM shim policy

The agent is driven by `z-ai-web-dev-sdk`, which speaks the
OpenAI-compatible API. The event stream in `runner.ts` deliberately
mirrors the Pi Agent SDK's `AgentSessionEvent` shape — so to switch
back to native Pi (`createAgentSession`), you only need to edit one
call site. **Don't add a second driver.** See `AGENTS.md` → "LLM shim
policy" for the contract.

### 4.3 Fallback to direct fetch

If the Socket.IO service is down, the client POSTs directly to
`/api/agent`. The agent endpoint streams NDJSON back. The app still
works end-to-end; only real-time multi-viewer sync is lost.

---

## 5. Socket.IO fanout

### 5.1 In-process service

`src/lib/canvas/server.ts` exports `startCanvasSyncService()`. It's
called by `instrumentation.ts` on Next.js startup, so the Socket.IO
server shares the Next.js process's lifecycle.

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startCanvasSyncService } = await import('./src/lib/canvas/server');
    startCanvasSyncService();
  }
}
```

### 5.2 Standalone service

For production, the same code runs as a standalone Bun process on
port 3003 — see `mini-services/canvas-sync/`. The Next.js route
falls back to direct fetch if the standalone service is unreachable.

### 5.3 Protocol

| Direction | Event                  | Payload |
| --------- | ---------------------- | ------- |
| Client → Server | `subscribe`     | `{ documentId }` |
| Client → Server | `canvas:patch`  | `CanvasPatch` |
| Client → Server | `canvas:request_full` | `{ documentId }` |
| Client → Server | `agent:prompt`  | `{ documentId, prompt, settings? }` |
| Server → Client | `canvas:patch`  | `CanvasPatch & { toolCallId? }` |
| Server → Client | `canvas:full`   | `CanvasDocument` |
| Server → Client | `agent:*`       | Agent events (see §4.1) |
| Server → Client | `presence`      | `{ viewerCount }` |

---

## 6. Prisma schema

Three models (server-side):

- `Document` — the .pen file's metadata (id, name, viewport,
  background).
- `Shape` — server-side persistence of resolved shapes (one row per
  shape). Used for cross-device sync when localStorage isn't enough.
- `AgentAction` — audit log of every tool call (tool name, args,
  result, duration). Used for replay and analytics.

Sessions, runs, messages, and snapshots are **client-side** today;
the store API is designed to swap to Prisma later by replacing only
the storage adapter.

---

## 7. File layout (post-v2.0)

```
src/
├── app/                              # Next.js App Router
│   ├── page.tsx                      # The 4-panel workspace
│   ├── layout.tsx
│   └── api/
│       ├── agent/route.ts            # POST /api/agent (NDJSON stream)
│       ├── pen/export/route.ts       # GET /api/pen/export
│       └── pen/import/route.ts       # POST /api/pen/import
├── components/
│   ├── canvas/
│   │   ├── Canvas.tsx                # SVG renderer
│   │   ├── Toolbar.tsx               # shape-creation toolbar
│   │   ├── LayersPanel.tsx           # tree view of .pen nodes
│   │   ├── PropertiesPanel.tsx       # inspector for selected node
│   │   ├── AgentPanel.tsx            # chat UI + tool-call stream
│   │   ├── CommandPalette.tsx
│   │   └── PenFileMenu.tsx           # import/export .pen
│   ├── sessions/                     # session sidebar, run history
│   └── ui/                           # shadcn/ui primitives
├── lib/
│   ├── canvas/
│   │   ├── types.ts                  # CanvasDocument, Shape, CanvasPatch
│   │   ├── patch.ts                  # patch applier (pure)
│   │   ├── store.ts                  # Zustand canvas store
│   │   └── server.ts                 # in-process Socket.IO
│   ├── pen/
│   │   ├── types.ts                  # .pen format types (§pen-spec-v2)
│   │   ├── resolve.ts                # tree → flat Shape[] resolver
│   │   ├── converters.ts             # .pen ↔ SVG ↔ Figma JSON
│   │   ├── document.ts               # PenDocument helpers
│   │   └── migrate.ts                # v1 → v2 migration (new v2.0)
│   ├── agent/
│   │   ├── runner.ts                 # the agent loop
│   │   ├── tools.ts                  # 62 pen_* tool definitions
│   │   ├── planner.ts                # multi-step planner
│   │   ├── classifier.ts             # prompt → skill classifier
│   │   ├── pen-tools.ts              # .pen-tree-specific helpers
│   │   ├── skills/                   # skill registry
│   │   └── subagents/                # web-research subagent
│   ├── sessions/
│   │   ├── types.ts
│   │   ├── store.ts
│   │   └── index.ts
│   ├── settings/
│   │   ├── types.ts
│   │   └── store.ts
│   ├── web/                          # web fetch / search helpers
│   └── db.ts                         # Prisma client singleton
├── hooks/
│   ├── use-mobile.ts
│   └── use-toast.ts
└── instrumentation.ts                # boots canvas-sync on startup

prisma/
└── schema.prisma                     # Document, Shape, AgentAction

mini-services/
└── canvas-sync/                      # standalone Socket.IO (port 3003)

tests/
├── unit/
│   ├── patch.test.ts
│   ├── store.test.ts
│   ├── tools.test.ts
│   ├── ShapeRenderer.test.tsx
│   ├── converters.test.ts            # (new v2.0)
│   └── ontology.test.ts              # (new v2.0)
└── integration/
    ├── runner.test.ts
    ├── pipeline.test.ts
    ├── renderer.test.tsx
    ├── scenarios.test.ts
    ├── conversation.test.ts
    └── session-bridge.test.ts

docs/                                 # this folder
├── README.md
├── glossary.md
├── figma-ontology.md
├── cross-tool-matrix.md
├── pen-spec-v2.md
├── tool-catalog.md
└── architecture.md
```

---

## 8. Hard rules (from AGENTS.md)

- No `any` in new code.
- No inline color literals — use the `--ac-*` design tokens in `globals.css`.
- No direct DOM mutation.
- No `console.log` in committed code.
- `'use client'` required on any file using hooks.
- Canvas patches are **append-only** — never mutate history in place.
- Tool schema changes are **breaking** — bump the version and document the migration.
- New `.pen` types must be added to `src/lib/pen/types.ts` AND documented in `docs/pen-spec-v2.md` in the same PR.
- New tools must be added to `src/lib/agent/tools.ts` AND documented in `docs/tool-catalog.md` in the same PR.

---

## 9. Where to look when…

| You want to… | Look at… |
| --- | --- |
| Add a new shape type | `src/lib/pen/types.ts` + `src/lib/pen/resolve.ts` + `src/components/canvas/Canvas.tsx` |
| Add a new tool | `src/lib/agent/tools.ts` + `docs/tool-catalog.md` + `tests/unit/tools.test.ts` |
| Add a new patch op | `src/lib/canvas/types.ts` (CanvasPatch) + `src/lib/canvas/patch.ts` (applier) + `tests/unit/patch.test.ts` |
| Change the LLM driver | `src/lib/agent/runner.ts` (one call site) |
| Add a new Component Property type | `src/lib/pen/types.ts` (ComponentPropertyDefinition) + `src/lib/agent/tools.ts` (pen_set_component_property) |
| Add a new export format | `src/lib/pen/converters.ts` + `src/app/api/pen/export/route.ts` |
| Add a new UI panel | `src/components/canvas/` + `src/app/page.tsx` |
| Change Socket.IO protocol | `src/lib/canvas/server.ts` + `src/lib/canvas/types.ts` (SyncEvent / ClientEvent) |
| Add a new Prisma model | `prisma/schema.prisma` + `src/lib/db.ts` + run `bun run db:push` |
