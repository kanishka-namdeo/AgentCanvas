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
import { useModelCatalog } from '@/hooks/use-model-catalog';
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
  RotateCcw, TriangleAlert, Copy, Camera, BoxSelect,
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
  // Image attachments (ChatGPT/Claude/Cursor pattern: paperclip + paste +
  // drag-and-drop, staged as preview chips until sent). Downscaled client-side
  // by lib/agent/attachments.ts before they ever leave the browser.
  const [attachments, setAttachments] = useState<AttachedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // "Jump to latest" pill — visible while the user has scrolled away from
  // the bottom (ChatGPT/Claude pattern; auto-follow pauses so they can read).
  const [showJump, setShowJump] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const document = useCanvasStore((s) => s.document);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const newSession = useCanvasStore((s) => s.newSession);
  const select = useCanvasStore((s) => s.select);
  // Canvas selection — drives the "N layers selected" context chip above the
  // input (progressive disclosure: the chip TELLS the user what context the
  // next prompt will carry, and can be cleared in place).
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const selectionCount = selectedIds.length;

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

  /// Stage image files from ANY source (paperclip, paste, drop).
  /// Rejections toast once, compactly.
  const addFiles = async (files: File[]) => {
    if (files.length === 0 || agentBusy) return;
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
    if ((!text && images.length === 0) || agentBusy) return;
    // Selection context: capture the CURRENT canvas selection (names, capped)
    // so "these/those" prompts carry concrete layer targeting. Only when the
    // user has something selected — the chip above the input discloses this.
    const selection =
      selectedIds.length > 0
        ? {
            count: selectedIds.length,
            names: selectedIds
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
    pushPromptHistory(promptText);
    // Submitting re-engages follow-the-bottom (the user acted at the bottom).
    stickToBottomRef.current = true;
    promptAgent(promptText, images.length > 0 ? images : undefined, selection);
    setInput('');
    setAttachments([]);
    setHistoryCursor(-1);
    setCmdIndex(0);
    setCmdDismissed(false);
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
      <div className="relative flex-1 min-h-0">
        <ScrollArea ref={scrollRef} className="h-full ac-hide-scrollbar">
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
                <p className="mt-2 leading-relaxed ac-text-3">
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
          Send appears when there's text OR staged attachments. */}
      <div className="border-t ac-border-subtle p-2 ac-surface-0">
        {/* Selection context chip (progressive disclosure) — only appears
            when layers are selected. Shows WHAT context the next prompt will
            carry; × clears the canvas selection in place. */}
        {selectionCount > 0 && !agentBusy && (
          <div
            className="flex items-center gap-1.5 mb-1.5 px-2 py-1 rounded-md border ac-border-subtle ac-surface-1"
            title={`The agent will target your ${selectionCount} selected layer${selectionCount === 1 ? '' : 's'} ("these"/"those" in your prompt refers to them).`}
          >
            <BoxSelect className="h-3 w-3 flex-shrink-0 ac-text-info" />
            <span className="text-[10px] ac-text-2 truncate flex-1">
              {selectionCount} layer{selectionCount === 1 ? '' : 's'} selected — agent will target them
            </span>
            <button
              onClick={() => select([])}
              aria-label="Clear selection context"
              title="Clear selection (the prompt will apply to the whole canvas)"
              className="p-0.5 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring flex-shrink-0"
            >
              <X className="h-2.5 w-2.5" />
            </button>
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
                  <div className="absolute bottom-0 inset-x-0 px-1 py-px bg-black/70 text-white text-[8px] font-mono truncate">
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
            placeholder="Ask the agent to design something…  (⌘K for prompts · paste images to attach)"
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
          {/* Action row — always visible: paperclip (image attach) on the
              left, Send on the right once there's text OR staged
              attachments. ChatGPT keeps the attach button permanently
              available so images can be staged before typing. */}
          <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5 border-t ac-border-subtle">
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
            <div className="flex items-center gap-0.5">
              {/* Canvas snapshot attach (v0/Figma-Make pattern) — renders the
                  current canvas to a PNG and stages it as an image attachment. */}
              <button
                onClick={() => void attachCanvasSnapshot()}
                disabled={agentBusy || snapshotBusy || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                title="Attach a snapshot of the canvas as an image reference"
                aria-label="Attach canvas snapshot"
                className="p-1 rounded ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {snapshotBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={agentBusy || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                title={`Attach images (${attachments.length}/${MAX_ATTACHMENTS_PER_MESSAGE}) — paste or drop works too`}
                aria-label="Attach images"
                className="p-1 rounded ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Paperclip className="h-3.5 w-3.5" />
              </button>
            </div>
            {(input.trim() || attachments.length > 0) && (
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
            )}
          </div>
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
            <div
              className="flex-1 text-xs ac-text-1 ac-surface-1 rounded-lg rounded-tl-sm p-2"
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
                      <span className="absolute bottom-0 inset-x-0 px-1 py-px bg-black/70 text-white text-[8px] font-mono truncate">
                        {img.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Hover actions (progressive disclosure — icons replace the
                hidden right-click menu as the primary affordance): copy +
                fork. Fade in on hover/focus; always keyboard-reachable. */}
            {turn.text && (
              <button
                onClick={() => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    navigator.clipboard.writeText(turn.text ?? '').then(() => toast.message('Prompt copied to clipboard'));
                  }
                }}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity self-start mt-0.5 p-1 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
                title="Copy prompt"
                aria-label="Copy prompt"
              >
                <Copy className="h-3 w-3" />
              </button>
            )}
            {turn.messageId && (
              <button
                onClick={() => forkActiveSession(turn.messageId)}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity self-start mt-0.5 p-1 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
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
              // Images + selection ride along so vision/targeted prompts re-send intact.
              promptAgent(
                turn.text,
                turn.images && turn.images.length > 0 ? turn.images : undefined,
                turn.selection,
              );
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
        <div className="group flex gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center flex-shrink-0 shadow-sm">
            <Bot className="h-3 w-3 text-white" />
          </div>
          <div className="flex-1 space-y-2">
            {/* Tool calls — collapsed to ONE summary row per completed turn
                (ChatGPT "Used N tools" pattern); expands for the details.
                While any call is pending the cluster stays open so the user
                sees live activity. See ToolCallsCluster below. */}
            {turn.toolCalls.length > 0 && <ToolCallsCluster toolCalls={turn.toolCalls} />}
            {/* Text — rendered as markdown (bold, lists, code blocks) the way
                Claude / ChatGPT / v0 render assistant messages. */}
            {turn.text && (
              <MarkdownMessage text={turn.text} />
            )}
            {/* Hover actions (ChatGPT/Claude pattern): copy + regenerate.
                Fade in on hover/focus — the right-click menu keeps the
                extended actions for power users. */}
            {!turn.streaming && turn.text && (
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity -ml-1">
                <button
                  onClick={() => {
                    if (typeof navigator !== 'undefined' && navigator.clipboard) {
                      navigator.clipboard.writeText(turn.text ?? '').then(() => toast.message('Message copied to clipboard'));
                    }
                  }}
                  className="p-1 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
                  title="Copy message"
                  aria-label="Copy message"
                >
                  <Copy className="h-2.5 w-2.5" />
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
                  className="p-1 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Regenerate response"
                  aria-label="Regenerate response"
                >
                  <RotateCcw className="h-2.5 w-2.5" />
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
            {/* Failed turn — inline Retry affordance. The error text itself
                is already appended to the message by the store reducer; this
                adds the missing one-click recovery (ChatGPT's "Regenerate"
                on error bubbles). Re-sends the preceding user prompt WITH
                its attachments. */}
            {turn.error && !turn.streaming && (
              <div className="flex items-center justify-between gap-2 rounded-md border ac-border-subtle ac-surface-1 px-2 py-1.5">
                <span className="flex items-center gap-1.5 text-[10px] ac-text-danger min-w-0">
                  <TriangleAlert className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate" title={turn.error}>Turn failed</span>
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
}

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
        className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[10px] ac-text-3 hover:ac-surface-1 ac-transition ac-focus-ring"
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
            {pending && <Loader2 className="h-3 w-3 animate-spin ac-text-4 ml-auto flex-shrink-0" />}
            {success === true && <CheckCircle2 className="h-3 w-3 ac-text-success ml-auto flex-shrink-0" />}
            {success === false && <XCircle className="h-3 w-3 ac-text-danger ml-auto flex-shrink-0" />}
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
              {tc.argsPreview && (
                <pre className="mt-1 text-[10px] ac-text-3 font-mono overflow-x-auto whitespace-pre-wrap break-all">
                  {tc.argsPreview}
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
