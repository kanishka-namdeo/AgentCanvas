'use client';

// Global Run / Stop control — lives in the top header.
//
// When the agent is busy: shows a destructive "Stop" button that calls
// `stopAgent()` on the canvas store. The button pulses subtly so the user
// can tell at a glance that work is in progress.
//
// When the agent is idle: renders NOTHING. The ⌘K palette trigger next to it
// is already the single prompt entry point — a second idle "Ask" button
// duplicated the same action side-by-side (UI-audit 2026-08-29: reduce
// visual overwhelm, "one primary CTA per region").
//
// Why the Stop state stays in the header, not the chat panel: the agent's
// run state is the single most important global fact about the app, and it
// must remain visible even when the right panel is collapsed or on the
// Design/History tab.

import { useCanvasStore } from '@/lib/canvas/store';
import { Button } from '@/components/ui/button';

export function RunStopButton(_props: { onAsk?: () => void }) {
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const stopAgent = useCanvasStore((s) => s.stopAgent);

  if (!agentBusy) return null;

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
