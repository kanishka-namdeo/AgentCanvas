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

export type LLMProvider = 'zai-auto' | 'zai-key' | 'openai-compatible';
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  temperature: 0.4,
  maxIterations: 20,
  planFirst: true,
  defaultPalette: 'slate',

  themePreference: 'system',

  llmProvider: 'zai-auto',
  apiKey: '',
  modelName: '',
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
  defaultPalette: DefaultPalette;
  skillSelectionMode: SkillSelectionMode;
  llmProvider: LLMProvider;
  apiKey: string;
  modelName: string;
  apiBaseUrl: string;
}

/// Extract the agent-run-relevant subset from the full settings object.
/// The client calls this when constructing the POST /api/agent body.
export function agentRunSettings(s: AppSettings): AgentRunSettings {
  return {
    temperature: s.temperature,
    maxIterations: s.maxIterations,
    planFirst: s.planFirst,
    defaultPalette: s.defaultPalette,
    skillSelectionMode: s.skillSelectionMode,
    llmProvider: s.llmProvider,
    apiKey: s.apiKey,
    modelName: s.modelName,
    apiBaseUrl: s.apiBaseUrl,
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
