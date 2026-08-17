'use client';

// Global Run / Stop control — lives in the top header.
//
// When the agent is idle: shows a primary "Ask" button that opens the ⌘K
// Command Palette. This is a real primary action — the palette lets users
// search preset prompts or type a custom one. The previous implementation
// tried to focus the chat input via a window-global hook, which silently
// failed when the right panel wasn't on the Chat tab (AgentPanel unmounted
// → global deleted → click was a no-op).
//
// When the agent is busy: shows a destructive "Stop" button that calls
// `stopAgent()` on the canvas store. The button pulses subtly so the user
// can tell at a glance that work is in progress.
//
// Why this lives in the header, not the chat panel: the agent's run state
// is the single most important global fact about the app. Burying it in the
// bottom-right of the chat input (where the Send button is) makes it easy
// to miss when the user is looking at the canvas.

import { useCanvasStore } from '@/lib/canvas/store';
import { Button } from '@/components/ui/button';
import { Play, Square, Sparkles } from 'lucide-react';

export function RunStopButton({ onAsk }: { onAsk: () => void }) {
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const stopAgent = useCanvasStore((s) => s.stopAgent);

  if (agentBusy) {
    return (
      <Button
        size="sm"
        onClick={stopAgent}
        className="h-7 px-2.5 text-[11px] font-medium text-white border ac-border-default ac-transition ac-focus-ring"
        style={{
          backgroundColor: 'var(--ac-danger)',
          borderColor: 'var(--ac-danger)',
        }}
        title="Stop the agent"
        aria-label="Stop the agent"
      >
        <span className="relative mr-1.5 flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-white opacity-75 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
        </span>
        Stop
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      onClick={onAsk}
      className="h-7 px-2.5 text-[11px] font-medium text-white ac-transition ac-focus-ring"
      style={{
        backgroundColor: 'var(--ac-accent)',
      }}
      title="Open the command palette to send a prompt"
      aria-label="Ask the agent"
    >
      <Sparkles className="h-3 w-3 mr-1" />
      Ask
    </Button>
  );
}
