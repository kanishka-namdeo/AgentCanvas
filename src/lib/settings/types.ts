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
/// Approval gate for destructive agent operations (Cursor's "Run command?"
/// / Cline's Approve-button pattern).
///   - 'destructive' (default): pen_clear, pen_delete_shape, figma_delete_page,
///     pen_clear_pattern_memory pause the agent until the user Allows/Denies.
///   - 'review': no per-call gating — the agent runs freely, but the diff
///     card on the affected turn surfaces a prominent "Restore from before
///     this turn" action so the user can revert the entire turn as a batch.
///     Useful when you trust the agent to act but want a single bulk-undo
///     affordance per turn instead of N interruptive dialogs.
///   - 'off': no gating AND no review affordance — the agent runs everything
///     autonomously (the pre-gate behavior; only disable for trusted automation).
export type ApprovalMode = 'destructive' | 'review' | 'off';

/// Agent mode (Cursor-style, see src/lib/agent/modes.ts): what the agent is
/// ALLOWED to do on a turn — orthogonal to the model picker.
///   - 'build' (default): full toolset; the agent designs + edits the canvas.
///   - 'ask':  read-only toolset — questions about the canvas get answers,
///     never mutations. Structurally enforced at tool-registry assembly.
///   - 'plan': read-only toolset + submit_plan — the agent proposes a plan
///     artifact; the user approves ("Build it" / "Keep planning"); an
///     approved plan executes in a build-toolset session carrying the plan.
export type AgentMode = 'build' | 'ask' | 'plan';

/// Canvas renderer backend (spec docs/html-dom-renderer.md). DOM is the only
/// live renderer as of the SVG-renderer-removal sweep — real divs per node +
/// inline SVG islands for vector primitives + screen-space chrome overlay +
/// native CSS layout + L4/L5 culling. The 'svg' option was removed in the
/// post-Phase-5 cleanup (the classic single-<svg> renderer is gone; the
/// SVG-as-export-format path in `src/lib/canvas/export.ts` is unaffected and
/// remains the user-facing Export-as-SVG feature). The field is kept on
/// AppSettings for forward compatibility — old persisted blobs with
/// `renderer: 'svg'` are silently coerced to 'dom' at the call site.
export type RendererMode = 'dom';

/// DOM renderer layout strategy (spec §3.4 dual layout mode, Phase 2).
/// 'parity' = every node absolutely positioned from the resolver's computed
/// geometry (default — the DOM tree is a projection of the resolver's
/// numbers; layout authority lives in the resolver).
/// 'native' = containers with `layout ≠ 'none'` render as real CSS flexbox
/// and the browser is the layout authority (measured-bounds readback feeds
/// real sizes back to the resolver as hints). Optional field: absent
/// (pre-Phase-2 settings blob) resolves to 'parity' at the call site, so no
/// migrate bump is needed.
export type CanvasLayoutMode = 'parity' | 'native';

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
  /// Approval gate for destructive agent operations.
  /// 'destructive' gates clear/delete tools on a human Allow/Deny prompt.
  /// 'review' lets the agent run freely but surfaces a per-turn restore
  /// action on the diff card (post-hoc batch review).
  /// 'off' disables both gating and the restore affordance.
  approvalMode: ApprovalMode;
  /// Tools the user has permanently allowed via the "Always allow this tool"
  /// checkbox in the approval dialog. The runner seeds the gate's in-memory
  /// allow-set from this list at the start of every run; the approval
  /// endpoint adds to it when the user checks the box. Stored in
  /// localStorage so the preference survives reloads.
  alwaysAllowTools: string[];

  // ── Phase 1: Appearance ───────────────────────────────────────────────────
  /// 'system' follows the OS prefers-color-scheme.
  themePreference: ThemePreference;
  /// Canvas renderer backend. Always 'dom' — the SVG renderer was removed
  /// in the post-Phase-5 cleanup sweep. Optional because pre-cleanup
  /// settings blobs may carry the legacy 'svg' value; consumers coerce to
  /// 'dom' at the call site. Kept on the type so persisted settings don't
  /// break on load.
  renderer?: RendererMode;
  /// DOM renderer layout strategy — 'parity' (resolver geometry, default) or
  /// 'native' (browser CSS flexbox layout, spec Phase 2).
  /// Optional because pre-Phase-2 settings blobs lack it; consumers default to 'parity'.
  canvasLayoutMode?: CanvasLayoutMode;
  /// Phase 4 L4 + L5 culling (spec §4.2). When true, the DOM renderer emits
  /// `content-visibility: auto` + `contain` on container subtrees (L4) and
  /// the L5 CullingCoordinator swaps far-offscreen top-level frames for
  /// placeholder divs above ~2k nodes per page. The flag exists so power
  /// users can disable culling for debugging or for measurement-sensitive
  /// workflows (e.g., measuring an offscreen subtree via
  /// `pen_get_computed` while the rest of the page is culled). Optional —
  /// pre-Phase-4 settings blobs lack it; consumers default to true (culling
  /// is on by default).
  domCulling?: boolean;

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
  /// Max snapshots per canvas (per document — shared canvas model). Oldest
  /// non-bookmarked snapshots auto-deleted.
  maxSnapshotsPerCanvas: number;

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

  // ── Phase 6: Agent modes (Cursor-style) ──────────────────────────────────
  /// Sticky agent mode (Build / Ask / Plan) — the composer's mode picker and
  /// the /ask /plan /build slash commands write it. Optional: pre-mode
  /// settings blobs lack it; read sites default to 'build' so the persisted
  /// blob needs no migration.
  agentMode?: AgentMode;
}

export const DEFAULT_SETTINGS: AppSettings = {
  temperature: 0.6,
  maxIterations: 30,
  planFirst: true,
  thinkingLevel: 'high',
  defaultPalette: 'slate',
  approvalMode: 'destructive',
  alwaysAllowTools: [],

  themePreference: 'system',
  // DOM is the only live renderer (post-Phase-5 cleanup). The Settings UI
  // no longer surfaces a renderer picker. Persisted blobs from before the
  // cleanup that still carry the legacy 'svg' value are silently coerced
  // to 'dom' by the store's migrate function (see src/lib/settings/store.ts).
  renderer: 'dom' as RendererMode,
  // Phase 4: culling defaults to ON — only active when the document
  // exceeds the budget thresholds (L5: ≥2k nodes per page; L4 is always on
  // for container types).
  domCulling: true,

  llmProvider: 'custom',
  apiKey: '123456',
  // Default inference endpoint: a custom OpenAI-compatible endpoint serving
  // kimi-k2-5 (see pi-ai-model-resolver.ts — the resolver builds a synthetic
  // openai-completions Model for custom endpoints because pi-ai's static
  // catalog doesn't know them). The four fields are pinned explicitly so
  // Settings shows the real endpoint/model on first run.
  modelName: 'kimi-k2-5',
  apiBaseUrl: 'https://irhnglwoxe.a.pinggy.link/v1',

  snapshotCadence: 'every-turn',
  maxSessionsRetained: 100,
  maxSnapshotsPerCanvas: 50,

  skillSelectionMode: 'auto',
  autoArchiveIdleAfter: 'never',
  density: 'comfortable',

  // Cursor-style mode system (see src/lib/agent/modes.ts). 'build' preserves
  // the pre-mode behavior for every existing user + test.
  agentMode: 'build' as AgentMode,
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
  approvalMode: ApprovalMode;
  /// Tools the user has permanently allowed via the "Always allow this tool"
  /// checkbox in the approval dialog. Seeded into the gate's in-memory
  /// allow-set at the start of every run.
  alwaysAllowTools: string[];
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
  /// Agent mode for this turn (Cursor-style): 'build' | 'ask' | 'plan'.
  /// Rides the settings object through every leg (client store → WS/HTTP →
  /// route → runner) untouched; the runner enforces it at tool-registry
  /// assembly (ask/plan physically cannot see mutating tools). Absent →
  /// 'build' (pre-mode behavior).
  mode?: AgentMode;
  /// Task 7-c P1.3 (T2): max iterations of the MANDATORY self-critique loop
  /// that runs after the agent emits its final message. Each iteration:
  ///   1. Dispatches BOTH the text-based design critic
  ///      (`dispatchDesignCriticSubAgent`) AND the vision-based VLM critic
  ///      (`dispatchDesignCriticVlmSubAgent` — when T3 is wired in).
  ///   2. Merges their defects and feeds them back to the agent as a
  ///      re-prompt: "Fix these defects via pen_update_shape / pen_create_shape."
  ///   3. Runs another agent turn to apply the fixes.
  /// Loop exits when (a) the critique's severity is "low", (b) the
  /// pre-complete validation gate passes (`validateCanvasBeforeComplete`),
  /// or (c) the iteration cap is hit.
  /// Default 2 — agent gets 1 chance to self-correct after the critic
  /// (1st critique → 1 fix turn → 2nd critique to verify → exit).
  /// Set to 0 to disable the mandatory loop (reverts to the pre-7-c
  /// behavior where pen_self_critique was opt-in).
  maxDesignCritiqueIterations?: number;
  /// Design-System Registry pack name (e.g. 'shadcn-default',
  /// 'vercel-geist', 'mantine-default'). When set, the runner:
  ///   1. Appends the design-system prompt fragment to the system prompt,
  ///      telling the agent which pack is in scope and which CSS variables
  ///      to reference (`var(--color-accent)`, `var(--color-text-primary)`,
  ///      `var(--radius-card)`, etc.).
  ///   2. The Canvas component (client-side) injects the pack's tokens.css
  ///      as a `<style>` tag on the world root, so any `var(--*)` the agent
  ///      emits resolves to the pack's actual values.
  /// When undefined, the agent runs as before (no pack context, agent
  /// invents palette / spacing from the legacy `$color.*` variable space).
  /// Sourced from the active-pack localStorage entry set by the
  /// `DesignSystemPicker` (see `src/hooks/use-design-systems.ts`).
  pack?: string;
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
    approvalMode: s.approvalMode,
    alwaysAllowTools: Array.isArray(s.alwaysAllowTools) ? s.alwaysAllowTools : [],
    skillSelectionMode: s.skillSelectionMode,
    llmProvider: s.llmProvider,
    apiKey: s.apiKey,
    modelName: s.modelName,
    apiBaseUrl: s.apiBaseUrl,
    enabledPlugins: s.enabledPlugins,
    mcpServers: s.mcpServers,
    // Cursor-style mode system: the sticky composer mode rides every run.
    mode: s.agentMode ?? 'build',
    // Task 7-c P1.3 — default to 2 mandatory critique iterations.
    // NOTE (2026-08-30 modes update): the critique loop is now ADAPTIVE
    // (modes.ts shouldRunCritics) — 2 stays the iteration CAP; which turns
    // run critics at all is complexity-gated (small clean turns get
    // validator-only repair, ~3 LLM calls saved per gated turn).
    maxDesignCritiqueIterations: 2,
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
