# AGENTS.md — `src/lib/agent/`

## Purpose

The agent layer: defines the 24 tools the AI agent can call against the canvas, and runs the agent loop that turns a natural-language prompt into a stream of canvas patches + chat events.

This is the contract layer between the LLM and the canvas. Tool names, parameter schemas, and the system prompt's tool catalog are the public surface — changing them is a breaking change for prior session replays.

## Ownership

- `tools.ts` — 24 `defineTool()` definitions with TypeBox parameter schemas + the `executeTool` dispatcher. Owned by this folder.
- `runner.ts` — the agent loop. Owns the system prompt, the LLM driver, the event stream shape, and the patch sink.

## Local Contracts

### Tool surface (24 tools — do not rename/remove without parent-level decision)
- **Core canvas ops (7)**: `canvas_create_shape`, `canvas_update_shape`, `canvas_delete_shape`, `canvas_list_shapes`, `canvas_clear`, `canvas_set_background`, `canvas_select_shape`.
- **Layer organization (3)**: `canvas_duplicate_shape`, `canvas_group_shapes`, `canvas_ungroup_shapes`.
- **Alignment & distribution (5)**: `canvas_align_shapes`, `canvas_distribute_shapes`, `canvas_bring_to_front`, `canvas_send_to_back`, `canvas_reorder_shape`.
- **Text & typography (2)**: `canvas_create_text`, `canvas_set_text_style`.
- **Design tokens (3)**: `canvas_apply_color_token`, `canvas_apply_text_style_token`, `canvas_list_tokens`.
- **Layout systems (2)**: `canvas_create_auto_layout`, `canvas_update_auto_layout`.
- **Analytics & export (2)**: `canvas_run_heatmap`, `canvas_export_json`.

### Tool definition rules
- Every tool MUST be defined with `defineTool()` from `@earendil-works/pi-coding-agent` and a TypeBox schema from `@sinclair/typebox`.
- Every tool MUST have a `description` field that the LLM reads to decide when to call it.
- Tool names use `snake_case` with the `canvas_` prefix (except none currently break this rule).
- Parameter names use `camelCase`.
- The `executeTool` switch MUST handle every tool name; an unknown name returns `{ ok: false, error: 'Unknown tool' }`.

### LLM shim policy (root contract, restated for locality)
- The runner currently drives the loop with `z-ai-web-dev-sdk` (ZAI) because the sandbox has no Anthropic/OpenAI key.
- The event stream (`AgentStreamEvent` union) mirrors Pi's `AgentSessionEvent` shape so consumers do not change when the driver swaps.
- Swap point: the single ZAI call site in `runner.ts`. Replace with `createAgentSession` from `@earendil-works/pi-coding-agent` to go native Pi. Do NOT add a second driver.
- ZAI speaks the OpenAI tool-calling protocol; the runner translates OpenAI tool-call deltas into Pi-style events.

### System prompt
- The system prompt is defined inline at the top of `runner.ts` as `SYSTEM_PROMPT`.
- It MUST list all 24 tools grouped by category (the LLM uses this catalog to pick tools).
- It MUST describe the agent's persona: "AI design agent operating a Figma-like canvas powered by the Pi Agent SDK".
- It MUST include the JSON shape conventions for tool arguments (e.g. color hex strings, shape `type` enum).

### Event stream shape
```ts
type AgentStreamEvent =
  | { kind: 'patch'; patch: CanvasPatch; toolCallId?: string }
  | { kind: 'agent_event'; event: SyncEvent };
```
- `patch` events carry a `CanvasPatch` that the caller applies to the canvas.
- `agent_event` events carry a `SyncEvent` (defined in `src/lib/canvas/types.ts`) — chat deltas, tool-call start/end, errors, turn end.
- The runner emits `turn_end` exactly once per run. Two code paths can reach it (normal exit + MAX_ITERATIONS); the runner MUST guard against double-emission (check if the run is already `completed`).

### Patch sink
- The runner applies each patch to a local copy of the canvas via `applyPatchToCanvas` (from `../canvas/patch.ts`) and emits the patched document state as part of the event.
- The runner does NOT touch the database or the Zustand store — it is a pure producer. The API route is the consumer that forwards events to viewers.

### Number safety
- All numeric shape fields (`x`, `y`, `width`, `height`, `rotation`, `opacity`, `fontSize`, `strokeWidth`, `radius`) MUST be coerced with `Number()` before any `.toFixed()` / `Math.round()` call. The `round()` helper in `runner.ts` exists for this — use it. Never call `.toFixed()` directly on a value that might be a string from the LLM.
- Prior bug: `s.x.toFixed is not a function` when the LLM returned `x` as a string. Fixed by routing all numeric outputs through `round()`.

## Work Guidance

- When adding a tool: define it in `tools.ts`, add the `executeTool` case, add it to the system prompt catalog, document it in the "Tool surface" list above.
- When changing a tool's schema: every prior session replay that called the old shape will fail. Consider adding a new tool instead of mutating an existing one.
- When debugging the agent loop: add `console.error` temporarily in `runner.ts`, reproduce via the `/api/agent` endpoint, check `dev.log`.
- The runner has a `MAX_ITERATIONS` guard (default 30 tool calls per turn). Exceeding it emits `turn_end` with an `error` field — do not raise.

## Verification

- `bunx tsc --noEmit` — typecheck (note: existing `tools.ts` has pre-existing `any` warnings; do not add more).
- Manual: open the app, type a prompt like "create a login form", verify the agent emits 5-15 tool calls and the canvas updates live.
- Check `dev.log` for runtime errors during a run.
- The runner is exercised end-to-end by `scripts/screenshot-ui-after.ts` (captures agent-working state).

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `tools.ts` + `runner.ts`.
