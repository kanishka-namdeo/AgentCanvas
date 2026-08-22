// App settings — user-tunable knobs for the agent loop, LLM provider, canvas
// defaults, sessions/history, and appearance.
//
// Persistence: localStorage via Zustand `persist` middleware (single-key JSON
// blob under `agentcanvas.settings.v1`). The store is the single source of
// truth; the agent runner + /api/agent route read from it via the request
// body (the client injects settings into every POST /api/agent call).
//
// SECURITY NOTE: the `apiKey` field is stored in localStorage (client-side
// only) and is never written to disk on the server. This matches the existing
// session-persistence pattern. For production multi-user deployments, swap
// the storage adapter to a server-side secrets manager.
//
// PROVIDER SUPPORT: the `llmProvider` field accepts any of the provider ids
// registered in `src/lib/llm/registry.ts` (zai, openai, anthropic, google,
// mistral, cohere, groq, together, deepseek, openrouter, fireworks, xai,
// perplexity, huggingface, ollama, lmstudio, vllm, custom). For backward
// compatibility with settings saved before this refactor, the legacy values
// 'zai-auto' / 'zai-key' / 'openai-compatible' are still accepted — they're
// migrated to the new ids by `normalizeLLMProvider()` below.

import { listProviderIds, getProviderMetadata } from '@/lib/llm';

/// Thinking level for models that support extended thinking.
/// Mirrors the pi-agent SDK's ThinkingLevel type.
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/// All supported LLM provider ids. This is the source of truth — anything
/// registered in `src/lib/llm/registry.ts` is valid here. We compute it from
/// the registry at module load so we can never drift.
export type LLMProviderId = ReturnType<typeof listProviderIds>[number];

/// Legacy provider values from v0.2.1 (pre-multi-provider). Kept as a union
/// so TypeScript narrows correctly in `normalizeLLMProvider`.
export type LegacyLLMProvider = 'zai-auto' | 'zai-key' | 'openai-compatible';

/// The full LLMProvider type — any registered id PLUS the legacy values.
/// The legacy values get migrated by `normalizeLLMProvider` before reaching
/// the registry.
export type LLMProvider = LLMProviderId | LegacyLLMProvider | string;
export type SnapshotCadence = 'every-turn' | 'every-3-turns' | 'every-5-turns' | 'manual';
export type SkillSelectionMode = 'auto' | 'manual';
export type AutoArchiveIdleAfter = 'never' | '7d' | '30d';
export type Density = 'comfortable' | 'compact';
export type ThemePreference = 'system' | 'light' | 'dark';
export type DefaultPalette = 'slate' | 'warm' | 'forest' | 'mono';

export interface AppSettings {
  // ── Phase 1: Agent behavior ──────────────────────────────────────────────
  /// LLM sampling temperature. 0.0 = deterministic, 1.0 = very creative.
  /// Default 0.4 matches the previous hard-coded value in runner.ts.
  temperature: number;
  /// Max LLM iterations per turn (each iteration = one tool-call round).
  /// Default 20 matches the previous MAX_ITERATIONS const.
  maxIterations: number;
  /// Whether the agent should emit a "plan first" preamble before tool calls.
  /// Default true matches the previous system-prompt behavior.
  planFirst: boolean;
  /// Thinking level for models that support extended thinking.
  /// 'off' = no thinking, 'max' = maximum thinking budget.
  /// Default 'medium' balances quality vs. speed.
  thinkingLevel: ThinkingLevel;
  /// Default color palette the agent suggests for new designs.
  /// Default 'slate' matches the previous first-listed palette in the system prompt.
  defaultPalette: DefaultPalette;

  // ── Phase 1: Appearance ───────────────────────────────────────────────────
  /// 'system' follows the OS prefers-color-scheme.
  themePreference: ThemePreference;

  // ── Phase 2: LLM provider ────────────────────────────────────────────────
  /// Which LLM client to construct in the runner.
  /// - zai-auto: use ZAI.create() (auto-resolves credentials in z.ai sandbox).
  /// - zai-key: use ZAI.create() with an explicit API key (for non-sandbox use).
  /// - openai-compatible: use a custom OpenAI-compatible endpoint.
  llmProvider: LLMProvider;
  /// API key for the chosen provider. Stored in localStorage only.
  apiKey: string;
  /// Model name (e.g. 'gpt-4o', 'glm-4.5', 'qwen-max'). Empty = provider default.
  modelName: string;
  /// Custom API base URL for OpenAI-compatible providers (e.g. 'https://api.openai.com/v1',
  /// 'https://api.together.xyz/v1', 'http://localhost:11434/v1' for Ollama).
  /// Empty = provider default.
  apiBaseUrl: string;

  // ── Phase 2: Sessions & history ──────────────────────────────────────────
  /// When to capture canvas snapshots.
  snapshotCadence: SnapshotCadence;
  /// Max sessions retained in localStorage. Older sessions auto-archived.
  maxSessionsRetained: number;
  /// Max snapshots per session. Older snapshots auto-deleted.
  maxSnapshotsPerSession: number;

  // ── Phase 3: Power-user ──────────────────────────────────────────────────
  /// 'auto' = classifier picks skill; 'manual' = user pins a skill.
  /// (For now, 'manual' falls back to 'multi' category = all core tools + no
  /// skill-specific body. A future skill-picker UI could let users choose.)
  skillSelectionMode: SkillSelectionMode;
  /// Auto-archive sessions idle for N days.
  autoArchiveIdleAfter: AutoArchiveIdleAfter;
  /// UI density. 'comfortable' = current spacing; 'compact' = tighter spacing.
  density: Density;

  // ── Phase 5: Plugins ─────────────────────────────────────────────────────
  /// List of enabled plugin IDs (from Settings → Plugins). When omitted,
  /// each plugin's `defaultEnabled` flag is used.
  enabledPlugins?: string[];
  /// MCP server configurations (from Settings → MCP Servers).
  mcpServers?: McpServerConfig[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  temperature: 0.6,
  maxIterations: 30,
  planFirst: true,
  thinkingLevel: 'high',
  defaultPalette: 'slate',

  themePreference: 'system',

  llmProvider: 'zai',
  apiKey: '',
  // Default model for testing in the z.ai sandbox: glm-5.3 (the flagship in
  // pi-ai's zai catalog; served by the sandbox auto-credential endpoint —
  // see pi-ai-model-resolver.ts). Empty string would fall back to the
  // registry default; we pin it explicitly so Settings shows the real model.
  modelName: 'glm-5.3',
  apiBaseUrl: '',

  snapshotCadence: 'every-turn',
  maxSessionsRetained: 100,
  maxSnapshotsPerSession: 50,

  skillSelectionMode: 'auto',
  autoArchiveIdleAfter: 'never',
  density: 'comfortable',
};

/// Subset of settings that the /api/agent route consumes. Sent in the
/// request body alongside { documentId, prompt, canvasState }. Keeping this
/// a separate type makes it obvious which fields the server actually reads.
export interface AgentRunSettings {
  temperature: number;
  maxIterations: number;
  planFirst: boolean;
  thinkingLevel: ThinkingLevel;
  defaultPalette: DefaultPalette;
  skillSelectionMode: SkillSelectionMode;
  llmProvider: LLMProvider;
  apiKey: string;
  modelName: string;
  apiBaseUrl: string;
  /// List of enabled plugin IDs. When omitted, each plugin's `defaultEnabled`
  /// flag is used. Sourced from the Settings → Plugins panel.
  enabledPlugins?: string[];
  /// MCP server configurations (for the mcp-adapter plugin). Each entry is
  /// a server the user has added via Settings → MCP Servers.
  mcpServers?: McpServerConfig[];
}

/// Configuration for an MCP server connection (used by the mcp-adapter plugin).
export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  /// For stdio: the command to run (e.g. "npx"). For sse/http: the URL.
  command?: string;
  args?: string[];
  url?: string;
  /// Optional env vars to pass to the server process.
  env?: Record<string, string>;
  /// Whether the server should auto-connect on startup.
  autoConnect?: boolean;
  // ---- Runtime state (set by the mcp-adapter, not by the user) -------------
  /// Current connection status. Undefined = never connected.
  status?: 'connected' | 'disconnected' | 'error';
  /// Status message (e.g. error description or tool count).
  message?: string;
  /// Number of tools the server exposes (when connected).
  toolCount?: number;
}

/// Extract the agent-run-relevant subset from the full settings object.
/// The client calls this when constructing the POST /api/agent body.
export function agentRunSettings(s: AppSettings): AgentRunSettings {
  return {
    temperature: s.temperature,
    maxIterations: s.maxIterations,
    planFirst: s.planFirst,
    thinkingLevel: s.thinkingLevel,
    defaultPalette: s.defaultPalette,
    skillSelectionMode: s.skillSelectionMode,
    llmProvider: s.llmProvider,
    apiKey: s.apiKey,
    modelName: s.modelName,
    apiBaseUrl: s.apiBaseUrl,
    enabledPlugins: s.enabledPlugins,
    mcpServers: s.mcpServers,
  };
}

/// Palettes as referenced by the system prompt's "DESIGN PRINCIPLES" section.
/// The default palette's colors are listed first in the prompt, nudging the
/// agent toward the user's preferred starting point.
export const PALETTES: Record<DefaultPalette, { name: string; bg: string; fills: string[]; accent: string; text: string }> = {
  slate:  { name: 'Slate',  bg: '#f8fafc', fills: ['#e2e8f0', '#cbd5e1', '#94a3b8'], accent: '#0ea5e9', text: '#0f172a' },
  warm:   { name: 'Warm',   bg: '#fff7ed', fills: ['#fed7aa', '#fdba74', '#fb923c'], accent: '#ea580c', text: '#431407' },
  forest: { name: 'Forest', bg: '#f0fdf4', fills: ['#dcfce7', '#bbf7d0', '#86efac'], accent: '#16a34a', text: '#052e16' },
  mono:   { name: 'Mono',   bg: '#fafaf9', fills: ['#e7e5e4', '#d6d3d1', '#a8a29e'], accent: '#18181b', text: '#18181b' },
};

/// Migrate legacy provider values to their new ids.
/// - 'zai-auto'         → 'zai'        (auto-credentials preserved)
/// - 'zai-key'           → 'zai'        (explicit key — apiKey field is preserved)
/// - 'openai-compatible' → 'custom'     (the generic escape hatch)
///
/// Returns 'zai' (the safe default) if the provider id is unknown — e.g.
/// a settings blob from a future version that referenced a provider no
/// longer in the registry.
export function normalizeLLMProvider(id: string | undefined | null): string {
  if (!id) return 'zai';
  if (id === 'zai-auto' || id === 'zai-key') return 'zai';
  if (id === 'openai-compatible') return 'custom';
  if (getProviderMetadata(id)) return id;
  return 'zai';
}

/// True if the given provider id (after normalization) requires an API key
/// in the request.
export function providerRequiresApiKey(id: string | undefined | null): boolean {
  const normalized = normalizeLLMProvider(id);
  const meta = getProviderMetadata(normalized);
  return meta?.apiKeyRequired ?? false;
}

/// Get the default model name for a provider.
export function providerDefaultModel(id: string | undefined | null): string {
  const normalized = normalizeLLMProvider(id);
  return getProviderMetadata(normalized)?.defaultModel ?? '';
}

/// Get the default base URL for a provider.
export function providerDefaultBaseURL(id: string | undefined | null): string {
  const normalized = normalizeLLMProvider(id);
  return getProviderMetadata(normalized)?.defaultBaseURL ?? '';
}
