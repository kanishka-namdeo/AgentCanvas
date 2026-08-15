'use client';

// Compact header for the active session — title, model, status badge,
// fork button. Sits at the top of the agent chat panel.

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

export function SessionHeader() {
  const activeSessionId = useCanvasStore((s) => s.activeSessionId);
  const session = useSessionStore((s) => (activeSessionId ? s.sessions[activeSessionId] : undefined));
  const runsMap = useSessionStore((s) => s.runs);
  const forkActiveSession = useCanvasStore((s) => s.forkActiveSession);

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (session) setTitle(session.title);
  }, [session?.id, session?.title]);

  if (!session) {
    return (
      <div className="px-3 py-2 border-b border-slate-200 text-[11px] text-slate-400">
        No active chat — create one to begin.
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

  return (
    <div className="px-3 py-2 border-b border-slate-200 bg-white">
      <div className="flex items-center gap-2">
        <div className="relative flex-shrink-0">
          <Bot className="h-4 w-4 text-slate-700" />
          {currentRun && (
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
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
              className="h-6 text-xs px-1.5"
              autoFocus
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="block w-full text-left text-xs font-semibold text-slate-800 truncate hover:bg-slate-50 rounded px-1 py-0.5 -mx-1"
              title="Click to rename"
            >
              {session.title}
            </button>
          )}
          <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-slate-400">
            <StatusBadge status={status} />
            {!session.isRoot && (
              <span className="flex items-center gap-0.5 text-violet-600">
                <GitFork className="h-2.5 w-2.5" />
                forked
              </span>
            )}
            {lastRun && (
              <>
                <span>·</span>
                <span className="flex items-center gap-0.5">
                  <Clock className="h-2.5 w-2.5" />
                  {relativeTime(lastRun.createdAt)}
                </span>
              </>
            )}
            <span>·</span>
            <span>{session.model}</span>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px] text-slate-500"
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
