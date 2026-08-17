'use client';

// SettingsDialog — the full settings workflow (Phases 1, 2, and 3).
//
// Layout: a left vertical nav of section names + a right content pane showing
// the active section's form fields. Mirrors the pattern used by VS Code's
// Settings, Linear's Settings, and macOS System Preferences.
//
// Sections:
//   1. Agent behavior   — temperature, maxIterations, planFirst, defaultPalette, skillSelectionMode
//   2. LLM provider     — provider, apiKey, modelName, apiBaseUrl
//   3. Canvas defaults  — (reserved; canvas bg is per-document, not global)
//   4. Sessions         — snapshotCadence, maxSessionsRetained, maxSnapshotsPerSession, autoArchiveIdleAfter
//   5. Appearance       — theme, density
//   6. Data & privacy   — storage usage, export all, clear all
//   7. Shortcuts        — read-only reference list
//
// All settings are read from / written to the Zustand settings store, which
// persists to localStorage automatically. Changes apply immediately — no
// "Save" button required.

import { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { useSettings } from '@/lib/settings/store';
import {
  DEFAULT_SETTINGS, PALETTES,
  type LLMProvider, type SnapshotCadence, type SkillSelectionMode,
  type AutoArchiveIdleAfter, type Density, type ThemePreference,
  type DefaultPalette,
} from '@/lib/settings/types';
import { useSessionStore, estimateLocalStorageUsage, sweepIdleSessions } from '@/lib/sessions';
import { useCanvasStore } from '@/lib/canvas/store';
import { toast } from 'sonner';

type Section =
  | 'agent' | 'llm' | 'sessions' | 'appearance' | 'data' | 'shortcuts';

const SECTIONS: { id: Section; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'agent',       label: 'Agent',        icon: Bot },
  { id: 'llm',         label: 'LLM provider', icon: KeyRound },
  { id: 'sessions',    label: 'Sessions',     icon: History },
  { id: 'appearance',  label: 'Appearance',   icon: Palette },
  { id: 'data',        label: 'Data',         icon: ShieldCheck },
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
      <DialogContent className="max-w-3xl p-0 overflow-hidden gap-0" showCloseButton>
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure the agent, LLM provider, sessions, appearance, and data.
          Changes apply immediately.
        </DialogDescription>
        <div className="flex h-[560px]">
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
            <div className="p-5 space-y-5">
              {section === 'agent' && <AgentSection />}
              {section === 'llm' && <LLMSection />}
              {section === 'sessions' && <SessionsSection />}
              {section === 'appearance' && <AppearanceSection />}
              {section === 'data' && <DataSection />}
              {section === 'shortcuts' && <ShortcutsSection />}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Reusable row primitive ────────────────────────────────────────────────
function Row({ label, description, children }: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="flex-1 min-w-0">
        <Label className="text-[12px] font-medium ac-text-1">{label}</Label>
        {description && (
          <p className="text-[11px] ac-text-4 mt-0.5 leading-snug">{description}</p>
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
          label="Default palette"
          description="The palette the agent suggests first when no specific colors are requested."
        >
          <Select
            value={defaultPalette}
            onValueChange={(v) => set('defaultPalette', v as DefaultPalette)}
          >
            <SelectTrigger size="sm" className="h-7 w-32 text-[11px]">
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
            <SelectTrigger size="sm" className="h-7 w-32 text-[11px]">
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

  return (
    <>
      <h2 className="text-[13px] font-semibold ac-text-1 mb-1">LLM provider</h2>
      <p className="text-[11px] ac-text-4 mb-4 leading-relaxed">
        Choose which LLM backend powers the agent. Inside the z.ai sandbox, the
        default auto-resolves credentials — no key needed. Outside the sandbox,
        use OpenAI-compatible to point at OpenAI, Together, Groq, or local Ollama.
      </p>

      <div className="space-y-4">
        <Row
          label="Provider"
          description="Which LLM client to construct on the server."
        >
          <Select
            value={llmProvider}
            onValueChange={(v) => set('llmProvider', v as LLMProvider)}
          >
            <SelectTrigger size="sm" className="h-7 w-44 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zai-auto" className="text-[11px]">z.ai (auto-credentials)</SelectItem>
              <SelectItem value="zai-key" className="text-[11px]">z.ai (explicit API key)</SelectItem>
              <SelectItem value="openai-compatible" className="text-[11px]">OpenAI-compatible</SelectItem>
            </SelectContent>
          </Select>
        </Row>

        {llmProvider === 'openai-compatible' && (
          <>
            <Row
              label="API base URL"
              description="e.g. https://api.openai.com/v1, https://api.together.xyz/v1, http://localhost:11434/v1 (Ollama)"
            >
              <Input
                value={apiBaseUrl}
                onChange={(e) => set('apiBaseUrl', e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="h-7 w-64 text-[11px]"
              />
            </Row>
            <Row
              label="Model name"
              description="e.g. gpt-4o, gpt-4o-mini, glm-4.5, qwen-max, llama3.1:70b"
            >
              <Input
                value={modelName}
                onChange={(e) => set('modelName', e.target.value)}
                placeholder="gpt-4o"
                className="h-7 w-48 text-[11px]"
              />
            </Row>
          </>
        )}

        {(llmProvider === 'zai-key' || llmProvider === 'openai-compatible') && (
          <Row
            label="API key"
            description="Stored in your browser's localStorage only — never sent to anyone except the provider you choose."
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder={llmProvider === 'zai-key' ? 'ZAI_API_KEY' : 'sk-…'}
              className="h-7 w-64 text-[11px] font-mono"
            />
          </Row>
        )}

        {llmProvider === 'zai-auto' && (
          <div className="rounded-md border ac-border-subtle ac-surface-1 p-3 text-[11px] ac-text-3 leading-relaxed">
            <strong className="ac-text-2">No configuration needed.</strong> The
            z.ai sandbox auto-resolves credentials at runtime. If you're running
            outside the sandbox, set <code className="font-mono ac-text-1">ZAI_API_KEY</code> in
            your <code className="font-mono ac-text-1">.env</code> file, or switch
            to <em>z.ai (explicit API key)</em> above.
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
            <SelectTrigger size="sm" className="h-7 w-32 text-[11px]">
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
            <SelectTrigger size="sm" className="h-7 w-32 text-[11px]">
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
            <SelectTrigger size="sm" className="h-7 w-32 text-[11px]">
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

  // Refresh usage every time the section is opened.
  useEffect(() => { refresh(); }, []);

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
            <AlertTriangle className="h-3 w-3 text-amber-500" />
            Danger zone
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearSnapshots}
            className="h-8 w-full text-[11px] ac-border-default text-amber-700 hover:bg-amber-50"
          >
            <Trash2 className="h-3 w-3 mr-1.5" />
            Delete all non-bookmarked snapshots
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearChats}
            className="h-8 w-full text-[11px] ac-border-default text-rose-700 hover:bg-rose-50"
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
