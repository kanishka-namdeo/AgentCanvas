# AGENTS.md — `src/lib/agent/plugins/`

## Purpose

The agent plugin subsystem: a registry of 8 ported pi-agent plugins exposing up to 32 additional tools, gated per-user by `settings.enabledPlugins` (14 tools default-enabled). Plugins add interactive runtime capabilities — blocking questions, todo lists, long-term memory, context compaction, goal tracking, background tasks, MCP servers, sub-agents — without touching the core tool surface in `tools.ts`.

## Ownership

- `index.ts` — plugin registry: `ALL_PLUGINS` manifest (pluginId, pluginName, description, category, defaultEnabled, tools) + `getEnabledPlugins` / `getEnabledPluginTools` / `getEnabledPluginToolNames` / `getPlugin` / `getAllPlugins`, all gated by `settings.enabledPlugins`. `/api/plugins` serves these manifests.
- `event-bus.ts` — module-level per-turn `SyncEvent` sink installed by `runAgentNative`; `setEventSink` / `emitEvent` / `hasSink` let plugin tools fire UI events mid-turn.
- `ask-user-question.ts` — `ask_user_question` tool: emits `agent:ask_user_question`, blocks for answers resolved via `/api/agent/answers` (5-minute timeout); also backs `/api/agent/pending`.
- `todo.ts` — 5 `todo_*` tools maintaining a per-session todo list; each mutation emits `agent:todo_update`.
- `memory.ts` — 5 `memory_*` + `scratchpad` tools over file-backed long-term memory in `~/.pi/agent/memory/` (MEMORY.md, SCRATCHPAD.md, daily log).
- `mega-compact.ts` — 3 `compact_*` tools: TF-IDF-indexed compaction summaries with deduped recall.
- `goal-list-loop-audit.ts` — 5 `goal_*` tools: goal interview + audited task queue for long-running design jobs (in-memory state).
- `background-tasks.ts` — 5 `background_*` tools: durable background task execution with status polling via `/api/agent/background/[id]`.
- `mcp-adapter.ts` — 5 `mcp_*` tools: MCP server registry/connections configured via `settings.mcpServers` and controlled through `/api/mcp/[id]` (placeholder connection — real MCP SDK wiring is a tracked TODO).
- `subagents.ts` — 3 `subagent_*` tools (reviewer/oracle/worker profiles) delegating via the provider-aware LLM client.

## Local Contracts

- **Manifest contract**: every plugin registers `{ pluginId, pluginName, description, category, defaultEnabled, tools }`. The Settings → Plugins section renders these manifests and merges them with the client-side `enabledPlugins` toggle state — user toggles are NOT persisted server-side.
- **Event-sink pattern**: plugin tools never touch the Zustand store or sockets directly; they call `emitEvent()` from `event-bus.ts` and the runner fans events out to viewers.
- **Per-session state** lives in module-level Maps keyed by session/toolCall id (questions, todos, goals, background tasks) — no DB. A server restart clears it; `/api/agent/pending` exists so reloads can recover unanswered questions.
- **Tool gating**: `getEnabledPluginTools(settings)` is the single choke point — the runner must not import plugin tools any other way.
- Plugin tool names must not collide with the core `pen_*` / `figma_` / `web_*` prefixes.

## Work Guidance

- When adding a plugin: add the manifest to `ALL_PLUGINS`, implement tools with `@sinclair/typebox` schemas matching the core pattern, wire events through `event-bus.ts`, and add an Ownership row here.
- When changing the question flow: update `ask-user-question.ts`, `/api/agent/answers`, `/api/agent/pending`, `PluginUI.tsx`'s `AskUserQuestionDialog`, and the canvas store's `submitQuestionAnswers` together — all five are coupled.
- When the MCP SDK integration lands: replace the placeholder registry in `mcp-adapter.ts`, keep the `/api/mcp/[id]` + `settings.mcpServers` contract, and update this doc + `src/app/api/AGENTS.md`.

## Verification

- `bun run test` — plugin-related unit coverage (tools, agentic workflows).
- Manual: Settings → Plugins → toggle a plugin → run a prompt that uses it (e.g. ask the agent to "plan with todos") → TodoOverlay updates live.
- Manual: agent asks a question → `AskUserQuestionDialog` appears → answer → run continues; reload mid-question → dialog recovers via `/api/agent/pending`.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
