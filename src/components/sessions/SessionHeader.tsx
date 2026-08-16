'use client';

// Compact header for the active session — title, model, status badge,
// fork button.
//
// Two variants:
//   - default   — full layout (avatar + title + meta + Fork), used inside
//                 the right column when the layout puts the chat panel on
//                 the right (legacy / fallback layout).
//   - compact   — single-row layout that fits inside the 44px top header:
//                 small avatar (with status dot) + inline-editable title +
//                 StatusBadge + Fork button. Drops the model + relative-time
//                 meta to save horizontal space.

import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GitFork, Bot, Clock } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import { useEffect, useState } from 'react';

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function SessionHeader({ compact = false }: { compact?: boolean }) {
  const activeSessionId = useCanvasStore((s) => s.activeSessionId);
  const session = useSessionStore((s) => (activeSessionId ? s.sessions[activeSessionId] : undefined));
  const runsMap = useSessionStore((s) => s.runs);
  const forkActiveSession = useCanvasStore((s) => s.forkActiveSession);

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
    if (compact) {
      return (
        <span className="text-[11px] ac-text-4 italic">No active chat</span>
      );
    }
    return (
      <div className="px-3 py-3 border-b ac-border-subtle text-[11px] ac-text-4 ac-surface-1 text-center">
        No active chat — click <span className="font-medium ac-text-3">New chat</span> to begin.
      </div>
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

  if (compact) {
    return (
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="relative flex-shrink-0">
          <div className="w-5 h-5 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-sm">
            <Bot className="h-3 w-3 text-white" />
          </div>
          {currentRun && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse ring-1 ring-white" />
          )}
        </div>
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
            className="h-6 text-[12px] px-1.5 font-medium ac-border-default max-w-[180px]"
            autoFocus
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="text-[12px] font-medium ac-text-1 truncate hover:ac-surface-1 rounded px-1.5 py-0.5 -mx-1.5 ac-transition ac-focus-ring max-w-[180px]"
            title="Click to rename"
          >
            {session.title}
          </button>
        )}
        <StatusBadge status={status} />
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[10px] ac-text-2 ac-border-default hover:ac-surface-1 ac-transition flex-shrink-0"
          onClick={() => forkActiveSession(null)}
          title="Fork this chat"
        >
          <GitFork className="h-3 w-3 mr-1" />
          Fork
        </Button>
      </div>
    );
  }

  return (
    <div className="px-3 py-2.5 border-b ac-border-subtle ac-surface-0">
      <div className="flex items-start gap-2">
        <div className="relative flex-shrink-0 mt-0.5">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-sm">
            <Bot className="h-3.5 w-3.5 text-white" />
          </div>
          {currentRun && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 animate-pulse ring-2 ring-white" />
          )}
        </div>
        <div className="flex-1 min-w-0">
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
              className="h-6 text-[13px] px-1.5 font-semibold ac-border-default"
              autoFocus
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="block w-full text-left text-[13px] font-semibold ac-text-1 truncate hover:ac-surface-1 rounded px-1.5 py-0.5 -mx-1.5 ac-transition ac-focus-ring"
              title="Click to rename"
            >
              {session.title}
            </button>
          )}
          <div className="flex items-center gap-1.5 mt-1 px-0.5 text-[10px] ac-text-4">
            <StatusBadge status={status} />
            {!session.isRoot && (
              <span className="flex items-center gap-0.5" style={{ color: 'var(--ac-accent)' }}>
                <GitFork className="h-2.5 w-2.5" />
                forked
              </span>
            )}
            {lastRun && (
              <>
                <span className="ac-text-5">·</span>
                <span className="flex items-center gap-0.5">
                  <Clock className="h-2.5 w-2.5" />
                  {relativeTime(lastRun.createdAt)}
                </span>
              </>
            )}
            <span className="ac-text-5">·</span>
            <span className="font-mono ac-text-4">{session.model}</span>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[10px] ac-text-2 ac-border-default hover:ac-surface-1 ac-transition flex-shrink-0 mt-0.5"
          onClick={() => forkActiveSession(null)}
          title="Fork this chat"
        >
          <GitFork className="h-3 w-3 mr-1" />
          Fork
        </Button>
      </div>
    </div>
  );
}
