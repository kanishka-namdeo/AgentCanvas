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
//   - Design systems (palettes, tokens, audit)
//   - Analysis (heatmap, copy, audit)
// Each prompt is a one-click example that exercises a specific tool.

import { useEffect, useRef, useState } from 'react';
import { useCanvasStore, type AgentToolCallEntry } from '@/lib/canvas/store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  Bot, User, Wrench, CheckCircle2, XCircle, Loader2, Send, Sparkles,
  Smartphone, LayoutDashboard, GitBranch, Palette, Activity, Layers,
} from 'lucide-react';
import type { DesignTokens } from '@/lib/canvas/types';

// Stable empty tokens object — avoids creating a new reference on every
// selector call (which would cause an infinite re-render loop in Zustand).
const EMPTY_TOKENS: DesignTokens = { colors: [], textStyles: [] };

interface PromptGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  prompts: string[];
}

const PROMPT_GROUPS: PromptGroup[] = [
  {
    id: 'wireframes',
    label: 'Wireframes',
    icon: Smartphone,
    prompts: [
      'Design a mobile login screen with logo, email/password fields, and sign-in button.',
      'Build a mobile dashboard with stat cards, a chart placeholder, and a tab bar.',
      'Make a web landing page hero with headline, subheadline, and two CTAs.',
      'Design a web pricing page with three tiers, the middle one featured.',
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
      'Predict the attention heatmap for the first frame on the canvas.',
      'Fill every text shape with realistic placeholder copy about "project management".',
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

export function AgentPanel({ hideHeader = false }: { hideHeader?: boolean }) {
  const turns = useCanvasStore((s) => s.turns);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const connected = useCanvasStore((s) => s.connected);
  const promptAgent = useCanvasStore((s) => s.promptAgent);
  const tokens = useCanvasStore((s) => s.document.tokens ?? EMPTY_TOKENS);
  const heatmapOn = useCanvasStore((s) => !!s.document.heatmap);
  const [input, setInput] = useState('');
  const [activeGroup, setActiveGroup] = useState<string>('wireframes');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const submit = () => {
    const text = input.trim();
    if (!text || agentBusy) return;
    promptAgent(text);
    setInput('');
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
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            )}
          </div>
          <span className="text-xs font-medium ac-text-2">Agent</span>
          <Badge variant="outline" className="text-[10px] h-4 px-1 py-0 font-normal ac-text-3 ac-border-default">
            Pi SDK · 24 tools
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] ac-text-3">
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-rose-400'}`} />
          {connected ? 'connected' : 'offline'}
        </div>
      </div>
      )}

      {/* Status strip: tokens + heatmap state — tighter, more polished */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b ac-border-subtle ac-surface-1 text-[10px] ac-text-3">
        <span className="flex items-center gap-1">
          <Palette className="h-3 w-3 ac-text-4" />
          {tokens.colors.length} color token{tokens.colors.length === 1 ? '' : 's'}
        </span>
        <span className="ac-text-5">·</span>
        <span className="flex items-center gap-1">
          <Activity className="h-3 w-3 ac-text-4" />
          heatmap {heatmapOn ? 'on' : 'off'}
        </span>
      </div>

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
                  canvas state and manipulates it through 24 tools — covering wireframes,
                  user flows, diagrams, design tokens, palettes, heatmaps, copy, and audits.
                  You can also draw manually — the agent will see your edits.
                </p>
              </div>

              {/* Scenario prompt groups */}
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
          {agentBusy && (
            <div className="flex items-center gap-2 text-xs ac-text-4 px-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              agent is working…
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input — grouped with Send button (visual unity) */}
      <div className="border-t ac-border-subtle p-2 ac-surface-0">
        <div className="rounded-lg border ac-border-default ac-surface-0 focus-within:ac-border-strong ac-transition shadow-sm">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the agent to design something…"
            className="text-xs resize-none min-h-[44px] max-h-[120px] border-0 shadow-none focus-visible:ring-0 ac-text-2 placeholder:ac-text-4 bg-transparent"
            disabled={agentBusy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5 border-t ac-border-subtle">
            <span className="text-[10px] ac-text-4">Enter to send · Shift+Enter for newline</span>
            <Button
              size="sm"
              onClick={submit}
              disabled={agentBusy || !input.trim()}
              className="h-6 text-[11px] text-white disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--ac-accent)' }}
            >
              <Send className="h-3 w-3 mr-1" />
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TurnBubble({ turn }: { turn: ReturnType<typeof useCanvasStore.getState>['turns'][number] }) {
  const forkActiveSession = useCanvasStore((s) => s.forkActiveSession);
  if (turn.role === 'user') {
    return (
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
    );
  }

  return (
    <div className="flex gap-2">
      <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center flex-shrink-0 shadow-sm">
        <Bot className="h-3 w-3 text-white" />
      </div>
      <div className="flex-1 space-y-2">
        {/* Tool calls */}
        {turn.toolCalls.map((tc) => (
          <ToolCallEntry key={tc.id} tc={tc} />
        ))}
        {/* Text */}
        {turn.text && (
          <div className="text-xs ac-text-1 whitespace-pre-wrap leading-relaxed">{turn.text}</div>
        )}
        {turn.streaming && !turn.text && turn.toolCalls.length === 0 && (
          <div className="flex items-center gap-1.5 text-xs ac-text-4">
            <Loader2 className="h-3 w-3 animate-spin" />
            thinking…
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallEntry({ tc }: { tc: AgentToolCallEntry }) {
  const success = tc.success;
  const pending = success === undefined;
  // Color-code by tool category for quick visual scanning.
  const category = toolCategory(tc.name);
  return (
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
        {success === true && <CheckCircle2 className="h-3 w-3 text-emerald-500 ml-auto" />}
        {success === false && <XCircle className="h-3 w-3 text-rose-500 ml-auto" />}
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
  );
}

function toolCategory(name: string): { label: string; cls: string } | null {
  if (name.startsWith('canvas_create') || name.startsWith('canvas_update') || name.startsWith('canvas_delete') || name === 'canvas_list_shapes' || name === 'canvas_clear' || name === 'canvas_set_background' || name === 'canvas_select_shape') {
    return { label: 'core', cls: 'text-slate-500 border-slate-300' };
  }
  if (name.includes('duplicate') || name.includes('group') || name.includes('align') || name.includes('organize')) {
    return { label: 'layers', cls: 'text-amber-700 border-amber-200' };
  }
  if (name.includes('auto_layout')) {
    return { label: 'auto-layout', cls: 'text-emerald-700 border-emerald-200' };
  }
  if (name.includes('component')) {
    return { label: 'component', cls: 'text-sky-700 border-sky-200' };
  }
  if (name.includes('palette') || name.includes('tokens')) {
    return { label: 'design-system', cls: 'text-fuchsia-700 border-fuchsia-200' };
  }
  if (name.startsWith('canvas_generate_wireframe') || name.startsWith('canvas_generate_user_flow') || name.startsWith('canvas_generate_diagram')) {
    return { label: 'generator', cls: 'text-violet-700 border-violet-200' };
  }
  if (name.includes('heatmap') || name.includes('audit') || name.includes('copy')) {
    return { label: 'analysis', cls: 'text-rose-700 border-rose-200' };
  }
  return null;
}
