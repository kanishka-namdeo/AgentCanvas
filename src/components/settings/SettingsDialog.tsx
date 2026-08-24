'use client';

// SettingsDialog — the full settings workflow (Phases 1, 2, and 3).
//
// Layout: a left vertical nav of section names + a right content pane showing
// the active section's form fields. Mirrors the pattern used by VS Code's
// Settings, Linear's Settings, and macOS System Preferences.
//
// Sections:
//   1. Agent behavior   — temperature, maxIterations, thinkingLevel, planFirst, defaultPalette, skillSelectionMode
//   2. LLM provider     — provider (registry list), apiKey, modelName, apiBaseUrl
//   3. Sessions         — snapshotCadence, maxSessionsRetained, maxSnapshotsPerSession, autoArchiveIdleAfter
//   4. Appearance       — theme, density
//   5. Data & privacy   — storage usage, export all, clear all
//   6. Shortcuts        — read-only reference list
//   7. Plugins          — agent plugin toggles (fetched from /api/plugins)
//   8. MCP Servers      — add/remove/connect/disconnect MCP servers
//
// All settings are read from / written to the Zustand settings store, which
// persists to localStorage automatically. Changes apply immediately — no
// "Save" button required.

import { useState, useEffect, useRef } from 'react';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Bot, KeyRound, Sliders, History, Palette, ShieldCheck,
  Keyboard, RotateCcw, Download, Trash2, AlertTriangle,
  Plug, Server, Plus, X, CheckCircle2, XCircle, Loader2,
} from 'lucide-react';
import { useSettings } from '@/lib/settings/store';
import {
  DEFAULT_SETTINGS, PALETTES,
  type LLMProvider, type SnapshotCadence, type SkillSelectionMode,
  type AutoArchiveIdleAfter, type Density, type ThemePreference,
  type DefaultPalette, type ThinkingLevel, type McpServerConfig,
  normalizeLLMProvider,
  providerRequiresApiKey,
  providerDefaultModel,
  providerDefaultBaseURL,
} from '@/lib/settings/types';
import { listProviders, getProviderMetadata } from '@/lib/llm';
import { useSessionStore, estimateLocalStorageUsage, sweepIdleSessions } from '@/lib/sessions';
import { useCanvasStore } from '@/lib/canvas/store';
import { toast } from 'sonner';

type Section =
  | 'agent' | 'llm' | 'sessions' | 'appearance' | 'data' | 'shortcuts' | 'plugins' | 'mcp';

const SECTIONS: { id: Section; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'agent',       label: 'Agent',        icon: Bot },
  { id: 'llm',         label: 'LLM provider', icon: KeyRound },
  { id: 'sessions',    label: 'Sessions',     icon: History },
  { id: 'appearance',  label: 'Appearance',   icon: Palette },
  { id: 'data',        label: 'Data',         icon: ShieldCheck },
  { id: 'plugins',     label: 'Plugins',      icon: Plug },
  { id: 'mcp',         label: 'MCP Servers',  icon: Server },
  { id: 'shortcuts',   label: 'Shortcuts',    icon: Keyboard },
];

export function SettingsDialog({
  open, onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [section, setSection] = useState<Section>('agent');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl p-0 overflow-visible gap-0" showCloseButton>
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure the agent, LLM provider, sessions, appearance, and data.
          Changes apply immediately.
        </DialogDescription>
        <div className="flex h-[80vh] max-h-[640px] min-h-[480px]">
          {/* Left nav */}
          <nav className="w-48 flex-shrink-0 border-r ac-border-subtle ac-surface-1 p-2 space-y-0.5">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] font-medium ac-transition ac-focus-ring ${
                    active
                      ? 'ac-surface-0 ac-text-1 shadow-sm'
                      : 'ac-text-3 hover:ac-text-1 hover:ac-surface-2'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {s.label}
                </button>
              );
            })}
            <div className="pt-2 mt-2 border-t ac-border-subtle">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (confirm('Reset all settings to defaults? Your chats + snapshots are NOT affected.')) {
                    useSettings.getState().reset();
                    toast.success('Settings reset to defaults');
                  }
                }}
                className="w-full justify-start gap-2 h-7 text-[11px] ac-text-3 hover:ac-text-1"
              >
                <RotateCcw className="h-3 w-3" />
                Reset to defaults
              </Button>
            </div>
          </nav>

          {/* Right content */}
          <ScrollArea className="flex-1 min-w-0 ac-hide-scrollbar">
            <div className="p-6 space-y-5">
              {section === 'agent' && <AgentSection />}
              {section === 'llm' && <LLMSection />}
              {section === 'sessions' && <SessionsSection />}
              {section === 'appearance' && <AppearanceSection />}
              {section === 'data' && <DataSection />}
              {section === 'plugins' && <PluginsSection />}
              {section === 'mcp' && <McpSection />}
              {section === 'shortcuts' && <ShortcutsSection />}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Reusable row primitive ────────────────────────────────────────────────
// Stacked layout (default): label + description on top, control below at
// full width. Eliminates text cropping on long descriptions/values.
// Pass `stacked={false}` to preserve the side-by-side layout for short rows
// (Switch toggles, small selects with short descriptions).
function Row({ label, description, children, stacked = true }: {
  label: string;
  description?: string;
  children: React.ReactNode;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="space-y-1.5">
        <Label className="text-[13px] font-medium ac-text-1">{label}</Label>
        {description && (
          <p className="text-[12px] ac-text-4 leading-relaxed">{description}</p>
        )}
        <div className="pt-1">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="flex-1 min-w-0">
        <Label className="text-[13px] font-medium ac-text-1">{label}</Label>
        {description && (
          <p className="text-[12px] ac-text-4 mt-0.5 leading-relaxed">{description}</p>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

// ── Section 1: Agent behavior ────────────────────────────────────────────
function AgentSection() {
  const temperature = useSettings((s) => s.temperature);
  const maxIterations = useSettings((s) => s.maxIterations);
  const planFirst = useSettings((s) => s.planFirst);
  const thinkingLevel = useSettings((s) => s.thinkingLevel);
  const defaultPalette = useSettings((s) => s.defaultPalette);
  const skillSelectionMode = useSettings((s) => s.skillSelectionMode);
  const set = useSettings((s) => s.set);

  return (
    <>
      <h2 className="text-[13px] font-semibold ac-text-1 mb-1">Agent behavior</h2>
      <p className="text-[11px] ac-text-4 mb-4 leading-relaxed">
        Tune how the agent reasons and executes. These settings apply to the
        next prompt you send — no reload needed.
      </p>

      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-1">
            <Label className="text-[12px] font-medium ac-text-1">Temperature</Label>
            <span className="text-[11px] font-mono ac-text-2">{temperature.toFixed(1)}</span>
          </div>
          <Slider
            value={[temperature]}
            onValueChange={(v) => set('temperature', v[0])}
            min={0}
            max={1}
            step={0.1}
          />
          <p className="text-[10px] ac-text-4 mt-1">
            Lower = deterministic + faithful to spec. Higher = more creative + varied.
            Default 0.4.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <Label className="text-[12px] font-medium ac-text-1">Max tool calls per turn</Label>
            <span className="text-[11px] font-mono ac-text-2">{maxIterations}</span>
          </div>
          <Slider
            value={[maxIterations]}
            onValueChange={(v) => set('maxIterations', v[0])}
            min={5}
            max={40}
            step={1}
          />
          <p className="text-[10px] ac-text-4 mt-1">
            Each iteration is one LLM round-trip + zero or more tool calls.
            Higher = more complex designs; lower = faster + cheaper. Default 20.
          </p>
        </div>

        <Row
          label="Plan first"
          description="Agent emits a short plan message before calling tools. Disable for faster, no-preamble generation."
        >
          <Switch
            checked={planFirst}
            onCheckedChange={(v) => set('planFirst', v)}
          />
        </Row>

        <Row
          label="Thinking level"
          description="Extended thinking lets the model reason before acting. Higher = better quality on complex tasks, but slower + more tokens. 'off' = fastest."
        >
          <Select
            value={thinkingLevel}
            onValueChange={(v) => set('thinkingLevel', v as ThinkingLevel)}
          >
            <SelectTrigger size="sm" className="h-7 w-40 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((level) => (
                <SelectItem key={level} value={level} className="text-[11px]">
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row
          label="Default palette"
          description="The palette the agent suggests first when no specific colors are requested."
        >
          <Select
            value={defaultPalette}
            onValueChange={(v) => set('defaultPalette', v as DefaultPalette)}
          >
            <SelectTrigger size="sm" className="h-7 w-40 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PALETTES) as DefaultPalette[]).map((key) => (
                <SelectItem key={key} value={key} className="text-[11px]">
                  {PALETTES[key].name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row
          label="Skill auto-selection"
          description="'Auto' = classifier picks the best skill per prompt. 'Manual' = expose all core tools without a pinned skill."
        >
          <Select
            value={skillSelectionMode}
            onValueChange={(v) => set('skillSelectionMode', v as SkillSelectionMode)}
          >
            <SelectTrigger size="sm" className="h-7 w-40 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto" className="text-[11px]">Auto (recommended)</SelectItem>
              <SelectItem value="manual" className="text-[11px]">Manual (no skill pinning)</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </div>
    </>
  );
}

// ── Section 2: LLM provider ──────────────────────────────────────────────
function LLMSection() {
  const llmProvider = useSettings((s) => s.llmProvider);
  const apiKey = useSettings((s) => s.apiKey);
  const modelName = useSettings((s) => s.modelName);
  const apiBaseUrl = useSettings((s) => s.apiBaseUrl);
  const set = useSettings((s) => s.set);

  // Normalize the stored provider (handles legacy 'zai-auto' etc.).
  const normalizedProvider = normalizeLLMProvider(llmProvider as string);
  const meta = getProviderMetadata(normalizedProvider);
  const providers = listProviders();

  // When the user switches providers, pre-fill the model + baseURL with the
  // new provider's defaults if the existing values don't match.
  const handleProviderChange = (newId: string) => {
    const newMeta = getProviderMetadata(newId);
    set('llmProvider', newId as LLMProvider);
    const prevMeta = getProviderMetadata(normalizedProvider);
    if (prevMeta && (modelName === '' || modelName === prevMeta.defaultModel)) {
      set('modelName', newMeta?.defaultModel ?? '');
    }
    if (prevMeta && (apiBaseUrl === '' || apiBaseUrl === prevMeta.defaultBaseURL)) {
      set('apiBaseUrl', newMeta?.defaultBaseURL ?? '');
    }
  };

  const requiresKey = providerRequiresApiKey(normalizedProvider);
  const isLocalProvider = !requiresKey && (normalizedProvider === 'ollama' || normalizedProvider === 'lmstudio' || normalizedProvider === 'vllm');
  const isCustom = normalizedProvider === 'custom';

  return (
    <>
      <h2 className="text-[14px] font-semibold ac-text-1 mb-1.5">LLM provider</h2>
      <p className="text-[12px] ac-text-4 mb-5 leading-relaxed">
        Choose which LLM backend powers the agent. Supports 28 popular providers —
        OpenAI, Anthropic, Google Gemini, Mistral, Groq, Together, DeepSeek,
        OpenRouter, Fireworks, xAI, Perplexity, Hugging Face, plus local Ollama /
        LM Studio / vLLM, recently popular inference platforms (Novita, Hyperbolic,
        Chutes, SambaNova, Cerebras, Deep Infra, SiliconFlow, AI/ML API, Atoma,
        Inception), and a generic Custom escape hatch.
      </p>

      <div className="space-y-5">
        <Row
          label="Provider"
          description={meta?.description || 'Which LLM client to construct on the server.'}
        >
          <Select
            value={normalizedProvider}
            onValueChange={handleProviderChange}
          >
            <SelectTrigger size="sm" className="h-7 w-full sm:max-w-md text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {providers.map((p) => (
                <SelectItem
                  key={p.id}
                  value={p.id}
                  className="text-[11px] flex flex-col items-start"
                >
                  <span>{p.metadata.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        {/* API key — shown for every provider that requires one. */}
        {(requiresKey || isCustom) && (
          <Row
            label="API key"
            description={
              isCustom
                ? 'Paste your provider\'s API key here. Stored in your browser\'s localStorage only.'
                : `Set ${meta?.apiKeyEnvVars.join(' or ')} in your .env, or paste the key here (localStorage only).`
            }
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder={meta?.apiKeyEnvVars[0] ? `${meta.apiKeyEnvVars[0]}=…` : 'sk-…'}
              className="h-7 w-full sm:max-w-md text-[11px] font-mono"
            />
          </Row>
        )}

        {/* Model — always shown (every provider needs a model). */}
        <Row
          label="Model"
          description={
            meta && meta.popularModels.length > 0
              ? `Popular: ${meta.popularModels.slice(0, 3).join(', ')}…  — or type your own.`
              : 'Type the model name your provider expects.'
          }
        >
          {(meta && meta.popularModels.length > 0) ? (
            <Select
              value={modelName || meta.defaultModel}
              onValueChange={(v) => set('modelName', v)}
            >
              <SelectTrigger size="sm" className="h-7 w-full sm:max-w-md text-[11px]">
                <SelectValue placeholder={meta.defaultModel || 'Select a model'} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {meta.popularModels.map((m) => (
                  <SelectItem key={m} value={m} className="text-[11px] font-mono">
                    {m}
                  </SelectItem>
                ))}
                {/* Allow custom models — show current custom value if not in list */}
                {modelName && !meta.popularModels.includes(modelName) && (
                  <SelectItem value={modelName} className="text-[11px] font-mono">
                    {modelName} (custom)
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={modelName}
              onChange={(e) => set('modelName', e.target.value)}
              placeholder={meta?.defaultModel || 'model-name'}
              className="h-7 w-full sm:max-w-md text-[11px] font-mono"
            />
          )}
        </Row>

        {/* API base URL — shown for OpenAI-compatible providers + custom. */}
        {meta?.openAICompatible && (
          <Row
            label="API base URL"
            description={
              isCustom
                ? 'e.g. https://api.openai.com/v1, https://api.together.xyz/v1, http://localhost:11434/v1'
                : `Default: ${meta.defaultBaseURL || '(none)'} — override only if you need a different endpoint.`
            }
          >
            <Input
              value={apiBaseUrl}
              onChange={(e) => set('apiBaseUrl', e.target.value)}
              placeholder={meta.defaultBaseURL || 'https://api.example.com/v1'}
              className="h-7 w-full sm:max-w-md text-[11px] font-mono"
            />
          </Row>
        )}

        {/* Info box for sandbox / local providers */}
        {normalizedProvider === 'zai' && !apiKey && (
          <div className="rounded-md border ac-border-subtle ac-surface-1 p-3 text-[12px] ac-text-3 leading-relaxed">
            <strong className="ac-text-2">No configuration needed inside the z.ai sandbox.</strong>{' '}
            Credentials auto-resolve at runtime. Outside the sandbox, set{' '}
            <code className="font-mono ac-text-1">ZAI_API_KEY</code> in your{' '}
            <code className="font-mono ac-text-1">.env</code> file or paste it above.
          </div>
        )}

        {isLocalProvider && (
          <div className="rounded-md border ac-border-subtle ac-surface-1 p-3 text-[12px] ac-text-3 leading-relaxed">
            <strong className="ac-text-2">Local provider.</strong>{' '}
            Make sure your {meta?.label} server is running at{' '}
            <code className="font-mono ac-text-1">{meta?.defaultBaseURL}</code> before sending a prompt.
            No API key needed.
          </div>
        )}

        {/* Capability flags (informational) */}
        {meta && (
          <div className="rounded-md border ac-border-subtle ac-surface-1 p-3 text-[12px] ac-text-4 leading-relaxed">
            <div className="flex flex-col gap-1.5">
              <span>
                Tool calling: {' '}
                <span className={meta.capabilities.supportsToolCalling ? 'ac-text-2 font-medium' : 'ac-text-4'}>
                  {meta.capabilities.supportsToolCalling ? '✓ supported' : '✗ not supported'}
                </span>
              </span>
              <span>
                Vision: {' '}
                <span className={meta.capabilities.supportsVision ? 'ac-text-2 font-medium' : 'ac-text-4'}>
                  {meta.capabilities.supportsVision ? '✓ supported' : '✗ not supported'}
                </span>
              </span>
              <span>
                API: {' '}
                <span className="ac-text-2 font-medium">
                  {meta.openAICompatible ? 'OpenAI-compatible' : 'native SDK'}
                </span>
              </span>
            </div>
            {meta.docsUrl && (
              <div className="mt-2">
                <Button asChild variant="outline" size="sm">
                  <a href={meta.docsUrl} target="_blank" rel="noopener noreferrer">
                    Get an API key →
                  </a>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── Section 3: Sessions & history ────────────────────────────────────────
function SessionsSection() {
  const snapshotCadence = useSettings((s) => s.snapshotCadence);
  const maxSessionsRetained = useSettings((s) => s.maxSessionsRetained);
  const maxSnapshotsPerSession = useSettings((s) => s.maxSnapshotsPerSession);
  const autoArchiveIdleAfter = useSettings((s) => s.autoArchiveIdleAfter);
  const set = useSettings((s) => s.set);

  return (
    <>
      <h2 className="text-[13px] font-semibold ac-text-1 mb-1">Sessions &amp; history</h2>
      <p className="text-[11px] ac-text-4 mb-4 leading-relaxed">
        Control how the app captures snapshots and retains old sessions. Useful
        for managing localStorage usage on long-running installations.
      </p>

      <div className="space-y-4">
        <Row
          label="Snapshot cadence"
          description="When to auto-capture canvas snapshots. 'Manual' = you must use the History panel's Capture button."
        >
          <Select
            value={snapshotCadence}
            onValueChange={(v) => set('snapshotCadence', v as SnapshotCadence)}
          >
            <SelectTrigger size="sm" className="h-7 w-44 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="every-turn" className="text-[11px]">Every turn (default)</SelectItem>
              <SelectItem value="every-3-turns" className="text-[11px]">Every 3 turns</SelectItem>
              <SelectItem value="every-5-turns" className="text-[11px]">Every 5 turns</SelectItem>
              <SelectItem value="manual" className="text-[11px]">Manual only</SelectItem>
            </SelectContent>
          </Select>
        </Row>

        <Row
          label="Max snapshots per session"
          description="Oldest non-bookmarked snapshots auto-deleted when exceeded."
        >
          <Input
            type="number"
            value={maxSnapshotsPerSession}
            onChange={(e) => set('maxSnapshotsPerSession', Math.max(5, Math.min(200, parseInt(e.target.value) || 50)))}
            min={5}
            max={200}
            className="h-7 w-20 text-[11px]"
          />
        </Row>

        <Row
          label="Max sessions retained"
          description="Older sessions auto-archived when exceeded."
        >
          <Input
            type="number"
            value={maxSessionsRetained}
            onChange={(e) => set('maxSessionsRetained', Math.max(10, Math.min(500, parseInt(e.target.value) || 100)))}
            min={10}
            max={500}
            className="h-7 w-20 text-[11px]"
          />
        </Row>

        <Row
          label="Auto-archive idle sessions"
          description="Sessions you haven't opened in N days get archived automatically."
        >
          <Select
            value={autoArchiveIdleAfter}
            onValueChange={(v) => set('autoArchiveIdleAfter', v as AutoArchiveIdleAfter)}
          >
            <SelectTrigger size="sm" className="h-7 w-40 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="never" className="text-[11px]">Never</SelectItem>
              <SelectItem value="7d" className="text-[11px]">After 7 days</SelectItem>
              <SelectItem value="30d" className="text-[11px]">After 30 days</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </div>
    </>
  );
}

// ── Section 4: Appearance ────────────────────────────────────────────────
function AppearanceSection() {
  const themePreference = useSettings((s) => s.themePreference);
  const density = useSettings((s) => s.density);
  const set = useSettings((s) => s.set);

  // Apply theme preference immediately via the same .dark class toggle that
  // ThemeToggle uses. We also subscribe to OS prefers-color-scheme changes
  // when in 'system' mode.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const apply = () => {
      const isDark =
        themePreference === 'dark' ||
        (themePreference === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', isDark);
    };
    apply();
    if (themePreference === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [themePreference]);

  return (
    <>
      <h2 className="text-[13px] font-semibold ac-text-1 mb-1">Appearance</h2>
      <p className="text-[11px] ac-text-4 mb-4 leading-relaxed">
        Theme + UI density. Applies immediately.
      </p>

      <div className="space-y-4">
        <Row
          label="Theme"
          description="Light, dark, or follow your OS preference."
        >
          <Select
            value={themePreference}
            onValueChange={(v) => {
              set('themePreference', v as ThemePreference);
              // Also write to the legacy key so ThemeToggle stays in sync.
              if (typeof window !== 'undefined') {
                const resolved = v === 'system'
                  ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
                  : v;
                localStorage.setItem('agentcanvas-theme', resolved);
              }
            }}
          >
            <SelectTrigger size="sm" className="h-7 w-40 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system" className="text-[11px]">System</SelectItem>
              <SelectItem value="light" className="text-[11px]">Light</SelectItem>
              <SelectItem value="dark" className="text-[11px]">Dark</SelectItem>
            </SelectContent>
          </Select>
        </Row>

        <Row
          label="Density"
          description="'Comfortable' = current spacing. 'Compact' = tighter spacing (smaller fonts, less padding)."
        >
          <Select
            value={density}
            onValueChange={(v) => set('density', v as Density)}
          >
            <SelectTrigger size="sm" className="h-7 w-40 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="comfortable" className="text-[11px]">Comfortable</SelectItem>
              <SelectItem value="compact" className="text-[11px]">Compact</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </div>

      {density === 'compact' && (
        <div className="mt-4 rounded-md border ac-border-subtle ac-surface-1 p-2.5 text-[10px] ac-text-4 leading-relaxed">
          <strong className="ac-text-2">Compact mode is a soft preference.</strong> It applies
          a <code className="font-mono ac-text-1">data-density="compact"</code> attribute to the
          root element. CSS rules can target <code className="font-mono ac-text-1">[data-density="compact"]</code> to
          tighten spacing globally. Today only a few components respond; full coverage is a
          follow-up.
        </div>
      )}
    </>
  );
}

// ── Section 5: Data & privacy ────────────────────────────────────────────
function DataSection() {
  const [usage, setUsage] = useState(() => estimateLocalStorageUsage());

  const refresh = () => setUsage(estimateLocalStorageUsage());

  // Refresh usage on mount — the useState initializer already computes the
  // initial value, so this is only needed for post-hydration re-computation.
  // Using eslint-disable for the ref-during-render pattern (one-time init).
  const mountedRef = useRef<null | boolean>(null);
   
  if (mountedRef.current === null) {
     
    mountedRef.current = true;
    refresh();
  }

  const handleExport = () => {
    const sessionsData = localStorage.getItem('agentcanvas.sessions.v1') ?? '{}';
    const settingsData = useSettings.getState();
    // Strip setter functions from settings.
    const { set: _s, patch: _p, reset: _r, replaceAll: _ra, ...settingsPlain } = settingsData as any;
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      sessions: JSON.parse(sessionsData),
      settings: settingsPlain,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentcanvas-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success('Exported all data', {
      description: `${(blob.size / 1024).toFixed(1)} KB downloaded.`,
    });
    refresh();
  };

  const handleClearChats = () => {
    if (!confirm('Permanently delete ALL chats, runs, messages, and snapshots? This cannot be undone.')) return;
    const docId = useCanvasStore.getState().documentId;
    useSessionStore.getState().clearAllForDocument(docId);
    toast.success('All chats cleared');
    refresh();
  };

  const handleClearSnapshots = () => {
    if (!confirm('Delete all non-bookmarked snapshots across all sessions?')) return;
    const store = useSessionStore.getState();
    let count = 0;
    for (const snap of Object.values(store.snapshots)) {
      if (!snap.bookmarked) {
        store.deleteSnapshot(snap.id);
        count++;
      }
    }
    toast.success(`Deleted ${count} snapshot${count === 1 ? '' : 's'}`);
    refresh();
  };

  const fmt = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  return (
    <>
      <h2 className="text-[13px] font-semibold ac-text-1 mb-1">Data &amp; privacy</h2>
      <p className="text-[11px] ac-text-4 mb-4 leading-relaxed">
        All your data lives in your browser's localStorage. Export it for backup
        or transfer; clear it to reclaim space. Nothing is sent to any server
        except the LLM provider you choose.
      </p>

      <div className="space-y-4">
        {/* Storage usage */}
        <div>
          <h3 className="text-[12px] font-medium ac-text-2 mb-2">Storage usage</h3>
          <div className="space-y-1.5">
            <UsageBar label="Sessions + snapshots" bytes={usage.sessions} total={usage.total} fmt={fmt} />
            <UsageBar label="Settings" bytes={usage.settings} total={usage.total} fmt={fmt} />
            <UsageBar label="Theme" bytes={usage.theme} total={usage.total} fmt={fmt} />
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t ac-border-subtle">
            <span className="text-[11px] ac-text-3">Total</span>
            <span className="text-[11px] font-mono ac-text-1">{fmt(usage.total)}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} className="h-6 mt-1 text-[10px] ac-text-4">
            <RotateCcw className="h-2.5 w-2.5 mr-1" />
            Refresh
          </Button>
        </div>

        <div className="border-t ac-border-subtle pt-4 space-y-2">
          <h3 className="text-[12px] font-medium ac-text-2">Export</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            className="h-8 w-full text-[11px] ac-border-default"
          >
            <Download className="h-3 w-3 mr-1.5" />
            Export all data (JSON)
          </Button>
          <p className="text-[10px] ac-text-4 leading-relaxed">
            Downloads a single JSON file containing all sessions, runs, messages,
            tool calls, snapshots, and your current settings.
          </p>
        </div>

        <div className="border-t ac-border-subtle pt-4 space-y-2">
          <h3 className="text-[12px] font-medium ac-text-2 flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3 ac-text-warning" />
            Danger zone
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearSnapshots}
            className="h-8 w-full text-[11px] ac-border-default ac-text-warning ac-hover-warning hover:ac-text-warning"
          >
            <Trash2 className="h-3 w-3 mr-1.5" />
            Delete all non-bookmarked snapshots
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearChats}
            className="h-8 w-full text-[11px] ac-border-default ac-text-danger ac-hover-danger hover:ac-text-danger"
          >
            <Trash2 className="h-3 w-3 mr-1.5" />
            Clear ALL chats (cannot be undone)
          </Button>
        </div>
      </div>
    </>
  );
}

function UsageBar({ label, bytes, total, fmt }: {
  label: string; bytes: number; total: number; fmt: (b: number) => string;
}) {
  const pct = total > 0 ? (bytes / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-0.5">
        <span className="ac-text-3">{label}</span>
        <span className="font-mono ac-text-2">{fmt(bytes)}</span>
      </div>
      <div className="h-1.5 rounded-full ac-surface-2 overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            backgroundColor: 'var(--ac-accent)',
          }}
        />
      </div>
    </div>
  );
}

// ── Section 6: Shortcuts reference ───────────────────────────────────────
function ShortcutsSection() {
  const shortcuts: { keys: string[]; action: string }[] = [
    { keys: ['⌘', 'K'], action: 'Open command palette' },
    { keys: ['⌘', ','], action: 'Open settings' },
    { keys: ['⌘', '1'], action: 'Toggle left panel (Chats / Layers)' },
    { keys: ['⌘', '2'], action: 'Toggle right panel (Chat / Design / History)' },
    { keys: ['⌘', '\\'], action: 'Zen mode (collapse all peripheral panels)' },
    { keys: ['⌘', 'Z'], action: 'Undo last canvas change' },
    { keys: ['⌘', '⇧', 'Z'], action: 'Redo' },
    { keys: ['V'], action: 'Select tool' },
    { keys: ['H'], action: 'Pan tool' },
    { keys: ['Enter'], action: 'Send prompt' },
    { keys: ['Shift', 'Enter'], action: 'Newline in prompt input' },
    { keys: ['Space', 'drag'], action: 'Pan canvas (temporary)' },
    { keys: ['Wheel'], action: 'Zoom canvas' },
    { keys: ['Del'], action: 'Delete selected shape' },
  ];
  return (
    <>
      <h2 className="text-[13px] font-semibold ac-text-1 mb-1">Keyboard shortcuts</h2>
      <p className="text-[11px] ac-text-4 mb-4 leading-relaxed">
        Reference list. These are not editable.
      </p>
      <div className="space-y-1">
        {shortcuts.map((s, i) => (
          <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded-md hover:ac-surface-1">
            <span className="text-[12px] ac-text-2">{s.action}</span>
            <span className="flex items-center gap-0.5">
              {s.keys.map((k, j) => (
                <kbd
                  key={j}
                  className="px-1.5 py-0.5 rounded border ac-border-default ac-surface-1 ac-text-2 text-[10px] font-mono ml-0.5"
                >
                  {k}
                </kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Section 7: Plugins ────────────────────────────────────────────────────
//
// Toggle which plugins are enabled. Each plugin contributes tools to the
// agent's customTools array. Disabled plugins are removed from the agent's
// tool surface entirely.

interface PluginInfo {
  pluginId: string;
  pluginName: string;
  description: string;
  category: 'interaction' | 'memory' | 'context' | 'orchestration' | 'external';
  defaultEnabled: boolean;
  toolCount: number;
  toolNames: string[];
}

const CATEGORY_LABELS: Record<PluginInfo['category'], string> = {
  interaction: 'Interaction',
  memory: 'Memory',
  context: 'Context',
  orchestration: 'Orchestration',
  external: 'External',
};

function PluginsSection() {
  const settings = useSettings();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/plugins')
      .then((r) => r.json())
      .then((data) => {
        setPlugins(data.plugins ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const enabledSet = new Set(settings.enabledPlugins ?? plugins.filter((p) => p.defaultEnabled).map((p) => p.pluginId));

  const togglePlugin = (pluginId: string, enabled: boolean) => {
    const current = new Set(settings.enabledPlugins ?? plugins.filter((p) => p.defaultEnabled).map((p) => p.pluginId));
    if (enabled) current.add(pluginId);
    else current.delete(pluginId);
    useSettings.getState().set('enabledPlugins', Array.from(current));
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[12px] ac-text-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading plugins...
      </div>
    );
  }

  // Group plugins by category.
  const byCategory = new Map<PluginInfo['category'], PluginInfo[]>();
  for (const p of plugins) {
    const arr = byCategory.get(p.category) ?? [];
    arr.push(p);
    byCategory.set(p.category, arr);
  }

  return (
    <>
      <h2 className="text-[13px] font-semibold ac-text-1 mb-1">Plugins</h2>
      <p className="text-[11px] ac-text-4 mb-4 leading-relaxed">
        Toggle which capabilities the agent has access to. Disabled plugins are
        removed from the agent&apos;s tool surface entirely.
      </p>
      <div className="space-y-5">
        {Array.from(byCategory.entries()).map(([category, plist]) => (
          <div key={category}>
            <h3 className="text-[11px] font-medium ac-text-3 mb-2 uppercase tracking-wide">
              {CATEGORY_LABELS[category]}
            </h3>
            <div className="space-y-2">
              {plist.map((p) => {
                const enabled = enabledSet.has(p.pluginId);
                return (
                  <div
                    key={p.pluginId}
                    className="flex items-start justify-between gap-3 p-3 rounded-md border ac-border-subtle ac-surface-1"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-medium ac-text-1">{p.pluginName}</span>
                        <span className="text-[10px] ac-text-4 px-1.5 py-0.5 rounded ac-surface-2">
                          {p.toolCount} tool{p.toolCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      <p className="text-[11px] ac-text-3 mt-1 leading-relaxed">{p.description}</p>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {p.toolNames.slice(0, 6).map((t) => (
                          <code key={t} className="text-[10px] ac-text-4 ac-surface-2 px-1.5 py-0.5 rounded font-mono">
                            {t}
                          </code>
                        ))}
                        {p.toolNames.length > 6 && (
                          <span className="text-[10px] ac-text-4">+{p.toolNames.length - 6} more</span>
                        )}
                      </div>
                    </div>
                    <Switch checked={enabled} onCheckedChange={(v) => togglePlugin(p.pluginId, v)} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Section 8: MCP Servers ────────────────────────────────────────────────
//
// Configure Model Context Protocol server connections. The agent uses
// these via the mcp-adapter plugin to access external systems like Figma,
// GitHub, Notion, Style Dictionary, or the local filesystem.

type McpServerEntry = McpServerConfig;

function McpSection() {
  const settings = useSettings();
  const servers = settings.mcpServers ?? [];
  const [showAddForm, setShowAddForm] = useState(false);
  const [newServer, setNewServer] = useState<McpServerEntry>({
    id: '',
    name: '',
    transport: 'stdio',
    command: '',
    autoConnect: false,
  });

  const addServer = () => {
    if (!newServer.id || !newServer.name) {
      toast.error('Server id and name are required');
      return;
    }
    const updated = [...servers, newServer];
    useSettings.getState().set('mcpServers', updated);
    setNewServer({ id: '', name: '', transport: 'stdio', command: '', autoConnect: false });
    setShowAddForm(false);
    toast.success(`Added MCP server "${newServer.name}"`);
  };

  const removeServer = (id: string) => {
    const updated = servers.filter((s) => s.id !== id);
    useSettings.getState().set('mcpServers', updated);
    toast.success('Removed MCP server');
  };

  const connectServer = async (server: McpServerEntry) => {
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(server.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect', name: server.name, transport: server.transport }),
      });
      if (!r.ok) throw new Error('Failed to connect');
      toast.success(`Connected to "${server.name}"`);
    } catch (err: any) {
      toast.error(`Failed to connect: ${err.message}`);
    }
  };

  const disconnectServer = async (id: string) => {
    try {
      await fetch(`/api/mcp/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }),
      });
      toast.success('Disconnected');
    } catch (err: any) {
      toast.error(`Failed to disconnect: ${err.message}`);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[13px] font-semibold ac-text-1">MCP Servers</h2>
        <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)} className="h-7 gap-1">
          <Plus className="h-3 w-3" />
          Add server
        </Button>
      </div>
      <p className="text-[11px] ac-text-4 mb-4 leading-relaxed">
        Connect to Model Context Protocol servers. The agent can then read/write
        real Figma files, GitHub issues, Notion pages, or the local filesystem
        via the <code className="font-mono">mcp_*</code> tools.
      </p>

      {showAddForm && (
        <div className="mb-4 p-3 rounded-md border ac-border-default ac-surface-1 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px] ac-text-3">Server ID</Label>
              <Input
                value={newServer.id}
                onChange={(e) => setNewServer({ ...newServer, id: e.target.value })}
                placeholder="figma"
                className="h-7 text-[12px]"
              />
            </div>
            <div>
              <Label className="text-[11px] ac-text-3">Name</Label>
              <Input
                value={newServer.name}
                onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
                placeholder="Figma MCP"
                className="h-7 text-[12px]"
              />
            </div>
          </div>
          <div>
            <Label className="text-[11px] ac-text-3">Transport</Label>
            <Select
              value={newServer.transport}
              onValueChange={(v) => setNewServer({ ...newServer, transport: v as McpServerEntry['transport'] })}
            >
              <SelectTrigger className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio (local process)</SelectItem>
                <SelectItem value="sse">SSE (HTTP stream)</SelectItem>
                <SelectItem value="http">HTTP</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {newServer.transport === 'stdio' ? (
            <div>
              <Label className="text-[11px] ac-text-3">Command</Label>
              <Input
                value={newServer.command ?? ''}
                onChange={(e) => setNewServer({ ...newServer, command: e.target.value })}
                placeholder="npx -y @modelcontextprotocol/server-figma"
                className="h-7 text-[12px] font-mono"
              />
            </div>
          ) : (
            <div>
              <Label className="text-[11px] ac-text-3">URL</Label>
              <Input
                value={newServer.url ?? ''}
                onChange={(e) => setNewServer({ ...newServer, url: e.target.value })}
                placeholder="https://mcp.example.com/sse"
                className="h-7 text-[12px] font-mono"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch
              checked={newServer.autoConnect ?? false}
              onCheckedChange={(v) => setNewServer({ ...newServer, autoConnect: v })}
            />
            <Label className="text-[11px] ac-text-3">Auto-connect on startup</Label>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={addServer} className="h-7">Add</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)} className="h-7">Cancel</Button>
          </div>
        </div>
      )}

      {servers.length === 0 ? (
        <div className="text-[12px] ac-text-4 p-4 text-center border border-dashed ac-border-subtle rounded-md">
          No MCP servers configured. Click &quot;Add server&quot; to connect to Figma, GitHub, Notion, etc.
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <div key={s.id} className="p-3 rounded-md border ac-border-subtle ac-surface-1">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium ac-text-1">{s.name}</span>
                    <span className="text-[10px] ac-text-4 px-1.5 py-0.5 rounded ac-surface-2">{s.transport}</span>
                    {s.status === 'connected' && (
                      <span className="flex items-center gap-0.5 text-[10px] ac-text-success">
                        <CheckCircle2 className="h-3 w-3" /> connected{s.toolCount ? ` · ${s.toolCount} tools` : ''}
                      </span>
                    )}
                    {s.status === 'error' && (
                      <span className="flex items-center gap-0.5 text-[10px] ac-text-danger">
                        <XCircle className="h-3 w-3" /> error
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] ac-text-3 mt-0.5 font-mono">
                    {s.transport === 'stdio' ? s.command : s.url}
                  </p>
                  {s.message && (
                    <p className="text-[10px] ac-text-4 mt-1">{s.message}</p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {s.status === 'connected' ? (
                    <Button size="sm" variant="ghost" onClick={() => disconnectServer(s.id)} className="h-7 text-[11px]">
                      Disconnect
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => connectServer(s)} className="h-7 text-[11px]">
                      Connect
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => removeServer(s.id)} className="h-7 text-[11px] ac-text-danger">
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
