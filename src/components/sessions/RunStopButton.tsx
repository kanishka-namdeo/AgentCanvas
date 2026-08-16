'use client';

// Global Run / Stop control — lives in the top header.
//
// When the agent is idle: shows a primary "Run" affordance that focuses the
// agent input. We don't actually submit on click — the user still types a
// prompt in the chat panel. The button is essentially a status indicator
// that doubles as a "click to focus chat" shortcut.
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
import { Play, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function RunStopButton() {
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const stopAgent = useCanvasStore((s) => s.stopAgent);
  const focusAgentInputRef = useRef<(() => void) | null>(null);

  // Register a global focus-agent-input hook on window so any component
  // (including this one) can focus the chat input without prop-drilling.
  // The AgentPanel registers its input on mount.
  useEffect(() => {
    const handler = () => {
      const fn = (window as any).__focusAgentInput;
      if (typeof fn === 'function') fn();
    };
    focusAgentInputRef.current = handler;
  }, []);

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
      >
        <span className="relative mr-1.5 flex h-2 w-2">
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
      onClick={() => focusAgentInputRef.current?.()}
      className="h-7 px-2.5 text-[11px] font-medium text-white ac-transition ac-focus-ring"
      style={{
        backgroundColor: 'var(--ac-accent)',
      }}
      title="Focus the chat input to send a prompt"
    >
      <Play className="h-3 w-3 mr-1" />
      Run
    </Button>
  );
}
