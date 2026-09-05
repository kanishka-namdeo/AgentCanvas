'use client';

// Model switcher — the model badge in the AgentPanel header becomes a dropdown
// that lists models the user can ACTUALLY switch to right now.
//
// UX pattern (researched from how established apps do it):
//
//   - Cursor: model selector opens from the chat/agent panel; picking a model
//     applies to the NEXT message (mid-conversation switches are allowed but
//     the current turn keeps its model).
//   - ChatGPT / Claude.ai: compact dropdown, checkmark on the current model,
//     metadata next to each entry, and a "settings" escape hatch at the
//     bottom for advanced configuration.
//   - Open WebUI: the picker is searchable — endpoint/proxy catalogs can
//     list dozens of models, so a filter box sits at the top of the list.
//   - Cline: models are grouped by source (provider catalog vs endpoint),
//     with a clear indicator when the endpoint is unreachable.
//
// Data flow: POST /api/models (server-side lib/agent/model-catalog.ts) returns
//   { provider: { source, ready, models[] }, zaiSandbox: { available, models[] } }
// — the provider section mirrors the resolver's dispatch decision, so any
// model listed here resolves identically on the next agent turn.

import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSettings } from '@/lib/settings/store';
import { useModelCatalog } from '@/hooks/use-model-catalog';
import { modelSupportsImages } from '@/lib/agent/attachments';
import {
  Brain, Check, ChevronDown, Cpu, Eye, Loader2, RefreshCw, Search, Settings2, Zap, TriangleAlert,
} from 'lucide-react';

/// Compact token formatting (matches AgentPanel's inlined helper).
function fmtTokens(tokens: number | null): string {
  if (tokens === null) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}K`;
  return String(tokens);
}

// ==== Capability icons =======================================================
//
// How other apps denote multimodal support (researched):
//
//   - OpenRouter: capability TAGS on every model card ("vision", "reasoning")
//     sourced from the model's declared input modalities — the densest
//     scannable form in a long list.
//   - LM Studio: shows the image-attach affordance ONLY for vision models,
//     and tags models with a small "vision" chip in the model list.
//   - Cursor: model picker rows carry short capability hints; attaching an
//     image to a text-only model surfaces "Model does not support images".
//
// We render icons instead of text tags (the dropdown is space-constrained):
// an Eye = accepts image input, a Brain = reasoning model. Tooltips carry
// the full wording for discoverability, and a one-line legend at the bottom
// of the list teaches the icons on first open.

function CapabilityIcons({ input, reasoning }: { input: string[]; reasoning: boolean }) {
  const vision = modelSupportsImages(input);
  if (!vision && !reasoning) return null;
  return (
    <span className="flex items-center gap-0.5 flex-shrink-0">
      {vision && (
        <span
          title="Vision — accepts image input (attach screenshots in chat)"
          aria-label="supports image input"
          className="inline-flex items-center justify-center ac-text-info"
        >
          <Eye className="h-3 w-3" />
        </span>
      )}
      {reasoning && (
        <span
          title="Reasoning — extended thinking before answering"
          aria-label="reasoning model"
          className="inline-flex items-center justify-center ac-text-3"
        >
          <Brain className="h-3 w-3" />
        </span>
      )}
    </span>
  );
}

interface ModelOption {
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  input: string[];
  fromCatalog?: boolean;
}

function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: ModelOption;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(model.id)}
      role="option"
      aria-selected={selected}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left ac-transition ${
        selected ? 'ac-surface-2' : 'hover:ac-surface-1'
      }`}
    >
      <span className="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center">
        {selected && <Check className="h-3 w-3" style={{ color: 'var(--ac-accent)' }} />}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[11px] font-mono truncate ac-text-1">{model.id}</span>
        <span className="block text-[9px] ac-text-4">
          {fmtTokens(model.contextWindow)} ctx
          {model.maxTokens ? ` · ${fmtTokens(model.maxTokens)} out` : ''}
        </span>
      </span>
      {/* OpenRouter-style capability tags, icon form — Eye = image input,
          Brain = reasoning. Tooltips carry the wording. */}
      <CapabilityIcons input={model.input} reasoning={model.reasoning} />
    </button>
  );
}

interface ModelSwitcherProps {
  /// Resolved-model info for the trigger badge (from the canvas store).
  activeModel: import('@/lib/canvas/store').ActiveModelInfo | null;
  /// Tooltip for the trigger badge (usage breakdown — built by the parent).
  badgeTooltip: string;
}

export function ModelSwitcher({ activeModel, badgeTooltip }: ModelSwitcherProps) {
  const configuredProvider = useSettings((s) => s.llmProvider);
  const configuredModel = useSettings((s) => s.modelName);
  const setSetting = useSettings((s) => s.set);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const { loading, data, error, refresh } = useModelCatalog();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // D7 (2026-09-05 depth pass): a mid-run selection must NOT clobber
  // `activeModel` — the live run keeps using the model it started with, and
  // the badge claiming otherwise is a lying control. The reset is deferred
  // until the run goes idle; the popover footer says "applies after current
  // turn" and now the badge agrees with it.
  const deferredReset = useRef(false);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    // Reset the filter on every open (Open WebUI pattern — the filter is a
    // per-session affordance, not persistent state). Done in the event
    // handler, not an effect, to avoid cascading renders.
    if (next) setQuery('');
  };

  // Fetch on first open (and keep the last listing on re-open — a manual
  // refresh button re-probes the endpoint).
  const fetchedOnce = useRef(false);
  useEffect(() => {
    if (open && !fetchedOnce.current) {
      fetchedOnce.current = true;
      refresh();
    }
  }, [open, refresh]);

  // Focus the search box when the popover opens (Open WebUI pattern — the
  // filter is the primary interaction for long endpoint lists).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  const modelId = activeModel?.modelId ?? configuredModel;
  const usedFallback = activeModel?.usedFallback === true;

  // Vision capability of the CURRENT model — looked up from the catalog
  // listing (same metadata the rows render). Unknown when the listing
  // hasn't loaded or the model isn't in the catalog (endpoint-only ids) —
  // in that case we show no eye rather than a wrong one (LM Studio only
  // marks models it KNOWS are vision-capable).
  const currentModelEntry = [...(data?.provider.models ?? []), ...(data?.zaiSandbox?.models ?? [])]
    .find((m) => m.id === modelId);
  const currentModelVision = currentModelEntry
    ? modelSupportsImages(currentModelEntry.input)
    : false;

  // Switch handler — applies to the NEXT turn (Cursor behavior). Reset the
  // resolved-model state so the badge immediately reflects the selection,
  // and hide the context bar until the next turn reports real usage for the
  // new model (its window may differ).
  // D7: while a run is live, defer that reset (see deferredSwitch above) —
  // the badge keeps showing the model the in-flight turn is actually using.
  const handleSelect = (id: string, fromZaiSandbox: boolean) => {
    if (fromZaiSandbox) {
      setSetting('llmProvider', 'zai');
      setSetting('modelName', id);
      // Clear the key so the resolver auto-resolves sandbox credentials —
      // a stale custom-endpoint key would 401 against z.ai.
      setSetting('apiKey', '');
      // Also clear the custom base URL so the resolver routes via the zai
      // catalog path, not the synthetic-endpoint path.
      setSetting('apiBaseUrl', '');
    } else {
      setSetting('modelName', id);
    }
    if (agentBusy) {
      deferredReset.current = true;
    } else {
      useCanvasStore.setState({
        activeModel: null,
        contextTokens: 0,
        lastCompacted: false,
      });
    }
    setOpen(false);
  };

  // Apply the deferred model-badge reset the moment the run goes idle.
  // External-store sync (zustand) — the effect never touches React state,
  // which keeps it on the sanctioned side of the set-state-in-effect rule.
  useEffect(() => {
    if (!agentBusy && deferredReset.current) {
      deferredReset.current = false;
      useCanvasStore.setState({ activeModel: null, contextTokens: 0, lastCompacted: false });
    }
  }, [agentBusy]);

  // Filtered + sorted model lists — computed inline (lists are capped at
  // ~60-100 entries server-side; memoization isn't worth the compiler
  // complexity here).
  const filterModels = (models: ModelOption[]): ModelOption[] => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      : models;
    // Current model first, then alphabetical — predictable ordering.
    return [...filtered].sort((a, b) => {
      if (a.id === modelId) return -1;
      if (b.id === modelId) return 1;
      return a.id.localeCompare(b.id);
    });
  };

  const providerModels = filterModels(data?.provider.models ?? []);
  const zaiModels = filterModels(data?.zaiSandbox?.models ?? []);
  const zaiAvailable = data?.zaiSandbox?.available === true;
  const providerLabel = data?.provider.label ?? configuredProvider;
  const providerSource = data?.provider.source;
  const providerError = data?.provider.error ?? error;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          title={badgeTooltip}
          aria-haspopup="listbox"
          aria-label={`Model: ${modelId}. Click to switch models.`}
          className={`flex items-center gap-0.5 px-1 py-0.5 rounded font-mono ac-transition hover:ac-surface-1 ac-focus-ring ${
            usedFallback ? 'ac-text-warning' : 'ac-text-2'
          }`}
        >
          <Cpu className="h-3 w-3 flex-shrink-0" />
          <span className="max-w-[110px] sm:max-w-[160px] lg:max-w-[200px] truncate">{modelId}</span>
          {/* Vision indicator — Eye when the current model accepts image
              input (signals that the attach button / paste will work). */}
          {currentModelVision && (
            <span
              className="flex-shrink-0 ac-text-info"
              title="Vision — this model accepts image input (paste or attach images in chat)"
            >
              <Eye className="h-2.5 w-2.5" />
            </span>
          )}
          {usedFallback && (
            <span className="flex-shrink-0" title="Endpoint was unreachable — z.ai sandbox fallback model in use">
              <Zap className="h-2.5 w-2.5" />
            </span>
          )}
          <ChevronDown className="h-2.5 w-2.5 flex-shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-72 max-w-[calc(100vw-1rem)] p-2 ac-surface-0 ac-border-default shadow-lg"
        onOpenAutoFocus={(e) => e.preventDefault()} // keep focus out of the popover shell
      >
        {/* Header: provider + source + refresh */}
        <div className="flex items-center justify-between px-1 pb-1.5 mb-1 border-b ac-border-subtle">
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-[10px] font-medium ac-text-2 truncate">
              {providerLabel}
              <span className="ac-text-4 font-normal">
                {providerSource === 'endpoint' ? ' · live endpoint' : providerSource === 'catalog' ? ' · catalog' : ''}
              </span>
            </span>
            {providerSource === 'error' && (
              <span className="ac-text-warning flex-shrink-0" title={providerError ?? 'Endpoint unreachable'}>
                <TriangleAlert className="h-3 w-3" />
              </span>
            )}
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            title="Re-fetch the model list from the endpoint / catalog"
            className="p-1 rounded ac-transition hover:ac-surface-1 ac-text-3 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </button>
        </div>

        {/* Search filter (Open WebUI pattern) */}
        <div className="relative mb-1.5">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 ac-text-4 pointer-events-none" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter models…"
            aria-label="Filter models"
            className="w-full h-7 pl-7 pr-2 rounded-md text-[11px] ac-surface-1 ac-border-subtle border ac-text-1 placeholder:ac-text-4 outline-none focus:ac-border-default focus:ring-1 focus:ring-[var(--ac-accent)]"
          />
        </div>

        <div role="listbox" aria-label="Available models" className="max-h-64 overflow-y-auto ac-hide-scrollbar space-y-0.5">
          {/* Loading skeleton */}
          {loading && !data && (
            <div className="flex items-center gap-2 px-2 py-3 text-[11px] ac-text-4">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading available models…
            </div>
          )}

          {/* Endpoint unreachable — show why + unverified suggestions */}
          {providerSource === 'error' && (
            <div className="px-2 py-1.5 mb-1 rounded-md ac-surface-1 text-[10px] ac-text-warning leading-relaxed">
              {providerError ?? 'Could not reach the model endpoint.'}
              {(data?.provider.models.length ?? 0) > 0 && (
                <span className="block ac-text-4">Suggestions below are unverified.</span>
              )}
            </div>
          )}

          {/* Provider models */}
          {providerModels.length > 0 && (
            <div className="space-y-0.5">
              {providerSource !== 'error' && providerModels.length > 0 && zaiAvailable && (
                <div className="px-2 pt-1 pb-0.5 text-[9px] uppercase tracking-wide ac-text-4">
                  {providerLabel}
                </div>
              )}
              {providerModels.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  selected={m.id === modelId && !usedFallback}
                  onSelect={(id) => handleSelect(id, false)}
                />
              ))}
            </div>
          )}

          {/* z.ai sandbox models — always-available escape hatch */}
          {zaiModels.length > 0 && (
            <div className="mt-1.5 pt-1.5 border-t ac-border-subtle">
              <div className="px-2 pb-0.5 text-[9px] uppercase tracking-wide ac-text-4">
                z.ai sandbox {zaiAvailable ? '· no key needed' : '· unavailable'}
              </div>
              {zaiModels.map((m) => (
                <ModelRow
                  key={`zai-${m.id}`}
                  model={m}
                  selected={m.id === modelId && usedFallback}
                  onSelect={(id) => handleSelect(id, true)}
                />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!loading && providerModels.length === 0 && zaiModels.length === 0 && (
            <div className="px-2 py-3 text-[11px] ac-text-4 leading-relaxed">
              No models found{query ? ` matching “${query}”` : ''}.
              <span className="block mt-1">Check the provider settings below.</span>
            </div>
          )}
        </div>

        {/* Legend — teaches the capability icons (a single quiet line between
            the list and the footer so it's visible without hovering). */}
        <div className="flex items-center gap-3 px-1.5 pt-1.5 mt-1 border-t ac-border-subtle text-[9px] ac-text-4">
          <span className="flex items-center gap-1">
            <Eye className="h-2.5 w-2.5 ac-text-info" />
            image input
          </span>
          <span className="flex items-center gap-1">
            <Brain className="h-2.5 w-2.5 ac-text-3" />
            reasoning
          </span>
        </div>

        {/* Footer: settings escape hatch + next-turn hint (ChatGPT pattern) */}
        <div className="flex items-center justify-between pt-1 mt-0.5">
          <button
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new CustomEvent('agentcanvas:open-settings'));
            }}
            className="flex items-center gap-1 px-1.5 py-1 rounded text-[10px] ac-text-3 ac-transition hover:ac-surface-1"
          >
            <Settings2 className="h-3 w-3" />
            Model settings…
          </button>
          <span className="text-[9px] ac-text-4">
            {agentBusy ? 'applies after current turn' : 'applies to next message'}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
