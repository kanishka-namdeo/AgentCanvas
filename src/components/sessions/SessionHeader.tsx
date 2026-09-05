'use client';

// Compact header for the active session — document switcher, chat title,
// exception-only run status, fork button. Fits inside the 44px app header.
//
// UI-audit round 2 (2026-08-30):
//   - The non-compact variant was dead code (~100 lines: relativeTime,
//     per-session token/cost roll-up — a status surface round 1 removed
//     everywhere else). Sole caller is page.tsx's header; deleted.
//   - The decorative bot avatar (a second gradient square 20px from the
//     brand logo) was removed — the busy signal lives on the StatusBadge.
//   - StatusBadge renders EXCEPTION-ONLY now: running / failed / stuck /
//     cancelling states — the always-on green "completed" chip was status
//     noise (round-1 philosophy: quiet-by-default) and never de-appeared.
//   - Fork is icon-only with tooltip + aria-label (completing a round-1
//     plan item that was silently dropped).

import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GitFork } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import { DocumentSwitcher } from './DocumentSwitcher';
import type { RunStatus } from '@/lib/sessions';
import { useEffect, useState } from 'react';
import { BUSY_LOCK_HINT } from '@/lib/canvas/run-phase';

/// Statuses worth a permanent header chip — anything actively in-flight or
/// abnormal. 'completed' (the resting state) renders nothing.
const EXCEPTION_STATUSES: ReadonlySet<RunStatus> = new Set([
  'in_progress', 'awaiting_tool', 'queued', 'cancelling',
  'failed', 'stuck', 'incomplete', 'cancelled',
]);

export function SessionHeader() {
  const activeSessionId = useCanvasStore((s) => s.activeSessionId);
  const session = useSessionStore((s) => (activeSessionId ? s.sessions[activeSessionId] : undefined));
  const runsMap = useSessionStore((s) => s.runs);
  const forkActiveSession = useCanvasStore((s) => s.forkActiveSession);
  const agentBusy = useCanvasStore((s) => s.agentBusy);

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');

  // Sync local title state when the active session changes. setState-in-
  // effect is intentional: `title` is a controlled-input buffer that must
  // reset whenever the user switches sessions or renames externally.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (session) setTitle(session.title);
  }, [session?.id, session?.title]);

  if (!session) {
    return (
      <span className="text-[11px] ac-text-4 italic">No active chat</span>
    );
  }

  const currentRun = session.currentRunId ? runsMap[session.currentRunId] : null;
  const lastRun = session.lastRunId ? runsMap[session.lastRunId] : null;
  const status = currentRun?.status ?? (lastRun?.status ?? 'completed');

  const commitTitle = () => {
    const t = title.trim();
    if (t && t !== session.title) {
      useSessionStore.getState().renameSession(session.id, t);
    } else {
      setTitle(session.title);
    }
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-2 min-w-0 flex-1">
      {/* Document switcher — create/switch/rename documents from the top bar. */}
      <DocumentSwitcher />
      {editing ? (
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitTitle();
            if (e.key === 'Escape') {
              setTitle(session.title);
              setEditing(false);
            }
          }}
          className="h-6 text-[12px] px-1.5 font-medium ac-border-default max-w-[140px] sm:max-w-[200px] md:max-w-[280px]"
          autoFocus
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="text-[12px] font-medium ac-text-1 truncate hover:ac-surface-1 rounded px-1.5 py-0.5 -mx-1.5 ac-transition ac-focus-ring max-w-[140px] sm:max-w-[200px] md:max-w-[280px]"
          title="Click to rename this chat"
        >
          {session.title}
        </button>
      )}
      {EXCEPTION_STATUSES.has(status as RunStatus) && <StatusBadge status={status} />}
      <Button
        size="sm"
        variant="outline"
        className="h-6 w-6 p-0 ac-text-2 ac-border-default hover:ac-surface-1 ac-transition ac-busy flex-shrink-0"
        onClick={() => forkActiveSession(null)}
        disabled={agentBusy}
        title={agentBusy ? `Fork this chat — ${BUSY_LOCK_HINT}` : 'Fork this chat'}
        aria-label="Fork this chat"
      >
        <GitFork className="h-3 w-3" />
      </Button>
    </div>
  );
}
