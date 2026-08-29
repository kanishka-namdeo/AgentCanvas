// Plugin registry — central registration point for AgentCanvas plugins.
//
// This module is the integration hub for the 8 plugins we've ported from the
// pi-coding-agent ecosystem. Each plugin is implemented as a self-contained
// module in this directory that exports:
//
//   - `tools`           — `ToolDefinition[]` for the agent (defineTool)
//   - `pluginId`        — string identifier (used in settings + logs)
//   - `pluginName`      — human-readable name (shown in Settings UI)
//   - `defaultEnabled`  — whether the plugin is on by default
//   - `category`        — used by the Settings UI to group plugins
//   - `description`     — one-line description for the Settings UI
//
// The runner queries `getEnabledPlugins(settings)` to build the final
// `customTools` array passed to `createAgentSession`.
//
// Plugins implemented:
//
//   1. ask-user-question  — typed clarifying questions during agent turns
//   2. todo              — task list overlay that survives compaction
//   3. memory            — long-term memory with semantic search
//   4. mega-compact      — vector-backed context compression
//   5. goal-list-loop-audit — mission control for long-running design jobs
//   6. mcp-adapter       — Model Context Protocol server connections
//   7. background-tasks  — durable background task execution
//   8. subagents         — reviewer/oracle/worker sub-agent profiles

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentRunSettings } from '../../settings/types';

import * as askUserQuestion from './ask-user-question';
import * as todo from './todo';
import * as memory from './memory';
import * as megaCompact from './mega-compact';
import * as goalListLoopAudit from './goal-list-loop-audit';
import * as mcpAdapter from './mcp-adapter';
import * as backgroundTasks from './background-tasks';
import * as subagents from './subagents';

// ---- Plugin manifest -------------------------------------------------------

export interface PluginManifest {
  /// Stable identifier (used in settings.storage keys).
  pluginId: string;
  /// Human-readable name (shown in Settings UI).
  pluginName: string;
  /// One-line description for the Settings UI.
  description: string;
  /// Settings UI category.
  category: PluginCategory;
  /// Whether the plugin is enabled by default (user can toggle in Settings).
  defaultEnabled: boolean;
  /// The tool definitions this plugin contributes.
  tools: ToolDefinition[];
}

export type PluginCategory =
  | 'interaction'    // user-interaction tools (ask_user_question, todo)
  | 'memory'         // long-term memory (memory)
  | 'context'        // context management (mega-compact)
  | 'orchestration'  // multi-agent / multi-step (subagents, goal-list-loop-audit, background-tasks)
  | 'external';      // external integrations (mcp-adapter)

// ---- All plugins -----------------------------------------------------------

const ALL_PLUGINS: PluginManifest[] = [
  {
    pluginId: 'ask-user-question',
    pluginName: 'Ask User Question',
    description: 'Lets the agent ask typed clarifying questions mid-turn (light/dark, primary color, etc.)',
    category: 'interaction',
    defaultEnabled: true,
    tools: askUserQuestion.tools,
  },
  {
    pluginId: 'todo',
    pluginName: 'Todo Overlay',
    description: 'A task list overlay the agent updates — survives compaction, visible in the AgentPanel',
    category: 'interaction',
    defaultEnabled: true,
    tools: todo.tools,
  },
  {
    pluginId: 'memory',
    pluginName: 'Long-term Memory',
    description: 'Persistent memory with semantic search — replaces hand-rolled pattern-memory',
    category: 'memory',
    defaultEnabled: true,
    tools: memory.tools,
  },
  {
    pluginId: 'mega-compact',
    pluginName: 'Mega Compact',
    description: 'Vector-backed context compression with deduped recall — replaces in-place truncation',
    category: 'context',
    defaultEnabled: false,
    tools: megaCompact.tools,
  },
  {
    pluginId: 'goal-list-loop-audit',
    pluginName: 'Goal List + Loop Audit',
    description: 'Mission control for long-running jobs: interviews goals, audited task queue, forever-loops',
    category: 'orchestration',
    defaultEnabled: false,
    tools: goalListLoopAudit.tools,
  },
  {
    pluginId: 'mcp-adapter',
    pluginName: 'MCP Adapter',
    description: 'Connect to Model Context Protocol servers (Figma, GitHub, Notion, Style Dictionary, etc.)',
    category: 'external',
    defaultEnabled: false,
    tools: mcpAdapter.tools,
  },
  {
    pluginId: 'background-tasks',
    pluginName: 'Background Tasks',
    description: 'Durable background task execution — for "generate 50 variations overnight" type jobs',
    category: 'orchestration',
    defaultEnabled: false,
    tools: backgroundTasks.tools,
  },
  {
    pluginId: 'subagents',
    pluginName: 'Sub-agents (reviewer, oracle, worker)',
    description: 'Multi-agent delegation: reviewer (second design critique), oracle (second opinion), worker (unavailable)',
    category: 'orchestration',
    // Audit 2-b T8 / audit 2-c S3-S4: default OFF. The runner's mandatory
    // critique loop is the single critique authority (design-critic +
    // design-critic-vlm with prior-content scoping); subagent_reviewer
    // duplicated it with a WORSE prompt and no prior-shape scoping (a
    // regression vector for the "critic flags user's earlier screens"
    // bug), and subagent_worker was a success-theater placeholder. The
    // module's getActiveLLM()/setActiveCanvas() side-door remains
    // load-bearing (variant-generator + brief/critic fallbacks use it)
    // regardless of this toggle. Users can still enable it in Settings.
    defaultEnabled: false,
    tools: subagents.tools,
  },
];

// ---- Public API ------------------------------------------------------------

export function getAllPlugins(): PluginManifest[] {
  return ALL_PLUGINS;
}

export function getEnabledPlugins(settings: AgentRunSettings | undefined): PluginManifest[] {
  const enabledList = (settings as unknown as { enabledPlugins?: string[] } | undefined)?.enabledPlugins;
  if (!enabledList) {
    return ALL_PLUGINS.filter((p) => p.defaultEnabled);
  }
  const set = new Set(enabledList);
  return ALL_PLUGINS.filter((p) => set.has(p.pluginId));
}

export function getEnabledPluginTools(settings: AgentRunSettings | undefined): ToolDefinition[] {
  const plugins = getEnabledPlugins(settings);
  const tools: ToolDefinition[] = [];
  for (const p of plugins) tools.push(...p.tools);
  return tools;
}

export function getEnabledPluginToolNames(settings: AgentRunSettings | undefined): Set<string> {
  const tools = getEnabledPluginTools(settings);
  return new Set(tools.map((t) => t.name));
}

export function getPlugin(pluginId: string): PluginManifest | undefined {
  return ALL_PLUGINS.find((p) => p.pluginId === pluginId);
}
