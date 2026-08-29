'use client';

// Agent chat panel — the human's interface to the AI agent.
//
// Shows the conversation with the agent (user prompts + assistant responses),
// every tool call the agent makes (with success/failure + summary), and an
// input box for sending the next prompt. The agent's text streams in token
// by token as the LLM produces it.
//
// All agent events arrive as `SyncEvent`s over the WebSocket and are
// reduced into `ChatTurn[]` in the canvas store. This component just renders
// that state.
//
// === SCENARIO PROMPTS =====================================================
//
// The preset prompts are grouped by the research-driven scenarios that the
// extended tool surface supports (see /research/*.json + tools.ts):
//   - Wireframes (mobile/web templates)
//   - User flows (multi-screen)
//   - Diagrams (flowchart / mindmap)
//   - Design systems (palettes, variables, audit)
//   - Analysis (copy, audit, organize)
// Each prompt is a one-click example that exercises a specific tool.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useCanvasStore, type AgentToolCallEntry, type ChatTurn } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { useSettings } from '@/lib/settings/store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { toast } from 'sonner';
import { PluginUI } from './PluginUI';
import { MarkdownMessage } from './Markdown';
import { ModelSwitcher } from './ModelSwitcher';
import { suggestFollowUps } from '@/lib/agent/followups';
import {
  matchCommands, resolveCommand, parseCommandInput, COMMAND_MENU_LIMIT, resolvePackName,
  type ChatCommand,
} from '@/lib/agent/chat-commands';
import { useDesignSystems, setActivePack } from '@/hooks/use-design-systems';
import { humanifyPackName } from '@/hooks/use-active-pack';
import { pushPromptHistory, navigateHistory } from '@/lib/agent/prompt-history';
import { exportSvg, exportPngDataUrl, exportJson, downloadFile, downloadDataUrl } from '@/lib/canvas/export';
import { useModelCatalog } from '@/hooks/use-model-catalog';
import {
  summarizeTurnDiff,
  isDiffEmpty,
  type PatchOpRecord,
} from '@/lib/agent/turn-diff';
import {
  type AttachedImage,
  stageImageFiles,
  imageFilesFromDataTransfer,
  formatDataUrlSize,
  modelSupportsImages,
  makeAttachedImage,
  downscaleImageFile,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DATAURL_LENGTH,
} from '@/lib/agent/attachments';
import {
  Bot, User, Wrench, CheckCircle2, XCircle, Loader2, Send, Sparkles,
  Smartphone, LayoutDashboard, GitBranch, Palette, Activity, Layers, Square,
  ChevronRight, Clock, CornerDownLeft, Cpu, Paperclip, X, ArrowDown,
  RotateCcw, TriangleAlert, Copy, Camera, BoxSelect, GitCompareArrows,
  ThumbsUp, ThumbsDown, Pencil, Brain, ListChecks, AtSign, ListPlus, Circle,
  BadgeCheck, Bot as BotIcon,
} from 'lucide-react';
import {
  activeMentionToken, applyMention, matchMentions, extractMentionedLayerIds,
  mentionableLayers,
} from '@/lib/agent/chat-mentions';
import { saveDraft, loadDraft, clearDraft } from '@/lib/agent/draft-store';

/// Format a token count for compact display: 45200 → "45.2K".
/// Inlined (rather than imported from lib/agent/context-manager) because that
/// module pulls in the server-only pi-coding-agent SDK and this is a client
/// component — see the module-not-found failure in dev.log.
function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

/// Locale-independent thousands-separator formatting for tooltips/aria text:
/// 128000 → "128,000". `Number.prototype.toLocaleString()` is NOT safe in
/// components rendered during SSR: the server bakes ITS locale into the HTML
/// while the browser re-renders with the USER's locale (e.g. ar-AE renders
/// 128000 as Arabic-Indic digits "١٢٨٬٠٠٠"), which trips React hydration on
/// the `title` attribute (react.dev/link/hydration-mismatch). A fixed
/// en-US-style grouping keeps server and client output byte-identical.
function fmtInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/// Compact duration formatter for tool-call / thinking chips: 940 → "940ms",
/// 4200 → "4.2s", 75000 → "1m 15s".
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/// Ticking elapsed-time label ("0:07", "1:23") — powers the live activity
/// row while the agent works and the "Thinking…" header while reasoning
/// streams (Cursor shows elapsed time next to live activity; ChatGPT's
/// thinking header does the same). One interval per mounted instance.
function ElapsedTimer({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.round((now - since) / 1000));
  const label =
    s < 3600
      ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      : `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return <span className={`tabular-nums ${className ?? ''}`}>{label}</span>;
}

// Note: the document variables + token counts previously shown in a status
// strip inside this panel have been moved to the Properties panel's empty
// state, where document-level metadata belongs. See PropertiesPanel.tsx.

interface PromptGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  prompts: string[];
}

const PROMPT_GROUPS: PromptGroup[] = [
  {
    id: 'designs',
    label: 'Designs',
    icon: Smartphone,
    prompts: [
      'Design a high-fidelity mobile login screen with logo, email/password fields, and a sign-in button.',
      'Build a modern mobile dashboard with stat cards, a chart, shadows, and a tab bar.',
      'Make a polished web landing page with a gradient hero, features section, and CTA.',
      'Design a web pricing page with three tiers, the middle one featured, with shadows and real content.',
    ],
  },
  {
    id: 'flows',
    label: 'User Flows',
    icon: GitBranch,
    prompts: [
      'Generate a 3-step onboarding user flow (welcome → permissions → done).',
      'Create an ecommerce flow: browse → product → cart → checkout.',
      'Design a signup funnel: landing → signup → verify → dashboard.',
    ],
  },
  {
    id: 'diagrams',
    label: 'Diagrams',
    icon: LayoutDashboard,
    prompts: [
      'Draw a flowchart with these steps: Idea, Research, Design, Build, Ship.',
      'Make a mindmap with "Product Strategy" at the center and 5 branches: Users, Market, Tech, Revenue, Risks.',
    ],
  },
  {
    id: 'design-systems',
    label: 'Design Systems',
    icon: Palette,
    prompts: [
      'Generate a triadic palette from #0ea5e9 and apply it to all shapes.',
      'Create a monochromatic palette from #16a34a, save it as tokens, and apply to existing shapes.',
      'Audit my design for consistency issues and report findings.',
    ],
  },
  {
    id: 'analysis',
    label: 'Analysis',
    icon: Activity,
    prompts: [
      'Fill every text shape with realistic placeholder copy about "project management".',
      'Audit my design for color contrast and alignment issues, then report findings.',
      'Organize my layers — rename and re-order them by reading order.',
    ],
  },
  {
    id: 'layers',
    label: 'Layers & Layout',
    icon: Layers,
    prompts: [
      'Align all selected shapes to the left.',
      'Distribute these shapes evenly horizontally.',
      'Group all the stat cards into one group.',
      'Apply horizontal Auto Layout with 8px gap to the selected frame.',
    ],
  },
];

// ==== Model + context usage indicator ========================================
//
// Shows WHICH model the agent resolved (not just the configured one) and HOW
// MUCH of its context window is in use. UX pattern researched from industry:
//
//   - Cline: context-window progress bar in the chat header with token
//     counts ("45K / 200K") + a "context left" percentage.
//   - Claude Code: `/context` breakdown (input / output / cache tokens with
//     a cost roll-up) + status-line context percentage.
//   - Cursor: model name as a badge next to the chat input, clickable to
//     switch models (we open Settings → LLM provider).
//   - OpenCode: traffic-light states — healthy / warning / critical as the
//     window fills (we use <70% / 70–90% / >90%).
//
// Data flow: runner-native emits `agent:model_info` (resolved model + true
// context window) once per attempt; the translator emits
// `agent:context_update` with the usage payload on every LLM call
// (message_end). The canvas store reduces both.

interface ModelContextStatusProps {
  activeModel: import('@/lib/canvas/store').ActiveModelInfo | null;
  usageTotals: import('@/lib/canvas/store').UsageTotals;
  contextTokens: number;
  contextWindow: number;
  lastCompacted: boolean;
}

function ModelContextStatus({
  activeModel, usageTotals, contextTokens, contextWindow, lastCompacted,
}: ModelContextStatusProps) {
  // Fall back to the CONFIGURED model from the settings store until the
  // runner reports the resolved one (first turn / before any turn).
  const configuredProvider = useSettings((s) => s.llmProvider);
  const configuredModel = useSettings((s) => s.modelName);

  const modelId = activeModel?.modelId ?? configuredModel;
  const provider = activeModel?.provider ?? configuredProvider;
  const isResolved = activeModel !== null;
  const usedFallback = activeModel?.usedFallback === true;

  const window_ = contextWindow || 1;
  const pct = Math.min(100, Math.round((contextTokens / window_) * 100));
  // OpenCode-style traffic-light thresholds.
  const state: 'ok' | 'warn' | 'critical' =
    pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : 'ok';
  const barColor =
    state === 'critical' ? 'var(--ac-danger)' :
    state === 'warn' ? 'var(--ac-warning)' : 'var(--ac-success)';
  const textColorCls =
    state === 'critical' ? 'ac-text-danger' :
    state === 'warn' ? 'ac-text-warning' : 'ac-text-3';

  // Claude Code /context-style tooltip breakdown.
  const tooltip = [
    `Model: ${modelId}${isResolved ? '' : ' (configured — not yet resolved)'}`,
    `Provider: ${provider}${usedFallback ? ' (sandbox fallback)' : ''}`,
    // fmtInt, not toLocaleString — this tooltip is rendered during SSR and
    // must be byte-identical to the client's first render (see fmtInt above).
    `Context window: ${fmtInt(contextWindow)} tokens`,
    activeModel ? `Max output: ${fmtInt(activeModel.maxTokens)} tokens` : null,
    '',
    `Context usage: ${fmtInt(contextTokens)} / ${fmtInt(contextWindow)} (${pct}%)${lastCompacted ? ' — compacted' : ''}`,
    usageTotals.llmCalls > 0
      ? `Session totals: ${usageTotals.llmCalls} LLM calls · in ${fmtInt(usageTotals.inputTokens)} · out ${fmtInt(usageTotals.outputTokens)} · cache read ${fmtInt(usageTotals.cacheReadTokens)} · cache write ${fmtInt(usageTotals.cacheWriteTokens)}`
      : null,
    usageTotals.cost > 0 ? `Estimated cost: $${usageTotals.cost.toFixed(4)}` : null,
    '',
    'Click the model name to browse and switch available models.',
  ].filter((l) => l !== null).join('\n');

  return (
    <>
      {/* Model badge + switcher — resolved model once known, configured model
          before the first turn. Click → dropdown of actually-available models
          (Cursor / ChatGPT / Open WebUI pattern — see ModelSwitcher.tsx). */}
      <ModelSwitcher activeModel={activeModel} badgeTooltip={tooltip} />

      {/* Context usage — Cline-style progress bar with % + absolute tokens.
          Hidden until the first LLM call reports usage (no fake data). */}
      {contextTokens > 0 && (
        <span
          className="flex items-center gap-1"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Context window usage: ${pct}%`}
          title={tooltip}
        >
          <svg width="48" height="8" className="flex-shrink-0">
            <rect x="0" y="0" width="48" height="8" rx="4" fill="currentColor" opacity="0.15" />
            <rect
              x="0" y="0"
              width={Math.min(48, Math.max(2, (contextTokens / window_) * 48))}
              height="8" rx="4"
              fill={barColor}
              style={{ transition: 'width 0.3s ease' }}
            />
          </svg>
          {lastCompacted && (
            <span className="ac-text-success" title="Context was compacted" aria-label="compacted">✓</span>
          )}
          <span className={textColorCls}>
            {formatTokens(contextTokens)}/{formatTokens(contextWindow)}
          </span>
          <span className={`${textColorCls} font-medium`} title={`${pct}% of context window used`}>
            {pct}%
          </span>
        </span>
      )}

      {/* Session cumulative usage — total tokens across all LLM calls this
          session (input + output), shown once any usage was reported. Hidden
          on narrow panels; the tooltip on the model badge already covers this. */}
      {usageTotals.llmCalls > 0 && (
        <span
          className="hidden xl:flex items-center gap-0.5 flex-shrink-0"
          title={`Session usage: ${usageTotals.llmCalls} LLM calls, ${usageTotals.inputTokens + usageTotals.outputTokens} tokens total${usageTotals.cost > 0 ? `, $${usageTotals.cost.toFixed(4)}` : ''}`}
        >
          <Clock className="h-2.5 w-2.5" />
          {formatTokens(usageTotals.inputTokens + usageTotals.outputTokens)} tok
        </span>
      )}
    </>
  );
}

// ==== pi-agent turn surfaces (thinking / plan / skill / subagents / critique) =
//
// The pi-agent pipeline already EMITS all of these (agent:thinking_delta,
// agent:plan, agent:skill_selected, agent:subagent_*, agent:critique) and the
// store reducer accumulates them onto the ChatTurn — but the panel never
// rendered them. These components close that loop; each follows the
// progressive-disclosure pattern of the tool-call cluster (collapsed by
// default once idle, live-expanded while the turn is streaming).

/// Thinking block — Cursor "thought bubble" / Claude thinking pattern.
/// Auto-EXPANDED while reasoning streams (with a live elapsed timer in the
/// header), auto-COLLAPSES to "Thought for Ns" the moment the answer text or
/// the first tool call starts (the reducer stamps `thinkingEndedAt`). The
/// chevron gives the user the manual pin/toggle Cursor users asked for.
function ThinkingBlock({ turn }: { turn: ChatTurn }) {
  const active = !!turn.thinking && !turn.thinkingEndedAt && turn.streaming;
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? active;
  const ms =
    turn.thinkingStartedAt !== undefined && turn.thinkingEndedAt !== undefined
      ? turn.thinkingEndedAt - turn.thinkingStartedAt
      : null;
  if (!turn.thinking) return null;
  return (
    <div className="rounded-md border ac-border-subtle ac-surface-1 overflow-hidden">
      <button
        onClick={() => setOverride(!expanded)}
        aria-expanded={expanded}
        title={expanded ? 'Collapse reasoning' : 'Show the reasoning the model streamed before answering'}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] ac-text-3 hover:ac-surface-1 ac-transition ac-focus-ring"
      >
        <Brain className={`h-3 w-3 flex-shrink-0 ${active ? 'ac-text-info' : 'ac-text-4'}`} />
        <span className="font-medium flex-shrink-0">
          {active ? 'Thinking…' : 'Thought'}
          {!active && ms !== null && <span className="ac-text-4 font-normal"> for {formatMs(ms)}</span>}
        </span>
        {active && turn.thinkingStartedAt !== undefined && (
          <ElapsedTimer since={turn.thinkingStartedAt} className="ac-text-4 flex-shrink-0" />
        )}
        <ChevronRight
          className={`h-3 w-3 ac-text-4 ml-auto flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <div className="px-2 pb-1.5 pt-1 text-[10px] ac-text-4 italic whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto ac-hide-scrollbar border-t ac-border-subtle">
          {turn.thinking}
        </div>
      )}
    </div>
  );
}

/// Plan card — Claude Code / Cursor 1.2 "Agent To-dos" pattern. The intent
/// classifier's numbered plan, live-updated as steps complete. Expanded while
/// the turn streams (progress legibility on multi-step tasks), collapsible
/// after — the completed card stays in the transcript as the record of what
/// was done.
const PLAN_STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
};
const PLAN_STATUS_COLOR: Record<string, string> = {
  pending: 'ac-text-4',
  in_progress: 'ac-text-info',
  completed: 'ac-text-success',
  failed: 'ac-text-danger',
};

function PlanCard({ plan }: { plan: NonNullable<ChatTurn['plan']> }) {
  const done = plan.filter((p) => p.status === 'completed').length;
  const streaming = plan.some((p) => p.status === 'in_progress' || p.status === 'pending');
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? streaming;
  return (
    <div className="rounded-md border ac-border-subtle ac-surface-1 overflow-hidden">
      <button
        onClick={() => setOverride(!expanded)}
        aria-expanded={expanded}
        title={expanded ? 'Collapse plan' : 'Show the plan the agent is following'}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] ac-text-3 hover:ac-surface-1 ac-transition ac-focus-ring"
      >
        <ListChecks className="h-3 w-3 ac-text-4 flex-shrink-0" />
        <span className="font-medium flex-shrink-0">
          Plan <span className="ac-text-4 font-normal">{done}/{plan.length}</span>
        </span>
        {streaming && <Loader2 className="h-2.5 w-2.5 animate-spin ac-text-4 flex-shrink-0" />}
        <ChevronRight
          className={`h-3 w-3 ac-text-4 ml-auto flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <div className="px-2 pb-1.5 pt-1 space-y-1 border-t ac-border-subtle">
          {plan.map((p) => {
            const Icon = PLAN_STATUS_ICON[p.status] ?? Circle;
            const color = PLAN_STATUS_COLOR[p.status] ?? 'ac-text-4';
            return (
              <div key={p.step} className="flex items-start gap-1.5">
                <Icon
                  className={`h-3 w-3 mt-px flex-shrink-0 ${color} ${p.status === 'in_progress' ? 'animate-spin' : ''}`}
                />
                <span className={`text-[10px] leading-snug ${p.status === 'completed' ? 'line-through ac-text-4' : 'ac-text-2'}`}>
                  {p.description}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/// Sub-agent card — the pi-agent pipeline dispatches focused sub-agents
/// (e.g. a "designer" for layout passes). One row per dispatch with live
/// status; completed rows carry the summary + tool-call count.
function SubAgentsCard({ subAgents }: { subAgents: NonNullable<ChatTurn['subAgents']> }) {
  const anyRunning = subAgents.some((sa) => sa.status === 'running');
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? anyRunning;
  return (
    <div className="rounded-md border ac-border-subtle ac-surface-1 overflow-hidden">
      <button
        onClick={() => setOverride(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] ac-text-3 hover:ac-surface-1 ac-transition ac-focus-ring"
      >
        <BotIcon className="h-3 w-3 ac-text-4 flex-shrink-0" />
        <span className="font-medium flex-shrink-0">
          Sub-agents <span className="ac-text-4 font-normal">{subAgents.length}</span>
        </span>
        {anyRunning && <Loader2 className="h-2.5 w-2.5 animate-spin ac-text-4 flex-shrink-0" />}
        <ChevronRight
          className={`h-3 w-3 ac-text-4 ml-auto flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <div className="px-2 pb-1.5 pt-1 space-y-1 border-t ac-border-subtle">
          {subAgents.map((sa, i) => (
            <div key={`${sa.type}-${i}`} className="flex items-start gap-1.5">
              {sa.status === 'running' ? (
                <Loader2 className="h-3 w-3 mt-px flex-shrink-0 ac-text-info animate-spin" />
              ) : sa.status === 'completed' ? (
                <CheckCircle2 className="h-3 w-3 mt-px flex-shrink-0 ac-text-success" />
              ) : (
                <XCircle className="h-3 w-3 mt-px flex-shrink-0 ac-text-danger" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-[10px] ac-text-2">
                  <span className="font-medium">{sa.type}</span>
                  <span className="ac-text-4"> — {sa.task}</span>
                </div>
                {sa.summary && (
                  <div className="text-[9px] ac-text-4 mt-0.5">
                    {sa.summary}
                    {sa.toolCalls !== undefined ? ` · ${sa.toolCalls} tool calls` : ''}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/// Self-review row — surfaces the runner's mandatory critique loop
/// (pi-agent `agent:critique`): iteration number, defect list, VLM score.
/// Shown on completed turns only (while streaming it would churn).
function CritiqueRow({ critique }: { critique: NonNullable<ChatTurn['critique']> }) {
  const [expanded, setExpanded] = useState(false);
  const scoreCls =
    critique.vlmScore === undefined
      ? 'ac-text-3'
      : critique.vlmScore >= 8
        ? 'ac-text-success'
        : critique.vlmScore >= 6
          ? 'ac-text-warning'
          : 'ac-text-danger';
  const clean = critique.defects.length === 0;
  return (
    <div className="rounded-md border ac-border-subtle ac-surface-1 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        title="The agent reviewed its own output before finishing (mandatory critique loop)"
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] ac-text-3 hover:ac-surface-1 ac-transition ac-focus-ring"
      >
        <BadgeCheck className={`h-3 w-3 flex-shrink-0 ${clean ? 'ac-text-success' : 'ac-text-warning'}`} />
        <span className="font-medium flex-shrink-0">Self-review</span>
        {critique.iteration > 1 && (
          <span className="ac-text-4 flex-shrink-0">iter {critique.iteration}</span>
        )}
        <span className="ac-text-4 truncate flex-1 min-w-0 text-left">
          {clean ? 'no defects found' : `${critique.defects.length} defect${critique.defects.length === 1 ? '' : 's'} fixed`}
        </span>
        {critique.vlmScore !== undefined && (
          <span className={`font-medium flex-shrink-0 ${scoreCls}`} title="Vision-model score of the rendered canvas">
            VLM {critique.vlmScore}/10
          </span>
        )}
        <ChevronRight
          className={`h-3 w-3 ac-text-4 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && critique.defects.length > 0 && (
        <ul className="px-2 pb-1.5 pt-1 space-y-0.5 border-t ac-border-subtle">
          {critique.defects.map((d, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[10px] ac-text-3 leading-snug">
              <span className="ac-text-warning flex-shrink-0">·</span>
              {d}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/// Skill chip — which intent-classifier skill the turn routed to
/// (category · confidence · tool budget). One quiet line above the plan.
function SkillChip({ skillInfo }: { skillInfo: NonNullable<ChatTurn['skillInfo']> }) {
  const pct = Math.round(skillInfo.confidence * 100);
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ac-text-3 ac-surface-1 border ac-border-subtle"
      title={`Intent classification routed this prompt to the "${skillInfo.category}" skill (${skillInfo.method}, ${pct}% confidence). Tool budget: ${skillInfo.toolCount} calls.`}
    >
      <Sparkles className="h-3 w-3" style={{ color: 'var(--ac-accent)' }} />
      {skillInfo.category}
      <span className="ac-text-4">{pct}%</span>
    </span>
  );
}

/// Live busy row — replaces the static "agent is working…" with WHAT the
/// agent is doing right now + HOW LONG it's been going (Cursor 1.3 pattern:
/// per-row spinners + an aggregate status line with elapsed time).
function BusyRow({ onStop }: { onStop: () => void }) {
  const turns = useCanvasStore((s) => s.turns);
  const last = turns[turns.length - 1];
  const activity = useMemo(() => {
    if (!last || last.role !== 'assistant') return 'agent is working…';
    if (last.thinking && !last.thinkingEndedAt) return 'Thinking…';
    const running = [...last.toolCalls].reverse().find((tc) => tc.success === undefined);
    if (running) return `Running ${running.name}…`;
    const lastSummary = [...last.toolCalls].reverse().find((tc) => tc.summary)?.summary;
    if (lastSummary) return lastSummary;
    if (last.toolCalls.length > 0) return 'Writing response…';
    return 'agent is working…';
  }, [last]);
  const startedAt = last?.startedAt;
  return (
    <div className="flex items-center justify-between gap-2 text-xs ac-text-4 px-1 py-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
        <span className="truncate" aria-live="polite">{activity}</span>
        {startedAt !== undefined && (
          <>
            <span className="flex-shrink-0">·</span>
            <ElapsedTimer since={startedAt} className="flex-shrink-0" />
          </>
        )}
      </div>
      {/* P0-09: Inline Stop button — lets the user stop without moving the
          cursor to the top header. Mirrors the header's RunStopButton but
          appears next to the streaming response. */}
      <Button
        variant="destructive"
        size="sm"
        onClick={onStop}
        title="Stop the agent (Esc also works)"
        aria-label="Stop agent"
        className="h-6 text-[10px] px-2 py-0 gap-1 flex-shrink-0"
      >
        <Square className="h-2.5 w-2.5 fill-current" />
        Stop
      </Button>
    </div>
  );
}

/// Queued-prompt chips — messages typed while the agent was busy (Cursor 3's
/// default queueing). The store flushes them one-per-turn automatically;
/// these rows make the queue VISIBLE and removable before it fires.
function QueueChips() {
  const queuedPrompts = useCanvasStore((s) => s.queuedPrompts);
  const removeQueuedPrompt = useCanvasStore((s) => s.removeQueuedPrompt);
  if (queuedPrompts.length === 0) return null;
  return (
    <div className="mb-1.5 space-y-1" aria-label={`${queuedPrompts.length} queued prompt${queuedPrompts.length === 1 ? '' : 's'}`}>
      {queuedPrompts.map((q, i) => (
        <div
          key={q.id}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-dashed ac-border-default ac-surface-1"
          title={`${q.text}${q.selection ? `\nTargeting ${q.selection.count} layer(s)` : ''}`}
        >
          <ListPlus className="h-3 w-3 flex-shrink-0 ac-text-info" />
          <span className="text-[9px] font-medium ac-text-4 flex-shrink-0">
            {i === 0 ? 'Next' : `#${i + 1}`}
          </span>
          <span className="flex-1 text-[10px] ac-text-2 truncate min-w-0">{q.text}</span>
          {q.selection && q.selection.count > 0 && (
            <span className="text-[9px] ac-text-4 flex-shrink-0">@{q.selection.count}</span>
          )}
          <button
            onClick={() => removeQueuedPrompt(q.id)}
            aria-label={`Remove queued prompt: ${q.text.slice(0, 40)}`}
            title="Remove from queue"
            className="p-0.5 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring flex-shrink-0"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function AgentPanel({ hideHeader = false }: { hideHeader?: boolean }) {
  const turns = useCanvasStore((s) => s.turns);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const connected = useCanvasStore((s) => s.connected);
  const promptAgent = useCanvasStore((s) => s.promptAgent);
  const stopAgent = useCanvasStore((s) => s.stopAgent);
  const contextTokens = useCanvasStore((s) => s.contextTokens);
  const contextWindow = useCanvasStore((s) => s.contextWindow);
  const lastCompacted = useCanvasStore((s) => s.lastCompacted);
  const activeModel = useCanvasStore((s) => s.activeModel);
  const usageTotals = useCanvasStore((s) => s.usageTotals);
  const thinkingLevel = useSettings((s) => s.thinkingLevel);
  const setSetting = useSettings((s) => s.set);
  const [input, setInput] = useState('');
  const [activeGroup, setActiveGroup] = useState<string>('wireframes');
  // Prompt-history navigation cursor (-1 = live input, not navigating).
  const [historyCursor, setHistoryCursor] = useState(-1);
  // Slash-command autocomplete: selected index + dismissed flag (Escape).
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  // Image attachments (ChatGPT/Claude/Cursor pattern: paperclip + paste +
  // drag-and-drop, staged as preview chips until sent). Downscaled client-side
  // by lib/agent/attachments.ts before they ever leave the browser.
  const [attachments, setAttachments] = useState<AttachedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // "Jump to latest" pill — visible while the user has scrolled away from
  // the bottom (ChatGPT/Claude pattern; auto-follow pauses so they can read).
  const [showJump, setShowJump] = useState(false);
  // @-mention autocomplete (Cursor @file pattern, canvas-layer domain — see
  // chat-mentions.ts): selected index + dismissed flag (Escape).
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const document = useCanvasStore((s) => s.document);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const newSession = useCanvasStore((s) => s.newSession);
  const select = useCanvasStore((s) => s.select);
  // Design-system pack list — feeds `/pick-pack` resolution. Module-level
  // shared fetch (same as the picker), so the first AgentPanel mount warms
  // the cache for the TopMenuBar badge too.
  const { packs: packList } = useDesignSystems();
  // Canvas selection — drives the "N layers selected" context chip above the
  // input (progressive disclosure: the chip TELLS the user what context the
  // next prompt will carry, and can be cleared in place).
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const selectionCount = selectedIds.length;
  const queuePrompt = useCanvasStore((s) => s.queuePrompt);
  const documentId = useCanvasStore((s) => s.documentId);

  // ==== @-mentions (Cursor @file/@docs pattern, canvas-layer domain) ======
  //
  // Typing `@` opens a fuzzy-matched list of layer names; picking one
  // inserts `@Name` into the prompt. At submit time every resolvable
  // `@Name` is union-ed with the canvas selection into the turn's targeting
  // payload — "make @Header sticky" needs no manual selection.
  const mentionLayers = useMemo(
    () => mentionableLayers(document.shapes),
    [document.shapes],
  );
  const mentionToken = useMemo(
    // Slash commands take precedence over mentions (input starting with '/').
    () => (input.trim().startsWith('/') ? null : activeMentionToken(input)),
    [input],
  );
  const mentionMatches = useMemo(
    () => (mentionToken === null || mentionDismissed ? [] : matchMentions(mentionToken, mentionLayers)),
    [mentionToken, mentionDismissed, mentionLayers],
  );
  const mentionMenuOpen = mentionMatches.length > 0;
  // Layers resolvable from @tokens in the CURRENT input — drives the merged
  // targeting chip above the input and the submit-time selection union.
  const mentionedIds = useMemo(
    () => extractMentionedLayerIds(input, document.shapes),
    [input, document.shapes],
  );
  const targetingCount = new Set([...selectedIds, ...mentionedIds]).size;

  // ==== Draft persistence (Cursor keeps unsent input across reloads) =======
  //
  // Load once per document; save debounced (400ms); clear on send/queue.
  // Best-effort localStorage — see lib/agent/draft-store.ts.
  useEffect(() => {
    setInput(loadDraft(documentId));
  }, [documentId]);
  useEffect(() => {
    const t = setTimeout(() => saveDraft(documentId, input), 400);
    return () => clearTimeout(t);
  }, [input, documentId]);

  const matchingCommands = useMemo(
    // Cap = rendered window, so navigation can never outrun the highlight.
    // (Bug fix: previously all 13 matches were navigable but only 8 rendered —
    // ArrowDown past index 7 selected invisible items.)
    () => (cmdDismissed ? [] : matchCommands(input).slice(0, COMMAND_MENU_LIMIT)),
    [input, cmdDismissed],
  );
  const cmdMenuOpen = matchingCommands.length > 0;
  // NOTE: cmdIndex is range-clamped at every read site (Math.min against the
  // visible-list length) instead of via an effect — avoids cascading renders.

  /// Execute a resolved slash command.
  const executeCommand = (cmd: ChatCommand, args: string) => {
    if (cmd.kind === 'prompt') {
      const prompt = args ? `${cmd.run} ${args}` : cmd.run;
      if (agentBusy) {
        // Prompt commands QUEUE while the agent runs (Cursor 3's default
        // behavior — the input is never blocked, see submit() below).
        queuePrompt(prompt);
        toast.message('Queued', { description: 'Runs when the current turn finishes.' });
        return;
      }
      pushPromptHistory(prompt);
      promptAgent(prompt);
      return;
    }
    // Guard: action commands mutate canvas/app state — refuse mid-turn
    // instead of racing the agent's own patches.
    if (agentBusy) {
      toast.error('Agent is busy', { description: 'Wait for the current turn to finish.' });
      return;
    }
    const docName = (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-');
    switch (cmd.run) {
      case 'pick-pack': {
        // /pick-pack <name> — fuzzy-resolve + pin the design-system pack.
        // Matches: exact name ('vercel-geist'), suffix ('geist'), substring
        // ('radix', 'catalyst'), or dash-word ('tailwind', 'shadcn').
        if (!args.trim()) {
          toast.error('Usage: /pick-pack <name>', {
            description: `Available packs: ${packList.map((p) => p.name).join(', ') || 'loading…'}`,
          });
          break;
        }
        const resolved = resolvePackName(args, packList);
        if (!resolved) {
          toast.error(`Unknown pack "${args.trim()}"`, {
            description: `Available packs: ${packList.map((p) => p.name).join(', ')}`,
          });
          break;
        }
        setActivePack(resolved);
        toast.success(`Pinned ${humanifyPackName(resolved)}`, {
          description: 'Applies to every agent generation this session. View → Design system to change.',
        });
        break;
      }
      case 'clear':
        sendPatch({ op: 'clear', summary: 'Cleared canvas' });
        toast.success('Canvas cleared', { description: 'Undoable — /undo restores it.' });
        break;
      case 'undo':
        undo();
        break;
      case 'redo':
        redo();
        break;
      case 'new-chat': {
        const id = newSession();
        if (id) toast.success('Started a new chat', { description: 'The canvas is shared — it keeps its current state.' });
        break;
      }
      case 'select-all':
        select(document.shapes.map((s) => s.id));
        toast.message(`Selected ${document.shapes.length} layers`);
        break;
      case 'export-svg': {
        const svg = exportSvg(document.shapes);
        if (!svg) { toast.error('Nothing to export'); break; }
        downloadFile(svg, `${docName}.svg`, 'image/svg+xml');
        toast.success('Exported SVG');
        break;
      }
      case 'export-png':
        // Phase 5 §5.4 contract: capture the LIVE DOM world via html-to-image
        // (same path as the agent's agent:screenshot_request round-trip); fall
        // back to the SVG projection when no DOM world is mounted.
        void exportPngDataUrl(document.shapes, {
          worldElement: useCanvasStore.getState().worldElement,
          backgroundColor: document.background,
          scale: 2,
        }).then((dataUrl) => {
          if (!dataUrl) { toast.error('Nothing to export'); return; }
          if (dataUrl.startsWith('data:image/png')) {
            downloadDataUrl(dataUrl, `${docName}.png`);
            toast.success('Exported PNG @2x');
          } else {
            downloadFile(dataUrl, `${docName}.svg`, 'image/svg+xml');
            toast.success('Exported SVG instead', { description: 'PNG rasterization was blocked.' });
          }
        });
        break;
      case 'export-json': {
        const json = exportJson(document);
        downloadFile(json, `${docName}.pen.json`, 'application/json');
        toast.success('Exported .pen JSON');
        break;
      }
      default:
        toast.error(`Unknown command: ${cmd.cmd}`);
    }
  };

  // ==== Image attachments ====================================================
  //
  // Capability guard data — the shared model catalog tells us whether the
  // CURRENT model accepts image input (LM Studio/Cursor pattern: warn when
  // images are staged against a text-only model instead of failing at send).
  // `autoFetch` populates the catalog on mount so the guard works before the
  // user ever opens the model switcher; the request is shared module-level.
  const { data: catalogData } = useModelCatalog({ autoFetch: true });
  const configuredModelName = useSettings((s) => s.modelName);
  const guardModelId = activeModel?.modelId ?? configuredModelName;
  const guardModelEntry = useMemo(() => {
    const all = [...(catalogData?.provider.models ?? []), ...(catalogData?.zaiSandbox?.models ?? [])];
    return all.find((m) => m.id === guardModelId) ?? null;
  }, [catalogData, guardModelId]);
  // Tri-state: true/false when the catalog knows, null when unknown
  // (endpoint-only model id or listing not loaded yet) — never nag on unknown.
  const modelAcceptsImages = guardModelEntry ? modelSupportsImages(guardModelEntry.input) : null;

  /// Stage image files from ANY source (paperclip, paste, drop). Staging is
  /// client-side only, so it stays available while the agent runs (the
  /// staged images ride the NEXT prompt — or the queued one).
  /// Rejections toast once, compactly.
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const { staged, rejections } = await stageImageFiles(files, attachments.length);
    if (staged.length > 0) setAttachments((a) => [...a, ...staged]);
    if (rejections.length > 0) {
      toast.error(rejections.length === 1 ? rejections[0] : `${rejections.length} images were skipped`, {
        description: rejections.slice(0, 3).join(' · '),
      });
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((a) => a.filter((img) => img.id !== id));
  };

  /// Attach a PNG snapshot of the current canvas (v0/Figma-Make pattern: give
  /// the agent — especially a vision model — a visual reference of exactly
  /// what you're looking at). Spec Phase 5 §5.4 contract: capture the LIVE
  /// DOM-rendered world element via html-to-image — the SAME path the agent's
  /// `agent:screenshot_request` round-trip uses — so the agent sees the
  /// actual canvas (fonts, images, measured native-layout geometry,
  /// drop-shadows, gradients) instead of the lossy SVG projection. Falls
  /// back to the SVG-projection path when no DOM world is mounted
  /// (SVG-compat renderer / tainted canvas / no html-to-image).
  /// Guarantees the attachment size cap through the downscale pipeline.
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const attachCanvasSnapshot = async () => {
    if (agentBusy || snapshotBusy) return;
    const shapes = document.shapes ?? [];
    if (shapes.length === 0) {
      toast.error('Canvas is empty', { description: 'Draw something first, then attach the snapshot.' });
      return;
    }
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      toast.error(`Limit is ${MAX_ATTACHMENTS_PER_MESSAGE} images per message`);
      return;
    }
    setSnapshotBusy(true);
    try {
      // scale 1 — a chat reference doesn't need @2x; keeps the payload small.
      // worldElement from the store — the same one the agent's screenshot
      // round-trip captures. When null (SVG-compat renderer / unmounted),
      // exportPngDataUrl falls back to the SVG-projection path automatically.
      let dataUrl = await exportPngDataUrl(shapes, {
        scale: 1,
        worldElement: useCanvasStore.getState().worldElement,
        backgroundColor: document.background,
      });
      if (!dataUrl) throw new Error('rasterization failed');
      if (dataUrl.length > MAX_DATAURL_LENGTH) {
        // Huge canvas — re-encode through the downscale pipeline (1280px edge).
        const blob = await (await fetch(dataUrl)).blob();
        dataUrl = await downscaleImageFile(new File([blob], 'canvas-snapshot.png', { type: blob.type || 'image/png' }));
      }
      const attached = makeAttachedImage('canvas-snapshot.png', dataUrl);
      if (!attached) throw new Error('snapshot too large');
      setAttachments((a) => [...a, attached]);
      toast.success('Canvas snapshot attached', { description: 'The agent will see the canvas as an image.' });
    } catch {
      toast.error('Could not snapshot the canvas');
    } finally {
      setSnapshotBusy(false);
    }
  };

  // Register a global focus hook so the top-header Run button can focus
  // the chat input without prop-drilling. Cleared on unmount.
  useEffect(() => {
    (window as any).__focusAgentInput = () => {
      inputRef.current?.focus();
    };
    return () => {
      delete (window as any).__focusAgentInput;
    };
  }, []);

  // Auto-scroll to bottom on new content — ONLY when the user is already near
  // the bottom. (Bug fix: this previously forced scrollTop = scrollHeight on
  // every `turns` change — i.e. every streaming delta — making it impossible
  // to scroll up and read earlier messages while the agent streamed. The
  // standard chat-app rule: follow output only if the user is following it.)
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns]);

  // Track whether the user is "following" the bottom of the chat. The Radix
  // ScrollArea renders its viewport after mount, so attach the scroll
  // listener once it exists (short retry interval covers the race).
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const attach = (tries = 0) => {
      if (disposed) return;
      const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
      if (!el) {
        if (tries < 20) setTimeout(() => attach(tries + 1), 100);
        return;
      }
      const onScroll = () => {
        // Near-bottom threshold: 48px (a couple of lines) — anything more and
        // we consider the user scrolled away and stop following.
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const atBottom = distance < 48;
        stickToBottomRef.current = atBottom;
        // Jump-to-latest pill state — functional setState with an equality
        // guard bails out of re-renders while atBottom doesn't change.
        setShowJump((prev) => (prev === !atBottom ? prev : !atBottom));
      };
      el.addEventListener('scroll', onScroll, { passive: true });
      cleanup = () => el.removeEventListener('scroll', onScroll);
    };
    attach();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  /// Jump to the bottom of the conversation and re-engage follow-the-bottom.
  const jumpToLatest = () => {
    stickToBottomRef.current = true;
    setShowJump(false);
    const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const submit = () => {
    const text = input.trim();
    const images = attachments;
    // Sendable with text OR images alone ("what's in this image?" prompts).
    if (!text && images.length === 0) return;
    // Selection context: the CURRENT canvas selection UNION-ed with every
    // resolvable @mention in the text, so "these" AND "@Header" both carry
    // concrete layer targeting. Only when something is targeted — the chip
    // above the input discloses this.
    const mergedTargetIds = new Set([...selectedIds, ...extractMentionedLayerIds(text, document.shapes)]);
    const selection =
      mergedTargetIds.size > 0
        ? {
            count: mergedTargetIds.size,
            names: [...mergedTargetIds]
              .map((id) => document.shapes.find((s) => s.id === id)?.name)
              .filter((n): n is string => typeof n === 'string')
              .slice(0, 8),
          }
        : undefined;
    if (text.startsWith('/')) {
      // Single source of truth for command resolution (chat-commands.ts).
      // (Bug fix: the previous inline logic re-called matchCommands, which
      // returns [] once a space is present — fully-typed commands with
      // arguments like `/audit focus on contrast` were rejected as
      // "Unknown command".)
      const parsed = parseCommandInput(text);
      const resetInput = () => {
        setInput('');
        setHistoryCursor(-1);
        setCmdIndex(0);
        setCmdDismissed(false);
        clearDraft(documentId);
      };
      switch (parsed.kind) {
        case 'none':
          break; // unreachable (starts with '/'), handled below
        case 'bare':
          // Bare '/' + Enter: menu is open but nothing is confirmed — a
          // no-op. (Bug fix: this used to execute the first menu item and
          // CLEARED THE CANVAS on a stray Enter.)
          return;
        case 'exact':
          executeCommand(parsed.command, parsed.args);
          resetInput();
          return;
        case 'candidates': {
          // Autocomplete prefix (e.g. '/cl') — run the highlighted candidate.
          const selected = parsed.commands[Math.min(cmdIndex, parsed.commands.length - 1)];
          const resolved = resolveCommand(text, selected);
          if (resolved) {
            executeCommand(resolved.command, resolved.args);
            resetInput();
            return;
          }
          break;
        }
        case 'unknown':
          toast.error(`Unknown command: ${text.split(' ')[0]}`, { description: 'Type / to browse commands.' });
          return;
      }
    }
    // A prompt with ONLY images (no text) still needs a non-empty prompt for
    // the runner — fall back to a minimal ask.
    const promptText = text || 'What do you see in this image? Describe it in detail.';
    // Reset the composer regardless of where the prompt goes.
    setInput('');
    setAttachments([]);
    setHistoryCursor(-1);
    setCmdIndex(0);
    setCmdDismissed(false);
    setMentionIndex(0);
    setMentionDismissed(false);
    clearDraft(documentId);
    // Cursor 3's DEFAULT behavior: typing while the agent runs QUEUES the
    // message (the input is never disabled); it auto-sends when the current
    // turn finishes. The queue is visible + removable (QueueChips above the
    // composer), and Stop suppresses the auto-flush so an interrupted queue
    // never surprises the user.
    if (agentBusy) {
      queuePrompt(promptText, images.length > 0 ? images : undefined, selection);
      return;
    }
    pushPromptHistory(promptText);
    // Submitting re-engages follow-the-bottom (the user acted at the bottom).
    stickToBottomRef.current = true;
    promptAgent(promptText, images.length > 0 ? images : undefined, selection);
  };

  const activePrompts = PROMPT_GROUPS.find((g) => g.id === activeGroup)?.prompts ?? [];

  return (
    <div
      className="relative flex flex-col h-full ac-surface-0 ac-hide-scrollbar"
      // Drag-and-drop images anywhere onto the chat (ChatGPT/Claude pattern).
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the panel itself (not crossing children).
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          setDragOver(false);
          void addFiles(imageFilesFromDataTransfer(e.dataTransfer));
        }
      }}
    >
      {/* Drop overlay — dashed highlight over the whole panel while a file
          drag is in progress. */}
      {dragOver && (
        <div className="absolute inset-0 z-50 m-2 rounded-xl border-2 border-dashed flex items-center justify-center bg-[color:var(--ac-accent-soft)] pointer-events-none"
          style={{ borderColor: 'var(--ac-accent)' }}
        >
          <div className="flex items-center gap-2 text-xs font-medium ac-text-1">
            <Paperclip className="h-4 w-4" style={{ color: 'var(--ac-accent)' }} />
            Drop images to attach
          </div>
        </div>
      )}
      {/* Header (optional — hidden when used inside a panel that already has SessionHeader) */}
      {!hideHeader && (
      <div className="flex flex-wrap items-center justify-between gap-y-1.5 px-3 py-2 border-b ac-border-subtle">
        <div className="flex items-center gap-2 min-w-0 flex-shrink-0">
          <div className="relative">
            <Bot className="h-4 w-4 ac-text-2" />
            {agentBusy && (
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full ac-dot-success animate-pulse" />
            )}
          </div>
          <span className="text-xs font-medium ac-text-2">Agent</span>
          <Badge variant="outline" className="text-[11px] h-5 px-1.5 py-0 font-normal ac-text-3 ac-border-default" title=".pen protocol · 60+ tools available">
            .pen
          </Badge>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px] ac-text-3 min-w-0">
          <ModelContextStatus
            activeModel={activeModel}
            usageTotals={usageTotals}
            contextTokens={contextTokens}
            contextWindow={contextWindow}
            lastCompacted={lastCompacted}
          />
          {/* Thinking level quick-cycle button */}
          <button
            onClick={() => {
              const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
              const idx = levels.indexOf(thinkingLevel);
              const next = levels[(idx + 1) % levels.length];
              setSetting('thinkingLevel', next);
            }}
            title={`Thinking: ${thinkingLevel} (click to cycle)\nHigher = better reasoning on complex tasks, but slower. Off = fastest.`}
            className={`flex items-center gap-0.5 h-6 px-1.5 py-0.5 rounded ac-transition hover:ac-surface-1 flex-shrink-0 ${thinkingLevel !== 'off' ? 'ac-text-info' : 'ac-text-4'}`}
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <span className="text-[11px]">{thinkingLevel}</span>
          </button>
          {/* Connection status */}
          <span className={`flex items-center gap-0.5 flex-shrink-0 ${connected ? '' : 'ac-text-danger'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'ac-dot-success' : 'ac-dot-danger'}`} />
            {connected ? 'live' : 'offline'}
          </span>
        </div>
      </div>
      )}

      {/* Plugin UI (todo overlay, background tasks, ask-user-question dialog) */}
      <PluginUI />

      {/* Conversation — aria-live so screen readers announce streaming
          assistant output (a11y pattern from the chat-UI anatomy research). */}
      <div className="relative flex-1 min-h-0">
        <ScrollArea ref={scrollRef} className="h-full ac-hide-scrollbar">
          <div className="p-3 space-y-3" role="log" aria-live="polite" aria-label="Agent conversation">
          {turns.length === 0 && (
            <div className="space-y-3">
              <div className="rounded-lg border ac-border-subtle ac-surface-1 p-3 text-xs ac-text-2">
                <div className="flex items-center gap-1.5 mb-1.5 font-medium ac-text-1">
                  <Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--ac-accent)' }} />
                  How does this work?
                </div>
                <p className="leading-relaxed">
                  This is a Figma-like canvas where the primary user is an AI agent.
                  The agent (powered by the Pi Agent SDK&apos;s tool-calling API) sees the
                  canvas state — a .pen object tree — and manipulates it through 60+ tools
                  covering wireframes, user flows, diagrams, variables, themes, component
                  instances, slots, copy, and audits. You can also draw manually — the
                  agent will see your edits.
                </p>
                <p className="mt-2 leading-relaxed ac-text-2">
                  Attach reference images with the paperclip, by pasting, or by dropping
                  them here — vision-capable models (look for the Eye icon next to a model)
                  will use them as visual context.
                </p>
              </div>

              {/* ⌘K hint — promotes discoverability of the command palette */}
              <div className="text-center text-[10px] ac-text-4">
                Press <kbd className="px-1 py-0 rounded ac-surface-2 ac-text-3 font-mono">⌘K</kbd> for all preset prompts
              </div>

              {/* Scenario prompt groups — kept as a secondary discovery surface
                  for users who don't open the palette. */}
              <div className="flex flex-wrap gap-1">
                {PROMPT_GROUPS.map((g) => {
                  const Icon = g.icon;
                  const active = activeGroup === g.id;
                  return (
                    <button
                      key={g.id}
                      onClick={() => setActiveGroup(g.id)}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border ac-transition ac-focus-ring ${
                        active
                          ? 'ac-text-1 ac-surface-0 ac-border-default shadow-sm'
                          : 'ac-text-3 ac-surface-1 ac-border-subtle hover:ac-text-1'
                      }`}
                    >
                      <Icon className="h-3 w-3" />
                      {g.label}
                    </button>
                  );
                })}
              </div>

              <div className="space-y-1">
                {activePrompts.map((p, i) => (
                  <button
                    key={i}
                    onClick={() => promptAgent(p)}
                    disabled={agentBusy}
                    className="group/prompt block w-full text-left text-[11px] px-2.5 py-1.5 rounded-md border ac-border-subtle hover:ac-surface-1 hover:ac-border-default ac-text-2 disabled:opacity-50 ac-transition ac-focus-ring flex items-center gap-2"
                  >
                    <span className="flex-1">{p}</span>
                    <span className="opacity-0 group-hover/prompt:opacity-100 ac-text-4 transition-opacity flex-shrink-0">
                      <Send className="h-2.5 w-2.5" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn) => (
            <TurnBubble key={turn.id} turn={turn} />
          ))}
          {/* Follow-up suggestions — shown after the LAST completed assistant
              turn while idle (v0 / Lovable “what next?” pattern). Contextual:
              derived from the turn's tool trajectory + current canvas. Hidden
              on errored turns — suggesting next steps after a failure is noise. */}
          {!agentBusy &&
            turns.length >= 2 &&
            turns[turns.length - 1].role === 'assistant' &&
            !turns[turns.length - 1].streaming &&
            !turns[turns.length - 1].error && (
            <FollowUps turn={turns[turns.length - 1]} />
          )}
          {agentBusy && <BusyRow onStop={() => stopAgent()} />}
          {agentBusy && <SteerInput />}
          </div>
        </ScrollArea>

        {/* Jump-to-latest pill — ChatGPT/Claude pattern. Shown only while the
            user has scrolled away from the bottom (auto-follow is paused);
            clicking re-engages follow + scrolls down. */}
        {showJump && (
          <button
            onClick={jumpToLatest}
            aria-label="Jump to latest message"
            title="Jump to latest"
            className="absolute bottom-3 right-3 z-20 flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium ac-surface-0 ac-border-default shadow-md hover:ac-surface-1 ac-transition ac-focus-ring ac-text-2"
          >
            <ArrowDown className="h-3 w-3" />
            Latest
          </button>
        )}
      </div>

      {/* Input — minimal chrome. Paperclip (image attach) always visible;
          Send/Queue appears when there's text OR staged attachments. The
          composer STAYS ENABLED while the agent runs — Enter queues the
          message (Cursor 3 default) instead of dead-ending. */}
      <div className="border-t ac-border-subtle p-2 ac-surface-0">
        {/* Queued prompts (typed while busy) — visible + removable; the store
            auto-flushes one per completed turn. */}
        <QueueChips />
        {/* Targeting context chip (progressive disclosure) — canvas selection
            ∪ resolvable @mentions. Shows WHAT context the next prompt will
            carry; × clears the canvas selection in place. */}
        {targetingCount > 0 && (
          <div
            className="flex items-center gap-1.5 mb-1.5 px-2 py-1 rounded-md border ac-border-subtle ac-surface-1"
            title={`The agent will target ${targetingCount} layer${targetingCount === 1 ? '' : 's'} (canvas selection + @mentions — "these"/"those" in your prompt refers to them).`}
          >
            <BoxSelect className="h-3 w-3 flex-shrink-0 ac-text-info" />
            <span className="text-[10px] ac-text-2 truncate flex-1">
              {targetingCount} layer{targetingCount === 1 ? '' : 's'} targeted{mentionedIds.length > 0 ? ' (incl. @mentions)' : ''} — agent will focus on them
            </span>
            {selectionCount > 0 && (
              <button
                onClick={() => select([])}
                aria-label="Clear selection context"
                title="Clear selection (@mentions in the text stay active)"
                className="p-0.5 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring flex-shrink-0"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        )}
        {/* Slash-command autocomplete — floats above the textarea. */}
        {cmdMenuOpen && (
          <div className="mb-1.5 rounded-lg border ac-border-default ac-surface-0 shadow-lg overflow-hidden" role="listbox" aria-label="Slash commands">
            {matchingCommands.map((c, i) => {
              const isSel = i === Math.min(cmdIndex, matchingCommands.length - 1);
              return (
                <button
                  key={c.cmd}
                  role="option"
                  aria-selected={isSel}
                  disabled={agentBusy}
                  onClick={() => {
                    // Action commands run immediately on click. Prompt commands
                    // fill the input with `/cmd ` so the user can add arguments
                    // (or press Enter to send as-is). (Bug fix: previously a
                    // click only filled the input for BOTH kinds — action
                    // commands needed a second Enter.)
                    if (c.kind === 'action' && !c.args) {
                      executeCommand(c, '');
                      setInput('');
                      setCmdIndex(0);
                      setCmdDismissed(false);
                    } else {
                      setInput(c.cmd + ' ');
                      setCmdIndex(i);
                      inputRef.current?.focus();
                    }
                  }}
                  onMouseEnter={() => setCmdIndex(i)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ac-transition border-l-2 disabled:opacity-50 ${
                    isSel ? 'ac-surface-1 ac-border-l-[color:var(--ac-accent)]' : 'ac-border-transparent'
                  }`}
                >
                  <code className={`text-[11px] font-mono px-1 py-0.5 rounded ac-surface-2 ${isSel ? 'ac-text-1' : 'ac-text-2'}`}>{c.cmd}</code>
                  <span className="flex-1 text-[10px] ac-text-3 truncate">{c.hint}</span>
                  {isSel && <CornerDownLeft className="h-2.5 w-2.5 ac-text-4 flex-shrink-0" />}
                </button>
              );
            })}
          </div>
        )}
        {/* @-mention autocomplete — same listbox pattern as the slash menu.
            Open while an @token is active (Cursor @file pattern); picks insert
            `@Name` and merge into the prompt's targeting at submit. */}
        {mentionMenuOpen && (
          <div className="mb-1.5 rounded-lg border ac-border-default ac-surface-0 shadow-lg overflow-hidden" role="listbox" aria-label="Mention a layer">
            {mentionMatches.map((m, i) => {
              const isSel = i === Math.min(mentionIndex, mentionMatches.length - 1);
              return (
                <button
                  key={m.id}
                  role="option"
                  aria-selected={isSel}
                  onClick={() => {
                    setInput(applyMention(input, m));
                    setMentionIndex(0);
                    setMentionDismissed(false);
                    inputRef.current?.focus();
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ac-transition border-l-2 ${
                    isSel ? 'ac-surface-1 ac-border-l-[color:var(--ac-accent)]' : 'ac-border-transparent'
                  }`}
                >
                  <AtSign className="h-3 w-3 ac-text-4 flex-shrink-0" />
                  <span className="text-[11px] ac-text-1 truncate flex-1 min-w-0">{m.name}</span>
                  <span className="text-[9px] ac-text-4 font-mono flex-shrink-0">{m.type}</span>
                  {isSel && <CornerDownLeft className="h-2.5 w-2.5 ac-text-4 flex-shrink-0" />}
                </button>
              );
            })}
          </div>
        )}
        <div className="rounded-lg border ac-border-default ac-surface-0 focus-within:ac-border-strong ac-transition shadow-sm">
          {/* Staged attachment previews — thumbnails with remove ×, name +
              compacted size. ChatGPT/Claude pattern; max 4 per message. */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-2">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="group/att relative rounded-md border ac-border-subtle overflow-hidden ac-surface-1"
                  title={`${att.name} · ${formatDataUrlSize(att.dataUrl)}`}
                >
                          <img src={att.dataUrl} alt={att.name} className="h-14 w-14 object-cover" />
                  <button
                    onClick={() => removeAttachment(att.id)}
                    aria-label={`Remove ${att.name}`}
                    title="Remove attachment"
                    className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/70 text-white opacity-0 group-hover/att:opacity-100 transition-opacity ac-focus-ring"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                  <div className="absolute bottom-0 inset-x-0 px-1 py-px bg-black/70 text-white text-[10px] font-mono truncate">
                    {formatDataUrlSize(att.dataUrl)}
                  </div>
                </div>
              ))}
              {attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE && (
                <div className="flex items-center px-1 text-[9px] ac-text-4">max {MAX_ATTACHMENTS_PER_MESSAGE}</div>
              )}
            </div>
          )}
          {/* Vision guard — LM Studio/Cursor pattern: warn (don't block) when
              images are staged against a model KNOWN to lack image input.
              Unknown capability (endpoint-only ids) never nags. */}
          {attachments.length > 0 && modelAcceptsImages === false && (
            <div className="flex items-center gap-1.5 mx-2 mt-2 px-2 py-1 rounded-md text-[10px] ac-text-warning ac-surface-1 border ac-border-subtle">
              <TriangleAlert className="h-3 w-3 flex-shrink-0" />
              <span className="leading-snug">
                {guardModelId} doesn’t accept image input — switch to a vision model (Eye) to use attachments.
              </span>
            </div>
          )}
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Reopen the command menu if the user edits back to a command.
              if (cmdDismissed && !e.target.value.trim().startsWith('/')) setCmdDismissed(false);
              // Reopen the mention menu after Escape once '@' is gone.
              if (mentionDismissed && !e.target.value.includes('@')) setMentionDismissed(false);
              // Editing text manually exits history-navigation mode.
              if (historyCursor !== -1) setHistoryCursor(-1);
            }}
            // Paste-to-attach (ChatGPT/Claude/Cursor pattern): clipboard image
            // files stage as attachments instead of being dropped on the floor.
            onPaste={(e) => {
              const files = imageFilesFromDataTransfer(e.clipboardData);
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            placeholder={agentBusy
              ? 'Queue a follow-up message… it sends when this turn finishes'
              : 'Ask the agent to design something…  (@ mention layers · / commands · paste images)'}
            className="text-xs resize-none min-h-[44px] max-h-[120px] border-0 shadow-none focus-visible:ring-0 ac-text-2 placeholder:ac-text-4 bg-transparent"
            onKeyDown={(e) => {
              // --- @-mention autocomplete keys (menu open) — same pattern as
              //     the slash menu: arrows navigate, Tab/Enter apply, Esc dismisses.
              if (mentionMenuOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mentionMatches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                  return;
                }
                if (e.key === 'Tab' || e.key === 'Enter') {
                  e.preventDefault();
                  setInput(applyMention(input, mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)]));
                  setMentionIndex(0);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMentionDismissed(true);
                  return;
                }
              }
              // --- Slash-command autocomplete keys (menu open) ---
              if (cmdMenuOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCmdIndex((i) => (i + 1) % matchingCommands.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCmdIndex((i) => (i - 1 + matchingCommands.length) % matchingCommands.length);
                  return;
                }
                if (e.key === 'Tab') {
                  e.preventDefault();
                  setInput(matchingCommands[Math.min(cmdIndex, matchingCommands.length - 1)].cmd + ' ');
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setCmdDismissed(true);
                  return;
                }
                // Enter falls through to submit → executes the selected command.
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                // --- Prompt history recall (terminal pattern) ---
                // Active when the input is empty, or while already navigating
                // history. ArrowDown past the newest entry returns to live input.
                const navigating = historyCursor !== -1;
                if (e.key === 'ArrowUp' && (input === '' || navigating)) {
                  const next = navigateHistory(historyCursor, 'up');
                  if (next) {
                    e.preventDefault();
                    setHistoryCursor(next.cursor);
                    setInput(next.text);
                  }
                  return;
                }
                if (e.key === 'ArrowDown' && navigating) {
                  e.preventDefault();
                  const next = navigateHistory(historyCursor, 'down');
                  if (next) {
                    setHistoryCursor(next.cursor);
                    setInput(next.text);
                  }
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {/* Action row — always visible: paperclip (image attach) on the
              left, Send/Queue on the right once there's text OR staged
              attachments. ChatGPT keeps the attach button permanently
              available so images can be staged before typing. */}
          <div className="flex flex-wrap items-center justify-between gap-y-1 gap-x-2 px-2 pb-1.5 pt-0.5 border-t ac-border-subtle">
            {/* Hidden file input + paperclip trigger (ChatGPT pattern). */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = ''; // allow re-selecting the same file
                void addFiles(files);
              }}
            />
            <div className="flex items-center gap-1">
              {/* Canvas snapshot attach (v0/Figma-Make pattern) — renders the
                  current canvas to a PNG and stages it as an image attachment.
                  Disabled while the agent runs: the canvas is mid-mutation,
                  a snapshot would capture a half-applied state. */}
              <button
                onClick={() => void attachCanvasSnapshot()}
                disabled={snapshotBusy || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                title="Attach a snapshot of the canvas as an image reference"
                aria-label="Attach canvas snapshot"
                className="p-1 rounded ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {snapshotBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
              </button>
              {/* File attach — available even while the agent runs (staging is
                  client-side; images ride the next or queued prompt). */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                title={`Attach images (${attachments.length}/${MAX_ATTACHMENTS_PER_MESSAGE}) — paste or drop works too`}
                aria-label="Attach images"
                className="p-1 rounded ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Paperclip className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* Keyboard semantics hint — the input's behavior CHANGES while
                the agent runs (send vs queue), so the affordance is stated
                instead of assumed (docs/chat-parity.md item 9). */}
            <span className="text-[9px] ac-text-4 hidden sm:block truncate px-1">
              {agentBusy ? '⏎ queues after this turn' : '⏎ send · ⇧⏎ newline'}
            </span>
            {(input.trim() || attachments.length > 0) && (
              <Button
                size="sm"
                onClick={submit}
                title={agentBusy ? 'Queue this message — it sends automatically when the current turn finishes' : 'Send to the agent'}
                className="h-6 text-[11px] text-white flex-shrink-0"
                style={{ backgroundColor: 'var(--ac-accent)' }}
              >
                {agentBusy ? (
                  <>
                    <ListPlus className="h-3 w-3 mr-1" />
                    Queue
                  </>
                ) : (
                  <>
                    <Send className="h-3 w-3 mr-1" />
                    Send
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Memoized: the reducer replaces turn objects immutably, so unchanged turns
// keep their reference and bail out — only the actively-streaming turn
// re-renders per delta (the full-thread re-parse was a measurable jank
// source on long conversations).
const TurnBubble = memo(function TurnBubble({ turn }: { turn: ChatTurn }) {
  const forkActiveSession = useCanvasStore((s) => s.forkActiveSession);
  const promptAgent = useCanvasStore((s) => s.promptAgent);
  const editUserTurn = useCanvasStore((s) => s.editUserTurn);
  const setTurnFeedback = useCanvasStore((s) => s.setTurnFeedback);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const diff = useMemo(
    () => (turn.patchOps && turn.patchOps.length > 0 ? summarizeTurnDiff(turn.patchOps) : null),
    [turn.patchOps],
  );
  // Inline edit state (Cursor edit-message pattern): the user bubble swaps
  // to a composer; Save & resend truncates the thread after this message
  // and re-sends (editUserTurn), Esc/Cancel restores the bubble.
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const startEditing = () => {
    if (!turn.text || agentBusy) return;
    setEditText(turn.text);
    setEditing(true);
  };
  const commitEdit = () => {
    if (!editText.trim() || agentBusy) return;
    setEditing(false);
    editUserTurn(turn.id, editText);
    toast.message('Edited — regenerating from here');
  };
  if (turn.role === 'user') {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group flex gap-2">
            <div className="w-6 h-6 rounded-full ac-surface-2 flex items-center justify-center flex-shrink-0">
              <User className="h-3 w-3 ac-text-3" />
            </div>
            {editing ? (
              /* Inline edit composer — ChatGPT/Claude edit-message pattern.
                 Enter saves & resends, Shift+Enter newlines, Esc cancels. */
              <div className="flex-1 rounded-lg border ac-border-default ac-surface-0 p-2" style={{ borderColor: 'var(--ac-accent)' }}>
                <Textarea
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      commitEdit();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditing(false);
                    }
                  }}
                  className="text-xs resize-none min-h-[44px] max-h-[160px] border-0 shadow-none focus-visible:ring-0 ac-text-2 p-0 bg-transparent"
                />
                <div className="flex items-center justify-end gap-1 mt-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(false)}
                    className="h-6 text-[10px] px-2"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={commitEdit}
                    disabled={!editText.trim()}
                    className="h-6 text-[10px] px-2 text-white"
                    style={{ backgroundColor: 'var(--ac-accent)' }}
                  >
                    <CornerDownLeft className="h-3 w-3 mr-1" />
                    Save & resend
                  </Button>
                </div>
              </div>
            ) : (
            <div
              className="flex-1 min-w-0 text-xs ac-text-1 ac-surface-1 rounded-lg rounded-tl-sm p-2 break-words [overflow-wrap:anywhere]"
              // Absolute timestamp on hover (progressive disclosure — no
              // visible chrome, but the info is one hover away).
              title={turn.startedAt ? new Date(turn.startedAt).toLocaleString() : undefined}
            >
              {turn.text}
              {/* Selection-targeting chip — what canvas layers this prompt
                  was aimed at (Figma-AI-style context trail). */}
              {turn.selection && turn.selection.count > 0 && (
                <span
                  className="inline-flex items-center gap-1 mt-1.5 px-1.5 py-0.5 rounded text-[9px] ac-text-3 ac-surface-2 border ac-border-subtle"
                  title={`Sent with ${turn.selection.count} layer(s) selected: ${turn.selection.names.join(', ')}`}
                >
                  <BoxSelect className="h-2.5 w-2.5 ac-text-info" />
                  {turn.selection.count} layer{turn.selection.count === 1 ? '' : 's'} targeted
                </span>
              )}
              {/* Attachment thumbnails (sent images). Click opens the
                  full-size data URL in a new tab for inspection. */}
              {turn.images && turn.images.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {turn.images.map((img) => (
                    <button
                      key={img.id}
                      onClick={() => window.open(img.dataUrl, '_blank')}
                      title={`${img.name} — click to view full size`}
                      className="relative rounded-md border ac-border-default overflow-hidden ac-focus-ring cursor-zoom-in"
                    >
                                  <img src={img.dataUrl} alt={img.name} className="h-20 w-20 object-cover" />
                      <span className="absolute bottom-0 inset-x-0 px-1 py-px bg-black/70 text-white text-[10px] font-mono truncate">
                        {img.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            )}
            {/* Hover actions (progressive disclosure — icons replace the
                hidden right-click menu as the primary affordance): copy +
                edit + fork. Fade in on hover/focus; always
                keyboard-reachable. */}
            {!editing && turn.text && (
              <button
                onClick={() => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    navigator.clipboard.writeText(turn.text ?? '').then(() => toast.message('Prompt copied to clipboard'));
                  }
                }}
                className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity self-start mt-0.5 h-7 w-7 inline-flex items-center justify-center rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
                title="Copy prompt"
                aria-label="Copy prompt"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            )}
            {!editing && turn.text && (
              <button
                onClick={startEditing}
                disabled={agentBusy}
                className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity self-start mt-0.5 h-7 w-7 inline-flex items-center justify-center rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring disabled:opacity-30 disabled:cursor-not-allowed"
                title={agentBusy ? 'Edit is available when the agent is idle' : 'Edit and resend from here (discards what follows)'}
                aria-label="Edit and resend"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {!editing && turn.messageId && (
              <button
                onClick={() => forkActiveSession(turn.messageId)}
                className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity self-start mt-0.5 h-7 w-7 inline-flex items-center justify-center rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
                title="Fork chat from this message"
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        {/* P1-27: User message right-click — Copy prompt, Edit & resend,
            Fork from here, Pin to top, Delete. */}
        <ContextMenuContent>
          <ContextMenuItem onClick={() => {
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
              navigator.clipboard.writeText(turn.text ?? '').then(() => toast.message('Prompt copied to clipboard'));
            }
          }}>
            Copy prompt
          </ContextMenuItem>
          <ContextMenuItem
            disabled={agentBusy || !turn.text}
            onClick={startEditing}
          >
            Edit & resend
          </ContextMenuItem>
          {turn.messageId && (
            <ContextMenuItem onClick={() => {
              forkActiveSession(turn.messageId);
              toast.message('Branched from this message');
            }}>
              Fork from here
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group flex gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center flex-shrink-0 shadow-sm">
            <Bot className="h-3 w-3 text-white" />
          </div>
          <div className="flex-1 min-w-0 space-y-2">
            {/* Reasoning stream (pi-agent thinking_delta) — Cursor
                thought-bubble pattern, above everything else. */}
            {turn.thinking && <ThinkingBlock turn={turn} />}
            {/* Intent-classifier skill routing — one quiet chip. */}
            {turn.skillInfo && <div><SkillChip skillInfo={turn.skillInfo} /></div>}
            {/* Execution plan (Claude Code to-dos pattern) — live checklist. */}
            {turn.plan && turn.plan.length > 0 && <PlanCard plan={turn.plan} />}
            {/* Sub-agent dispatches — one card per turn, expandable rows. */}
            {turn.subAgents && turn.subAgents.length > 0 && <SubAgentsCard subAgents={turn.subAgents} />}
            {/* Tool calls — collapsed to ONE summary row per completed turn
                (ChatGPT "Used N tools" pattern); expands for the details.
                While any call is pending the cluster stays open so the user
                sees live activity. See ToolCallsCluster below. */}
            {turn.toolCalls.length > 0 && <ToolCallsCluster toolCalls={turn.toolCalls} />}
            {/* Turn diff summary — "what did the agent change" at a glance
                (Cursor's "Edited N files" / GitHub +/- language). Only on
                completed turns with tracked mutations. */}
            {diff && !turn.streaming && !isDiffEmpty(diff) && <DiffSummaryCard diff={diff} turn={turn} />}
            {/* Text — rendered as markdown (bold, lists, code blocks) the way
                Claude / ChatGPT / v0 render assistant messages. The `streaming`
                flag drives the blinking caret at the end of the last block. */}
            {turn.text && (
              <MarkdownMessage text={turn.text} streaming={turn.streaming} />
            )}
            {/* Hover actions (ChatGPT/Claude/Cursor pattern): copy + 👍/👎
                feedback + regenerate. Fade in on hover/focus — the
                right-click menu keeps the extended actions for power users. */}
            {!turn.streaming && turn.text && (
              <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity -ml-1">
                <button
                  onClick={() => {
                    if (typeof navigator !== 'undefined' && navigator.clipboard) {
                      navigator.clipboard.writeText(turn.text ?? '').then(() => toast.message('Message copied to clipboard'));
                    }
                  }}
                  className="h-7 w-7 inline-flex items-center justify-center rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
                  title="Copy message"
                  aria-label="Copy message"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setTurnFeedback(turn.id, 'up')}
                  className={`h-7 w-7 inline-flex items-center justify-center rounded ac-transition ac-focus-ring ${turn.feedback === 'up' ? 'ac-text-success' : 'ac-text-4 hover:ac-text-1 hover:ac-surface-2'}`}
                  title={turn.feedback === 'up' ? 'Rated good (click to undo)' : 'Rate this response'}
                  aria-label="Good response"
                  aria-pressed={turn.feedback === 'up'}
                >
                  <ThumbsUp className={`h-3.5 w-3.5 ${turn.feedback === 'up' ? 'fill-current' : ''}`} />
                </button>
                <button
                  onClick={() => setTurnFeedback(turn.id, 'down')}
                  className={`h-7 w-7 inline-flex items-center justify-center rounded ac-transition ac-focus-ring ${turn.feedback === 'down' ? 'ac-text-danger' : 'ac-text-4 hover:ac-text-1 hover:ac-surface-2'}`}
                  title={turn.feedback === 'down' ? 'Rated bad (click to undo)' : 'Rate this response'}
                  aria-label="Bad response"
                  aria-pressed={turn.feedback === 'down'}
                >
                  <ThumbsDown className={`h-3.5 w-3.5 ${turn.feedback === 'down' ? 'fill-current' : ''}`} />
                </button>
                <button
                  disabled={agentBusy}
                  onClick={() => {
                    if (agentBusy) return;
                    const turns = useCanvasStore.getState().turns;
                    const idx = turns.findIndex((t) => t.id === turn.id);
                    const userTurn = idx > 0 ? turns[idx - 1] : null;
                    if (userTurn?.role === 'user' && userTurn.text) {
                      promptAgent(
                        userTurn.text,
                        userTurn.images && userTurn.images.length > 0 ? userTurn.images : undefined,
                        userTurn.selection,
                      );
                      toast.message('Regenerating…');
                    } else {
                      toast.message('No preceding prompt to regenerate from');
                    }
                  }}
                  className="h-7 w-7 inline-flex items-center justify-center rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Regenerate response"
                  aria-label="Regenerate response"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {turn.streaming && !turn.text && turn.toolCalls.length === 0 && (
              <div className="flex items-center gap-1.5 text-xs ac-text-4">
                <Loader2 className="h-3 w-3 animate-spin" />
                thinking…
              </div>
            )}
            {/* Turn meta footer — tool count + duration + token usage +
                relative time. Shown on completed turns (not while streaming). */}
            {!turn.streaming && (turn.toolCalls.length > 0 || turn.startedAt) && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] ac-text-4">
                {turn.toolCalls.length > 0 && (
                  <span className="flex items-center gap-0.5 flex-shrink-0" title={`${turn.toolCalls.length} tool calls`}>
                    <Wrench className="h-3 w-3" />
                    {turn.toolCalls.length} tools
                  </span>
                )}
                {turn.startedAt && (
                  <span className="flex items-center gap-0.5 flex-shrink-0" title="Turn duration">
                    <Clock className="h-3 w-3" />
                    {formatDuration(turn.endedAt ?? Date.now(), turn.startedAt)}
                  </span>
                )}
                {turn.tokenUsage && (turn.tokenUsage.input > 0 || turn.tokenUsage.output > 0) && (
                  <span
                    className="flex items-center gap-0.5 flex-shrink-0"
                    title={`Turn token usage: ${fmtInt(turn.tokenUsage.input)} input + ${fmtInt(turn.tokenUsage.output)} output (all LLM calls in this turn)`}
                  >
                    <Cpu className="h-3 w-3" />
                    {formatTokens(turn.tokenUsage.input + turn.tokenUsage.output)} tok
                  </span>
                )}
              </div>
            )}
            {/* Self-review (pi-agent critique loop) — iteration + defects +
                VLM score. After the footer so it reads as the turn's closing
                quality gate. */}
            {turn.critique && !turn.streaming && <CritiqueRow critique={turn.critique} />}
            {/* Failed turn — inline Retry affordance. The error message lives
                on the turn (NOT spliced into the markdown text anymore); this
                row is its surface, with the full message (wrapped, not
                truncated — errors name the problem so the user can act). */}
            {turn.error && !turn.streaming && (
              <div className="rounded-md border ac-border-subtle ac-surface-1 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[10px] font-medium ac-text-danger flex-shrink-0">
                    <TriangleAlert className="h-3 w-3 flex-shrink-0" />
                    Turn failed
                  </span>
                  <button
                    disabled={agentBusy}
                    onClick={() => {
                      if (agentBusy) return;
                      const turns = useCanvasStore.getState().turns;
                      const idx = turns.findIndex((t) => t.id === turn.id);
                      const userTurn = idx > 0 ? turns[idx - 1] : null;
                      if (userTurn?.role === 'user' && userTurn.text) {
                        promptAgent(
                          userTurn.text,
                          userTurn.images && userTurn.images.length > 0 ? userTurn.images : undefined,
                          userTurn.selection,
                        );
                        toast.message('Retrying…');
                      } else {
                        toast.message('No preceding prompt to retry from');
                      }
                    }}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ac-text-2 ac-surface-2 hover:ac-text-1 ac-transition ac-focus-ring disabled:opacity-40 flex-shrink-0"
                    title="Re-send the previous prompt (with its attachments)"
                  >
                    <RotateCcw className="h-2.5 w-2.5" />
                    Retry
                  </button>
                </div>
                <div className="mt-1 text-[10px] ac-text-danger/90 break-words leading-snug opacity-80">
                  {turn.error}
                </div>
              </div>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      {/* P1-28: Assistant message right-click — Copy message, Regenerate,
          Branch from here, Stop, Replay tool calls, Pin to top. */}
      <ContextMenuContent>
        <ContextMenuItem onClick={() => {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(turn.text ?? '').then(() => toast.message('Message copied to clipboard'));
          }
        }}>
          Copy message
        </ContextMenuItem>
        <ContextMenuItem
          disabled={agentBusy}
          onClick={() => {
            // Find the preceding user turn to re-send its prompt.
            const turns = useCanvasStore.getState().turns;
            const idx = turns.findIndex((t) => t.id === turn.id);
            const userTurn = idx > 0 ? turns[idx - 1] : null;
            if (userTurn?.role === 'user' && userTurn.text) {
              promptAgent(
                userTurn.text,
                userTurn.images && userTurn.images.length > 0 ? userTurn.images : undefined,
                userTurn.selection,
              );
              toast.message('Regenerating…');
            } else {
              toast.message('No preceding prompt to regenerate from');
            }
          }}
        >
          Regenerate
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!turn.messageId}
          onClick={() => {
            if (!turn.messageId) return;
            forkActiveSession(turn.messageId);
            toast.message('Branched from this message');
          }}
        >
          Branch from here
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => toast.message('Replay tool calls — not yet implemented (P2-33)')}>
          Replay tool calls
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

// ==== Tool-call cards (progressive disclosure) ================================
//
// Long agent turns stack dozens of tool calls, each with a JSON args preview
// and a summary — a wall of monospace text that buries the actual response.
// Research pattern (ChatGPT / Cursor / Cline):
//
//   - ChatGPT: ONE summary row per turn ("Used 29 tools", or the last
//     activity label); expanding reveals the individual calls.
//   - Cursor: per-call rows collapse to a single line (name + status);
//     users explicitly request collapse/expand controls in agent chat.
//   - Cline: status line shows current activity; details open on demand.
//
// Two levels of disclosure here:
//   1. ToolCallsCluster — turn-level: one row when finished, live-expanded
//      while any call is pending (users watch activity while it runs, then
//      it folds away).
//   2. ToolCallEntry — card-level: single line with the summary inline;
//      args JSON + full summary expand on click (chevron).

// ==== Turn diff summary card =================================================
//
// "What did the agent change" at a glance — the canvas analog of Cursor's
// "Edited N files" chip and GitHub's +/- diffstat language:
//
//   +12   3   ~5        [expand ▸]
//   created deleted updated
//
// Categories render in the order GitHub users already scan: green additions
// (created), red deletions, amber modifications, neutral restructuring.
// Expanding lists the per-op summary lines (the human-readable patch
// summaries each tool authored). The card is derived from compact PatchOpRecords
// tracked by the canvas store during the turn — see lib/agent/turn-diff.ts.
//
// Restore action: every turn's snapshot has a `parentSnapshotId` pointing at
// the snapshot that existed BEFORE this turn's mutations — i.e. the canvas
// state at the start of the turn. The "Restore from before this turn" button
// restores that parent snapshot, effectively reverting everything the agent
// did this turn in a single click (Cursor's "Restore" / v0's "Rewind to here").
//
// In 'review' approval mode (settings.approvalMode === 'review'), the agent
// runs destructive ops freely without per-call gating — so this card is the
// user's bulk-review affordance. The restore button is surfaced prominently
// at the top of the card (vs. hidden in the expanded view) when the turn
// contained any destructive op (delete/clear).

function DiffSummaryCard({
  diff,
  turn,
}: {
  diff: import('@/lib/agent/turn-diff').TurnDiffSummary;
  turn: ReturnType<typeof useCanvasStore.getState>['turns'][number];
}) {
  const [expanded, setExpanded] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // Look up the snapshot captured at the end of THIS turn — its
  // parentSnapshotId is the "before this turn" state. Snapshots are
  // append-only and document-scoped (shared-canvas model); we use the
  // session-store directly so React renders stay minimal (re-lookup
  // happens only when the snapshot map changes or the turn's messageId
  // changes).
  const ss = useSessionStore.getState();
  const sessionId = turn.sessionId ?? useCanvasStore.getState().activeSessionId ?? '';
  // The session's documentId is the snapshot lookup key under the
  // shared-canvas model (sessions are chat transcripts; documents own
  // the snapshot timeline). Fall back to the canvas's documentId for
  // sessions that haven't synced yet.
  const sess = sessionId ? useSessionStore.getState().sessions[sessionId] : undefined;
  const documentId = sess?.documentId ?? useCanvasStore.getState().documentId;
  const turnSnapshot = documentId && turn.messageId
    ? ss.listSnapshots(documentId).find((s) => s.sourceMessageId === turn.messageId)
    : undefined;
  const parentSnapshot = turnSnapshot?.parentSnapshotId
    ? ss.snapshots[turnSnapshot.parentSnapshotId]
    : undefined;

  // Whether the diff contains any destructive op (delete / clear). When
  // true AND approval mode is 'review', the restore button is surfaced at
  // the top of the card (the user's primary review affordance).
  const approvalMode = useSettings.getState().approvalMode;
  const hasDestructive = diff.deleted > 0 || diff.cleared;
  const reviewMode = approvalMode === 'review';
  const showRestoreProminent = reviewMode && hasDestructive;

  const canRestore = !!parentSnapshot && !restoring;

  const handleRestore = async () => {
    if (!parentSnapshot || !documentId) return;
    setRestoring(true);
    try {
      const restored = useSessionStore.getState().restoreSnapshot(documentId, parentSnapshot.id);
      if (restored) {
        // Load the restored document into the live canvas — same pattern
        // as RunHistoryPanel's handleRestoreSnapshot (with the document
        // id preserved so the canvas's own id stays stable).
        useCanvasStore.setState({
          document: { ...restored.document, id: documentId },
          selectedIds: [],
        });
        toast.success('Restored from before this turn', {
          description: `${parentSnapshot.nodeCount} nodes · parent snapshot ${parentSnapshot.id.slice(0, 8)}`,
        });
      } else {
        toast.error('Could not restore', { description: 'The before-this-turn snapshot is missing.' });
      }
    } catch (err) {
      toast.error('Restore failed', { description: err instanceof Error ? err.message : 'unknown error' });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="rounded-md border ac-border-subtle ac-surface-1 overflow-hidden">
      {/* Review-mode banner — surfaces the restore action prominently when
          the turn had destructive ops and the user is in 'review' mode. */}
      {showRestoreProminent && (
        <div className="px-2 py-1.5 flex items-center gap-2 border-b ac-border-subtle bg-[var(--ac-warning-soft,hsl(38,95%,95%))]">
          <TriangleAlert className="h-3 w-3 flex-shrink-0" style={{ color: 'var(--ac-warning)' }} />
          <span className="text-[10px] ac-text-2 flex-1 min-w-0">
            Agent ran <span className="font-medium">{diff.deleted + (diff.cleared ? 1 : 0)} destructive op{(diff.deleted + (diff.cleared ? 1 : 0)) === 1 ? '' : 's'}</span> this turn.
            Review and restore if needed.
          </span>
          <button
            onClick={handleRestore}
            disabled={!canRestore}
            className="text-[10px] px-2 py-0.5 rounded font-medium ac-surface-0 hover:opacity-90 ac-transition disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--ac-warning)' }}
            title={parentSnapshot ? `Restore to snapshot ${parentSnapshot.id.slice(0, 8)} (before this turn)` : 'No before-this-turn snapshot available'}
          >
            {restoring ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RotateCcw className="h-2.5 w-2.5 inline mr-0.5" />}
            Restore from before this turn
          </button>
        </div>
      )}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        title={`Canvas changes this turn — ${diff.entries.length} operation${diff.entries.length === 1 ? '' : 's'}. Click to ${expanded ? 'collapse' : 'expand'} the details.`}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-[10px] hover:ac-surface-2 ac-transition ac-focus-ring text-left"
      >
        <GitCompareArrows className="h-3 w-3 ac-text-4 flex-shrink-0" />
        <span className="ac-text-2 font-medium flex-shrink-0">Canvas changes</span>
        <span className="flex items-center gap-1.5 flex-wrap">
          {diff.cleared && (
            <span className="ac-text-danger font-medium" title="Canvas cleared">cleared</span>
          )}
          {diff.created > 0 && (
            <span className="ac-text-success font-medium" title={`${diff.created} layer${diff.created === 1 ? '' : 's'} created`}>
              +{diff.created}
            </span>
          )}
          {diff.updated > 0 && (
            <span className="ac-text-warning font-medium" title={`${diff.updated} layer${diff.updated === 1 ? '' : 's'} updated`}>
              ~{diff.updated}
            </span>
          )}
          {diff.deleted > 0 && (
            <span className="ac-text-danger font-medium" title={`${diff.deleted} layer${diff.deleted === 1 ? '' : 's'} deleted`}>
              −{diff.deleted}
            </span>
          )}
          {diff.restructured > 0 && (
            <span className="ac-text-3 font-medium" title={`${diff.restructured} layer${diff.restructured === 1 ? '' : 's'} restructured (group/reorder/instance ops)`}>
              ⇄{diff.restructured}
            </span>
          )}
        </span>
        <span className="text-[9px] ac-text-4 truncate flex-1 min-w-0 hidden sm:inline">
          {diff.entries.length} op{diff.entries.length === 1 ? '' : 's'}
        </span>
        <ChevronRight
          className={`h-3 w-3 ac-text-4 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <div className="px-2 pb-1.5 pt-0.5 space-y-0.5 max-h-48 overflow-y-auto ac-hide-scrollbar border-t ac-border-subtle">
          {diff.entries.map((rec: PatchOpRecord, i: number) => {
            const tone =
              rec.op === 'clear' || rec.op === 'remove' || rec.op === 'delete_page'
                ? 'ac-text-danger'
                : rec.op === 'add' || rec.op === 'bulk_add' || rec.op === 'add_subtree' || rec.op === 'duplicate'
                  ? 'ac-text-success'
                  : 'ac-text-3';
            return (
              <div key={i} className="flex items-start gap-1.5 text-[10px] leading-relaxed">
                <code className={`font-mono px-1 rounded ac-surface-2 flex-shrink-0 ${tone}`}>{rec.op}</code>
                <span className="ac-text-3 min-w-0 break-words">{rec.summary}</span>
              </div>
            );
          })}
          {/* Restore action in the expanded view — always available when
              there's a parent snapshot, regardless of approval mode. This
              is the "always-works" path for users in 'destructive' /
              'off' modes (where the prominent banner is hidden). */}
          {parentSnapshot ? (
            <button
              onClick={handleRestore}
              disabled={!canRestore}
              className="mt-1 w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded text-[10px] ac-text-2 ac-surface-2 hover:ac-surface-1 ac-transition ac-focus-ring disabled:opacity-40 disabled:cursor-not-allowed border ac-border-subtle"
              title={`Restore to snapshot ${parentSnapshot.id.slice(0, 8)} — the canvas state before this turn ran`}
            >
              {restoring ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RotateCcw className="h-2.5 w-2.5" />}
              <span>Restore from before this turn</span>
              <span className="ac-text-4">·</span>
              <span className="ac-text-4 truncate">{parentSnapshot.nodeCount} nodes</span>
            </button>
          ) : (
            <div className="mt-1 px-2 py-1 text-[9px] ac-text-4 text-center">
              No before-this-turn snapshot available
              {turn.messageId ? '' : ' (turn not yet synced to server)'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallsCluster({ toolCalls }: { toolCalls: AgentToolCallEntry[] }) {
  const anyPending = toolCalls.some((tc) => tc.success === undefined);
  // `null` = no user override → follow the pending state (expanded while
  // running, collapsed when done). A click pins the opposite.
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? anyPending;
  const failCount = toolCalls.filter((tc) => tc.success === false).length;
  // ChatGPT-style activity label: the most recent tool summary.
  const lastWithSummary = [...toolCalls].reverse().find((tc) => tc.summary);

  return (
    <div className="space-y-1">
      <button
        onClick={() => setOverride(!expanded)}
        aria-expanded={expanded}
        title={expanded ? 'Collapse tool activity' : 'Expand tool activity'}
        className="w-full flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1.5 py-1 rounded-md text-[10px] ac-text-3 hover:ac-surface-1 ac-transition ac-focus-ring"
      >
        <Wrench className="h-3 w-3 ac-text-4 flex-shrink-0" />
        <span className="font-medium ac-text-2 flex-shrink-0">
          Tools <span className="ac-text-4 font-normal">{toolCalls.length}</span>
        </span>
        {failCount > 0 && (
          <span className="ac-text-danger flex-shrink-0" title={`${failCount} failed`}>
            <XCircle className="h-2.5 w-2.5" />
          </span>
        )}
        {anyPending ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin ac-text-4 flex-shrink-0" />
        ) : (
          !expanded && lastWithSummary?.summary && (
            <span className="text-[10px] ac-text-4 truncate flex-1 min-w-0">
              {lastWithSummary.summary}
            </span>
          )
        )}
        <ChevronRight
          className={`h-3 w-3 ac-text-4 ml-auto flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <div className="space-y-1">
          {toolCalls.map((tc) => (
            <ToolCallEntry key={tc.id} tc={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallEntry({ tc }: { tc: AgentToolCallEntry }) {
  const success = tc.success;
  const pending = success === undefined;
  // Color-code by tool category for quick visual scanning.
  const category = toolCategory(tc.name);
  // Card-level disclosure: one line by default; args + full summary expand
  // on click. Pending calls stay open (live feedback while executing).
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? pending;
  // Pretty-print args when the preview is complete JSON (the translator now
  // sends up to 2K chars — most tool args fit; truncated ones fall back to
  // the raw string). Cursor-style tool cards show real, readable arguments.
  const prettyArgs = useMemo(() => {
    if (!tc.argsPreview) return '';
    try {
      return JSON.stringify(JSON.parse(tc.argsPreview), null, 2);
    } catch {
      return tc.argsPreview;
    }
  }, [tc.argsPreview]);
  // Per-call duration (Cursor/Cline show elapsed time per command).
  const durationMs = tc.startedAt !== undefined && tc.endedAt !== undefined ? tc.endedAt - tc.startedAt : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="rounded-md border ac-border-subtle ac-surface-1">
          <button
            onClick={() => setOverride(!expanded)}
            aria-expanded={expanded}
            title={expanded ? 'Collapse details' : 'Show arguments & full summary'}
            className={`w-full flex items-center gap-1.5 text-[11px] font-medium ac-text-1 text-left ac-transition hover:ac-surface-1 ${
              expanded ? 'px-2 pt-1.5 pb-1' : 'px-2 py-1 rounded-md'
            }`}
          >
            <Wrench className="h-3 w-3 ac-text-4 flex-shrink-0" />
            <code className="text-[10px] ac-surface-2 ac-text-2 px-1 py-0.5 rounded font-mono truncate flex-shrink-0">{tc.name}</code>
            {/* Collapsed: the summary rides inline (one line, truncated) —
                the ONLY detail visible without expanding. */}
            {!expanded && tc.summary && (
              <span className="text-[10px] ac-text-4 font-normal truncate flex-1 min-w-0">{tc.summary}</span>
            )}
            {/* Live progress from long-running tools (variant explorer, design
                audit) — replaces the silent-spinner-for-minutes experience: the
                card shows what phase the tool is in, streamed via
                agent:tool_progress. Suppressed while collapsed-with-summary
                (the summary already occupies the line). */}
            {!expanded && !tc.summary && pending && tc.progress && (
              <span
                className="text-[10px] ac-text-3 font-normal truncate flex-1 min-w-0"
                title={tc.progress}
              >
                {tc.progress}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1 flex-shrink-0">
              {durationMs !== null && (
                <span className="text-[9px] ac-text-4 tabular-nums" title="Tool call duration">
                  {formatMs(durationMs)}
                </span>
              )}
              {pending && <Loader2 className="h-3 w-3 animate-spin ac-text-4" />}
              {success === true && <CheckCircle2 className="h-3 w-3 ac-text-success" />}
              {success === false && <XCircle className="h-3 w-3 ac-text-danger" />}
            </span>
            <ChevronRight
              className={`h-2.5 w-2.5 ac-text-4 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
          {expanded && (
            <div className="px-2 pb-1.5">
              {category && (
                <Badge variant="outline" className={`text-[9px] h-3.5 px-1 py-0 font-normal ${category.cls}`}>
                  {category.label}
                </Badge>
              )}
              {prettyArgs && (
                <pre className="mt-1 max-h-48 overflow-y-auto ac-hide-scrollbar text-[11px] ac-text-3 font-mono overflow-x-auto whitespace-pre-wrap break-all rounded ac-surface-1 border ac-border-subtle p-1.5">
                  {prettyArgs}
                </pre>
              )}
              {tc.summary && (
                <div className="mt-1 text-[10px] ac-text-3">{tc.summary}</div>
              )}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      {/* Right-click — kept lean (working actions only; stub entries removed
          to reduce menu noise). */}
      <ContextMenuContent>
        <ContextMenuItem onClick={() => {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(tc.argsPreview ?? '{}').then(() => toast.message('Args copied to clipboard'));
          }
        }}>
          Copy args (as JSON)
        </ContextMenuItem>
        {tc.summary && (
          <ContextMenuItem onClick={() => {
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
              navigator.clipboard.writeText(tc.summary ?? '').then(() => toast.message('Summary copied to clipboard'));
            }
          }}>
            Copy summary
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function toolCategory(name: string): { label: string; cls: string } | null {
  // All category badges use the --ac-status-* token system so they adapt to
  // dark mode automatically. These are conceptual groupings (no domain-specific
  // meaning to the hue) — info for core, warning for layers, success for
  // auto-layout, danger for analysis, etc.
  // Core canvas ops
  if (name.startsWith('pen_create') || name.startsWith('pen_update') || name.startsWith('pen_delete') || name === 'pen_get_metadata' || name === 'pen_list_shapes' || name === 'pen_clear' || name === 'pen_set_background' || name === 'pen_select_nodes' || name === 'pen_select_shape') {
    return { label: 'core', cls: 'ac-status-neutral' };
  }
  // .pen design-system tools: variables, collections, modes
  if (name.startsWith('pen_set_variable') || name.startsWith('pen_apply_theme') || name.startsWith('pen_set_theme') || name.startsWith('pen_list_themes') || name.startsWith('pen_set_explicit') || name.startsWith('pen_list_collections') || name.startsWith('pen_list_variables') || name.startsWith('pen_bind_variable') || name.startsWith('pen_unbind_variable') || name.startsWith('pen_apply_variable')) {
    return { label: 'design-system', cls: 'ac-status-info' };
  }
  // .pen component-instance tools: refs + descendants + slots
  if (name.startsWith('pen_create_ref') || name.startsWith('pen_override_descendant') || name.startsWith('pen_mark_slot') || name.startsWith('pen_export_pen')) {
    return { label: 'component', cls: 'ac-status-success' };
  }
  if (name.includes('duplicate') || name.includes('group') || name.includes('align') || name.includes('organize')) {
    return { label: 'layers', cls: 'ac-status-warning' };
  }
  if (name.includes('auto_layout')) {
    return { label: 'auto-layout', cls: 'ac-status-success' };
  }
  if (name.includes('component')) {
    return { label: 'component', cls: 'ac-status-success' };
  }
  if (name.includes('palette') || name.includes('tokens')) {
    return { label: 'design-system', cls: 'ac-status-info' };
  }
  if (name.startsWith('pen_generate_wireframe') || name.startsWith('pen_generate_user_flow') || name.startsWith('pen_generate_diagram')) {
    return { label: 'generator', cls: 'ac-status-info' };
  }
  if (name.includes('audit') || name.includes('copy')) {
    return { label: 'analysis', cls: 'ac-status-danger' };
  }
  return null;
}

/// Steer input — appears when the agent is busy. Lets the user send a
/// mid-stream correction that the agent will see after its current tool batch.
/// This is a Phase 2 feature powered by the pi-agent SDK's steer() capability.
function SteerInput() {
  const steerAgent = useCanvasStore((s) => s.steerAgent);
  const [steerText, setSteerText] = useState('');

  const submit = () => {
    const text = steerText.trim();
    if (!text) return;
    steerAgent(text);
    setSteerText('');
  };

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 mt-1 rounded-md border border-[var(--ac-accent-border)] bg-[var(--ac-accent-soft)]">
      <svg className="h-3.5 w-3.5 ac-text-info flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 12c0-4.97 4.03-9 9-9s9 4.03 9 9-4.03 9-9 9c-1.42 0-2.76-.33-3.95-.92L3 21l1.12-3.71A8.96 8.96 0 013 12z" />
        <path d="M8 12h8M8 8h5" strokeLinecap="round" />
      </svg>
      <input
        type="text"
        value={steerText}
        onChange={(e) => setSteerText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Steer mid-turn (e.g. 'use blue', 'add more detail')…"
        className="flex-1 text-[11px] bg-transparent ac-text-1 placeholder:ac-text-4 outline-none"
      />
      <button
        onClick={submit}
        disabled={!steerText.trim()}
        className="text-[10px] px-2 py-0.5 rounded text-white disabled:opacity-30 ac-transition flex-shrink-0"
        style={{ backgroundColor: 'var(--ac-accent)' }}
      >
        Steer
      </button>
    </div>
  );
}

/// FollowUps — contextual "what next?" chips after the last completed turn.
/// Suggestions come from the pure engine in src/lib/agent/followups.ts,
/// derived from the turn's tool trajectory + the current canvas state.
function FollowUps({ turn }: { turn: ReturnType<typeof useCanvasStore.getState>['turns'][number] }) {
  const promptAgent = useCanvasStore((s) => s.promptAgent);
  const document = useCanvasStore((s) => s.document);
  const turns = useCanvasStore((s) => s.turns);
  const agentBusy = useCanvasStore((s) => s.agentBusy);

  const suggestions = useMemo(() => {
    // Find the user prompt that triggered this assistant turn.
    const idx = turns.findIndex((t) => t.id === turn.id);
    const userTurn = idx > 0 ? turns[idx - 1] : null;
    return suggestFollowUps({
      tools: turn.toolCalls.map((tc) => ({ name: tc.name, success: tc.success !== false })),
      assistantText: turn.text ?? '',
      userPrompt: userTurn?.text ?? '',
      shapes: document.shapes ?? [],
      hasColorVariables: Object.values(document.variables ?? {}).some(
        (v) => (v as { type?: string })?.type === 'color',
      ),
    });
  }, [turn, turns, document]);

  if (agentBusy) return null;

  return (
    <div className="pt-1 space-y-1">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide ac-text-4 px-0.5">
        <ChevronRight className="h-3 w-3" />
        What next?
      </div>
      <div className="flex flex-col gap-1">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => {
              pushPromptHistory(s);
              promptAgent(s);
            }}
            disabled={agentBusy}
            className="group/fu flex items-center gap-1.5 w-full text-left text-[11px] px-2 py-1.5 rounded-md border ac-border-subtle ac-surface-1 hover:ac-surface-0 hover:ac-border-default ac-text-2 disabled:opacity-50 ac-transition ac-focus-ring"
          >
            <Sparkles className="h-2.5 w-2.5 ac-text-4 group-hover/fu:text-[color:var(--ac-accent)] transition-colors flex-shrink-0" />
            <span className="flex-1 truncate">{s}</span>
            <Send className="h-2.5 w-2.5 opacity-0 group-hover/fu:opacity-100 ac-text-4 transition-opacity flex-shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}

/// Duration formatter for the turn meta footer.
function formatDuration(endMs: number, startMs: number): string {
  const s = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
