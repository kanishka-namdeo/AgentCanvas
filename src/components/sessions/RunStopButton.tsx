'use client';

// Global Run / Stop control — lives in the top header.
//
// When the agent is busy: shows a destructive "Stop" button that calls
// `stopAgent()` on the canvas store. After the click (phase 'cancelling')
// it flips to a disabled "Stopping…" chip until the server-side abort
// confirms — the intermediate stop state from the 2026-09-05 consistency
// contract (a Stop button that stays clickable forever is the classic
// stuck-busy failure; ChatGPT's image-gen stop bug is the cautionary tale).
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
import { RUN_PHASE_LABEL } from '@/lib/canvas/run-phase';

export function RunStopButton() {
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const runPhase = useCanvasStore((s) => s.runPhase);
  const stopAgent = useCanvasStore((s) => s.stopAgent);

  if (!agentBusy) return null;

  const stopping = runPhase === 'cancelling';

  return (
    <Button
      size="sm"
      onClick={stopAgent}
      disabled={stopping}
      className="h-7 px-2.5 text-[11px] font-medium text-white border ac-border-default ac-transition ac-focus-ring"
      style={{
        backgroundColor: 'var(--ac-danger)',
        borderColor: 'var(--ac-danger)',
      }}
      title={stopping ? RUN_PHASE_LABEL.cancelling : 'Stop the agent'}
      aria-label={stopping ? RUN_PHASE_LABEL.cancelling : 'Stop the agent'}
    >
      {/* Busy dot — the contract's single compact-row pulse primitive
          (matches StatusDot; the old animate-ping halo was the one
          off-pattern animation in the busy zoo). */}
      <span
        className={`mr-1.5 inline-flex h-2 w-2 rounded-full bg-white ${stopping ? 'opacity-50' : 'animate-pulse'}`}
        aria-hidden="true"
      />
      {stopping ? RUN_PHASE_LABEL.cancelling : 'Stop'}
    </Button>
  );
}
