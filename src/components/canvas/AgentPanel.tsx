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

import { useEffect, useRef, useState } from 'react';
import { useCanvasStore, type AgentToolCallEntry } from '@/lib/canvas/store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Bot, User, Wrench, CheckCircle2, XCircle, Loader2, Send, Sparkles } from 'lucide-react';

const PRESET_PROMPTS = [
  'Create a mobile app login screen with a header, email/password fields, and a sign-in button.',
  'Design a dashboard card showing monthly revenue with a number, a small trend label, and an icon.',
  'Make a simple landing page hero: a large headline, a subheadline, and two CTA buttons.',
  'Draw a 4-step horizontal process flow with arrows between boxes.',
];

export function AgentPanel() {
  const turns = useCanvasStore((s) => s.turns);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const connected = useCanvasStore((s) => s.connected);
  const promptAgent = useCanvasStore((s) => s.promptAgent);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const submit = () => {
    const text = input.trim();
    if (!text || agentBusy || !connected) return;
    promptAgent(text);
    setInput('');
  };

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
            Pi SDK
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-rose-400'}`} />
          {connected ? 'connected' : 'offline'}
        </div>
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
                canvas state and manipulates it through tools like
                <code className="mx-1 px-1 py-0.5 bg-slate-200 rounded text-[10px]">canvas_create_shape</code>
                and
                <code className="mx-1 px-1 py-0.5 bg-slate-200 rounded text-[10px]">canvas_update_shape</code>.
                You can also draw manually — the agent will see your edits.
              </div>
              <div className="text-xs text-slate-500 font-medium">Try asking:</div>
              {PRESET_PROMPTS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => promptAgent(p)}
                  disabled={!connected || agentBusy}
                  className="block w-full text-left text-xs px-3 py-2 rounded border border-slate-200 hover:bg-slate-50 hover:border-slate-300 text-slate-600 disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
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
          disabled={!connected || agentBusy}
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
            disabled={!connected || agentBusy || !input.trim()}
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
  return (
    <div className="rounded border border-slate-200 bg-slate-50/60 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
        <Wrench className="h-3 w-3 text-slate-400" />
        <code className="text-[10px] bg-slate-200/60 px-1 py-0.5 rounded">{tc.name}</code>
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
