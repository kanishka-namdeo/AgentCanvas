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

export function AgentPanel() {
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
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Bot className="h-4 w-4 text-slate-700" />
            {agentBusy && (
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            )}
          </div>
          <span className="text-xs font-medium text-slate-700">Agent</span>
          <Badge variant="outline" className="text-[10px] h-4 px-1 py-0 font-normal">
            Pi SDK · 24 tools
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-rose-400'}`} />
          {connected ? 'connected' : 'offline'}
        </div>
      </div>

      {/* Status strip: tokens + heatmap state */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-100 bg-slate-50/50 text-[10px] text-slate-500">
        <span className="flex items-center gap-1">
          <Palette className="h-3 w-3" />
          {tokens.colors.length} color token{tokens.colors.length === 1 ? '' : 's'}
        </span>
        <span className="text-slate-300">·</span>
        <span className="flex items-center gap-1">
          <Activity className="h-3 w-3" />
          heatmap {heatmapOn ? 'on' : 'off'}
        </span>
      </div>

      {/* Conversation */}
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {turns.length === 0 && (
            <div className="space-y-3">
              <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                <div className="flex items-center gap-1.5 mb-2 font-medium text-slate-700">
                  <Sparkles className="h-3.5 w-3.5" />
                  How does this work?
                </div>
                This is a Figma-like canvas where the primary user is an AI agent.
                The agent (powered by the Pi Agent SDK&apos;s tool-calling API) sees the
                canvas state and manipulates it through 24 tools — covering wireframes,
                user flows, diagrams, design tokens, palettes, heatmaps, copy, and audits.
                You can also draw manually — the agent will see your edits.
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
                      className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border transition-colors ${
                        active
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <Icon className="h-3 w-3" />
                      {g.label}
                    </button>
                  );
                })}
              </div>

              <div className="space-y-1.5">
                {activePrompts.map((p, i) => (
                  <button
                    key={i}
                    onClick={() => promptAgent(p)}
                    disabled={agentBusy}
                    className="block w-full text-left text-xs px-3 py-2 rounded border border-slate-200 hover:bg-slate-50 hover:border-slate-300 text-slate-600 disabled:opacity-50"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn) => (
            <TurnBubble key={turn.id} turn={turn} />
          ))}
          {agentBusy && (
            <div className="flex items-center gap-2 text-xs text-slate-400 px-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              agent is working…
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t border-slate-200 p-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the agent to design something…"
          className="text-xs resize-none min-h-[60px] max-h-[120px] border-slate-200"
          disabled={agentBusy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[10px] text-slate-400">Enter to send · Shift+Enter for newline</span>
          <Button
            size="sm"
            onClick={submit}
            disabled={agentBusy || !input.trim()}
            className="h-7 text-xs"
          >
            <Send className="h-3 w-3 mr-1" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function TurnBubble({ turn }: { turn: ReturnType<typeof useCanvasStore.getState>['turns'][number] }) {
  if (turn.role === 'user') {
    return (
      <div className="flex gap-2">
        <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0">
          <User className="h-3 w-3 text-slate-600" />
        </div>
        <div className="flex-1 text-xs text-slate-700 bg-slate-50 rounded-lg p-2">
          {turn.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center flex-shrink-0">
        <Bot className="h-3 w-3 text-white" />
      </div>
      <div className="flex-1 space-y-2">
        {/* Tool calls */}
        {turn.toolCalls.map((tc) => (
          <ToolCallEntry key={tc.id} tc={tc} />
        ))}
        {/* Text */}
        {turn.text && (
          <div className="text-xs text-slate-700 whitespace-pre-wrap">{turn.text}</div>
        )}
        {turn.streaming && !turn.text && turn.toolCalls.length === 0 && (
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
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
    <div className="rounded border border-slate-200 bg-slate-50/60 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
        <Wrench className="h-3 w-3 text-slate-400" />
        <code className="text-[10px] bg-slate-200/60 px-1 py-0.5 rounded">{tc.name}</code>
        {category && (
          <Badge variant="outline" className={`text-[9px] h-3.5 px-1 py-0 font-normal ${category.cls}`}>
            {category.label}
          </Badge>
        )}
        {pending && <Loader2 className="h-3 w-3 animate-spin text-slate-400 ml-auto" />}
        {success === true && <CheckCircle2 className="h-3 w-3 text-emerald-500 ml-auto" />}
        {success === false && <XCircle className="h-3 w-3 text-rose-500 ml-auto" />}
      </div>
      {tc.argsPreview && (
        <pre className="mt-1 text-[10px] text-slate-500 font-mono overflow-x-auto whitespace-pre-wrap break-all">
          {tc.argsPreview}
        </pre>
      )}
      {tc.summary && (
        <div className="mt-1 text-[10px] text-slate-500">{tc.summary}</div>
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
