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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useCanvasStore, type AgentToolCallEntry } from '@/lib/canvas/store';
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
  matchCommands, resolveCommand, parseCommandInput, COMMAND_MENU_LIMIT,
  type ChatCommand,
} from '@/lib/agent/chat-commands';
import { pushPromptHistory, navigateHistory } from '@/lib/agent/prompt-history';
import { exportSvg, exportPngDataUrl, exportJson, downloadFile, downloadDataUrl } from '@/lib/canvas/export';
import {
  Bot, User, Wrench, CheckCircle2, XCircle, Loader2, Send, Sparkles,
  Smartphone, LayoutDashboard, GitBranch, Palette, Activity, Layers, Square,
  ChevronRight, Clock, CornerDownLeft, Cpu,
} from 'lucide-react';

/// Format a token count for compact display: 45200 → "45.2K".
/// Inlined (rather than imported from lib/agent/context-manager) because that
/// module pulls in the server-only pi-coding-agent SDK and this is a client
/// component — see the module-not-found failure in dev.log.
function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
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
    `Context window: ${contextWindow.toLocaleString()} tokens`,
    activeModel ? `Max output: ${activeModel.maxTokens.toLocaleString()} tokens` : null,
    '',
    `Context usage: ${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${pct}%)${lastCompacted ? ' — compacted' : ''}`,
    usageTotals.llmCalls > 0
      ? `Session totals: ${usageTotals.llmCalls} LLM calls · in ${usageTotals.inputTokens.toLocaleString()} · out ${usageTotals.outputTokens.toLocaleString()} · cache read ${usageTotals.cacheReadTokens.toLocaleString()} · cache write ${usageTotals.cacheWriteTokens.toLocaleString()}`
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
          session (input + output), shown once any usage was reported. */}
      {usageTotals.llmCalls > 0 && (
        <span
          className="hidden lg:flex items-center gap-0.5"
          title={`Session usage: ${usageTotals.llmCalls} LLM calls, ${usageTotals.inputTokens + usageTotals.outputTokens} tokens total${usageTotals.cost > 0 ? `, $${usageTotals.cost.toFixed(4)}` : ''}`}
        >
          <Clock className="h-2.5 w-2.5" />
          {formatTokens(usageTotals.inputTokens + usageTotals.outputTokens)} tok
        </span>
      )}
    </>
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const document = useCanvasStore((s) => s.document);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const newSession = useCanvasStore((s) => s.newSession);
  const select = useCanvasStore((s) => s.select);

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
    // Guard: the textarea is disabled while the agent runs, but a menu click
    // can still land mid-turn — refuse instead of mutating under the agent.
    if (agentBusy) {
      toast.error('Agent is busy', { description: 'Wait for the current turn to finish.' });
      return;
    }
    if (cmd.kind === 'prompt') {
      const prompt = args ? `${cmd.run} ${args}` : cmd.run;
      pushPromptHistory(prompt);
      promptAgent(prompt);
      return;
    }
    const docName = (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-');
    switch (cmd.run) {
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
        if (id) toast.success('Started a new chat');
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
        void exportPngDataUrl(document.shapes).then((dataUrl) => {
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
        stickToBottomRef.current = distance < 48;
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

  const submit = () => {
    const text = input.trim();
    if (!text || agentBusy) return;
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
    pushPromptHistory(text);
    // Submitting re-engages follow-the-bottom (the user acted at the bottom).
    stickToBottomRef.current = true;
    promptAgent(text);
    setInput('');
    setHistoryCursor(-1);
    setCmdIndex(0);
    setCmdDismissed(false);
  };

  const activePrompts = PROMPT_GROUPS.find((g) => g.id === activeGroup)?.prompts ?? [];

  return (
    <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
      {/* Header (optional — hidden when used inside a panel that already has SessionHeader) */}
      {!hideHeader && (
      <div className="flex items-center justify-between px-3 py-2 border-b ac-border-subtle">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Bot className="h-4 w-4 ac-text-2" />
            {agentBusy && (
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full ac-dot-success animate-pulse" />
            )}
          </div>
          <span className="text-xs font-medium ac-text-2">Agent</span>
          <Badge variant="outline" className="text-[10px] h-4 px-1 py-0 font-normal ac-text-3 ac-border-default">
            .pen · 60+ tools
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-[10px] ac-text-3">
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
            className={`flex items-center gap-0.5 px-1 py-0.5 rounded ac-transition hover:ac-surface-1 ${thinkingLevel !== 'off' ? 'ac-text-info' : 'ac-text-4'}`}
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <span className="text-[9px]">{thinkingLevel}</span>
          </button>
          {/* Connection status */}
          <span className={`flex items-center gap-0.5 ${connected ? '' : 'ac-text-danger'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'ac-dot-success' : 'ac-dot-danger'}`} />
            {connected ? 'live' : 'offline'}
          </span>
        </div>
      </div>
      )}

      {/* Plugin UI (todo overlay, background tasks, ask-user-question dialog) */}
      <PluginUI />

      {/* Conversation */}
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0 ac-hide-scrollbar">
        <div className="p-3 space-y-3">
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
          {agentBusy && (
            <div className="flex items-center justify-between gap-2 text-xs ac-text-4 px-1 py-1">
              <div className="flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                agent is working…
              </div>
              {/* P0-09: Inline Stop button — lets the user stop without moving
                  the cursor to the top header. Mirrors the header's
                  RunStopButton but appears next to the streaming response. */}
              <Button
                variant="destructive"
                size="sm"
                onClick={() => stopAgent()}
                title="Stop the agent (Esc also works)"
                aria-label="Stop agent"
                className="h-6 text-[10px] px-2 py-0 gap-1"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
                Stop
              </Button>
            </div>
          )}
          {agentBusy && <SteerInput />}
        </div>
      </ScrollArea>

      {/* Input — minimal chrome. Send button only appears when there's input. */}
      <div className="border-t ac-border-subtle p-2 ac-surface-0">
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
        <div className="rounded-lg border ac-border-default ac-surface-0 focus-within:ac-border-strong ac-transition shadow-sm">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Reopen the command menu if the user edits back to a command.
              if (cmdDismissed && !e.target.value.trim().startsWith('/')) setCmdDismissed(false);
              // Editing text manually exits history-navigation mode.
              if (historyCursor !== -1) setHistoryCursor(-1);
            }}
            placeholder="Ask the agent to design something…  (⌘K for prompts)"
            className="text-xs resize-none min-h-[44px] max-h-[120px] border-0 shadow-none focus-visible:ring-0 ac-text-2 placeholder:ac-text-4 bg-transparent"
            disabled={agentBusy}
            onKeyDown={(e) => {
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
          {/* Action row — only rendered when there's input to send. The
              placeholder hint inside the textarea already teaches ⌘K behavior,
              so we don't need a separate "Enter to send" caption. */}
          {input.trim() && (
            <div className="flex items-center justify-end px-2 pb-1.5 pt-0.5 border-t ac-border-subtle">
              <Button
                size="sm"
                onClick={submit}
                disabled={agentBusy}
                className="h-6 text-[11px] text-white disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: 'var(--ac-accent)' }}
              >
                <Send className="h-3 w-3 mr-1" />
                Send
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TurnBubble({ turn }: { turn: ReturnType<typeof useCanvasStore.getState>['turns'][number] }) {
  const forkActiveSession = useCanvasStore((s) => s.forkActiveSession);
  const promptAgent = useCanvasStore((s) => s.promptAgent);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  if (turn.role === 'user') {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group flex gap-2">
            <div className="w-6 h-6 rounded-full ac-surface-2 flex items-center justify-center flex-shrink-0">
              <User className="h-3 w-3 ac-text-3" />
            </div>
            <div className="flex-1 text-xs ac-text-1 ac-surface-1 rounded-lg rounded-tl-sm p-2">
              {turn.text}
            </div>
            {turn.messageId && (
              <button
                onClick={() => forkActiveSession(turn.messageId)}
                className="opacity-0 group-hover:opacity-100 transition-opacity self-start mt-0.5 p-1 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
                title="Fork chat from this message"
              >
                <GitBranch className="h-3 w-3" />
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
            onClick={() => {
              if (!turn.text || agentBusy) return;
              // Re-send the same prompt — the agent will generate a fresh response.
              promptAgent(turn.text);
              toast.message('Regenerating…');
            }}
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
        <div className="flex gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center flex-shrink-0 shadow-sm">
            <Bot className="h-3 w-3 text-white" />
          </div>
          <div className="flex-1 space-y-2">
            {/* Tool calls */}
            {turn.toolCalls.map((tc) => (
              <ToolCallEntry key={tc.id} tc={tc} />
            ))}
            {/* Text — rendered as markdown (bold, lists, code blocks) the way
                Claude / ChatGPT / v0 render assistant messages. */}
            {turn.text && (
              <MarkdownMessage text={turn.text} />
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
              <div className="flex items-center gap-2 text-[9px] ac-text-4">
                {turn.toolCalls.length > 0 && (
                  <span className="flex items-center gap-0.5" title={`${turn.toolCalls.length} tool calls`}>
                    <Wrench className="h-2.5 w-2.5" />
                    {turn.toolCalls.length} tools
                  </span>
                )}
                {turn.startedAt && (
                  <span className="flex items-center gap-0.5" title="Turn duration">
                    <Clock className="h-2.5 w-2.5" />
                    {formatDuration(turn.endedAt ?? Date.now(), turn.startedAt)}
                  </span>
                )}
                {turn.tokenUsage && (turn.tokenUsage.input > 0 || turn.tokenUsage.output > 0) && (
                  <span
                    className="flex items-center gap-0.5"
                    title={`Turn token usage: ${turn.tokenUsage.input.toLocaleString()} input + ${turn.tokenUsage.output.toLocaleString()} output (all LLM calls in this turn)`}
                  >
                    <Cpu className="h-2.5 w-2.5" />
                    {formatTokens(turn.tokenUsage.input + turn.tokenUsage.output)} tok
                  </span>
                )}
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
              promptAgent(userTurn.text);
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
}

function ToolCallEntry({ tc }: { tc: AgentToolCallEntry }) {
  const success = tc.success;
  const pending = success === undefined;
  // Color-code by tool category for quick visual scanning.
  const category = toolCategory(tc.name);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="rounded-md border ac-border-subtle ac-surface-1 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium ac-text-1">
            <Wrench className="h-3 w-3 ac-text-4" />
            <code className="text-[10px] ac-surface-2 ac-text-2 px-1 py-0.5 rounded font-mono">{tc.name}</code>
            {category && (
              <Badge variant="outline" className={`text-[9px] h-3.5 px-1 py-0 font-normal ${category.cls}`}>
                {category.label}
              </Badge>
            )}
            {pending && <Loader2 className="h-3 w-3 animate-spin ac-text-4 ml-auto" />}
            {success === true && <CheckCircle2 className="h-3 w-3 ac-text-success ml-auto" />}
            {success === false && <XCircle className="h-3 w-3 ac-text-danger ml-auto" />}
          </div>
          {tc.argsPreview && (
            <pre className="mt-1 text-[10px] ac-text-3 font-mono overflow-x-auto whitespace-pre-wrap break-all">
              {tc.argsPreview}
            </pre>
          )}
          {tc.summary && (
            <div className="mt-1 text-[10px] ac-text-3">{tc.summary}</div>
          )}
        </div>
      </ContextMenuTrigger>
      {/* P1-29: Tool-call card right-click — Copy args, Replay tool call,
          Pin to top, View raw output, Convert to user prompt. */}
      <ContextMenuContent>
        <ContextMenuItem onClick={() => {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(tc.argsPreview ?? '{}').then(() => toast.message('Args copied to clipboard'));
          }
        }}>
          Copy args (as JSON)
        </ContextMenuItem>
        <ContextMenuItem onClick={() => toast.message('Replay tool call — not yet implemented (P2-33)')}>
          Replay tool call
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => toast.message('View raw output — not yet implemented')}>
          View raw output
        </ContextMenuItem>
        <ContextMenuItem onClick={() => toast.message('Convert to user prompt — not yet implemented')}>
          Convert to user prompt
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => toast.message('Inspect tool spec — not yet implemented')}>
          Inspect tool spec
        </ContextMenuItem>
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
  if (name.startsWith('pen_create') || name.startsWith('pen_update') || name.startsWith('pen_delete') || name === 'pen_list_shapes' || name === 'pen_clear' || name === 'pen_set_background' || name === 'pen_select_shape') {
    return { label: 'core', cls: 'ac-status-neutral' };
  }
  // .pen design-system tools: variables, themes
  if (name.startsWith('pen_set_variable') || name.startsWith('pen_apply_theme') || name.startsWith('pen_set_theme') || name.startsWith('pen_list_themes')) {
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
      <div className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wide ac-text-4 px-0.5">
        <ChevronRight className="h-2.5 w-2.5" />
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
