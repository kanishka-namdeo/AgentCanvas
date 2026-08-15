'use client';

// Run history panel — docked below the agent chat.
//
// Shows:
//   - Timeline of Runs in the active session (newest first)
//   - Per-run: prompt, status badge, tool-call count, duration
//   - Expandable tool-call list with status + args preview + summary
//   - Snapshot list with restore / bookmark actions
//
// Mirrors patterns from Bolt.new's workbench, Cursor's agent log,
// and Replit's checkpoint timeline (see research notes §4 + §9).

import { useState, useMemo } from 'react';
import { useSessionStore } from '@/lib/sessions';
import { useCanvasStore } from '@/lib/canvas/store';
import type { Run, ToolCallRecord, Snapshot } from '@/lib/sessions';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import {
  ChevronRight, Wrench, Clock, History, Bookmark, BookmarkCheck, RotateCcw, Camera, GitFork,
} from 'lucide-react';
import { StatusBadge } from './StatusBadge';

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

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

export function RunHistoryPanel() {
  const activeSessionId = useCanvasStore((s) => s.activeSessionId);
  const switchSession = useCanvasStore((s) => s.switchSession);
  const document = useCanvasStore((s) => s.document);

  // Subscribe to the session + its runs / snapshots so we re-render on change.
  const session = useSessionStore((s) => (activeSessionId ? s.sessions[activeSessionId] : undefined));
  const runsMap = useSessionStore((s) => s.runs);
  const snapshotsMap = useSessionStore((s) => s.snapshots);

  const runs = useMemo(() => {
    if (!session) return [];
    return session.runIds
      .map((id) => runsMap[id])
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [session, runsMap]);

  const snapshots = useMemo(() => {
    if (!session) return [];
    return session.snapshotIds
      .map((id) => snapshotsMap[id])
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [session, snapshotsMap]);

  const [tab, setTab] = useState<'runs' | 'snapshots'>('runs');

  if (!session) {
    return (
      <div className="flex flex-col h-full bg-white">
        <div className="px-3 py-2 border-b border-slate-200 text-[11px] text-slate-500">
          No active chat
        </div>
      </div>
    );
  }

  const handleRestoreSnapshot = (snap: Snapshot) => {
    const restored = useSessionStore.getState().restoreSnapshot(session.id, snap.id);
    if (restored) {
      useCanvasStore.setState({ document: { ...restored.document, id: session.documentId } });
    }
  };

  const handleForkFromSnapshot = (snap: Snapshot) => {
    // Fork the active session, then immediately restore that snapshot in the fork.
    const forkId = useCanvasStore.getState().forkActiveSession(null);
    if (!forkId) return;
    // The fork inherits the parent's currentSnapshotId; if the user wants to
    // fork from a SPECIFIC snapshot, we restore that snapshot in the new fork.
    const fork = useSessionStore.getState().getSession(forkId);
    if (fork) {
      const restored = useSessionStore.getState().restoreSnapshot(fork.id, snap.id);
      if (restored) {
        useCanvasStore.setState({ document: { ...restored.document, id: fork.documentId } });
      }
    }
  };

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-200">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <History className="h-3.5 w-3.5 text-slate-600" />
            <span className="text-xs font-semibold text-slate-700">History</span>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-slate-400">
            <span>{runs.length} runs</span>
            <span>·</span>
            <span>{snapshots.length} snapshots</span>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex gap-1">
          <button
            onClick={() => setTab('runs')}
            className={`px-2 py-0.5 rounded text-[10px] font-medium ${
              tab === 'runs' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Runs · {runs.length}
          </button>
          <button
            onClick={() => setTab('snapshots')}
            className={`px-2 py-0.5 rounded text-[10px] font-medium ${
              tab === 'snapshots' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Snapshots · {snapshots.length}
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-1.5">
          {tab === 'runs' && (
            <>
              {runs.length === 0 && (
                <div className="text-center text-[11px] text-slate-400 py-6">
                  No runs yet. Send a prompt to start.
                </div>
              )}
              {runs.map((run) => (
                <RunCard key={run.id} run={run} />
              ))}
            </>
          )}
          {tab === 'snapshots' && (
            <>
              {snapshots.length === 0 && (
                <div className="text-center text-[11px] text-slate-400 py-6">
                  No snapshots yet. They're captured at the end of each turn.
                </div>
              )}
              {snapshots.map((snap) => (
                <SnapshotCard
                  key={snap.id}
                  snapshot={snap}
                  isActive={snap.id === session.currentSnapshotId}
                  onRestore={() => handleRestoreSnapshot(snap)}
                  onFork={() => handleForkFromSnapshot(snap)}
                  onBookmark={() => useSessionStore.getState().bookmarkSnapshot(snap.id)}
                />
              ))}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Capture manual snapshot */}
      {tab === 'snapshots' && (
        <div className="px-2 py-1.5 border-t border-slate-200">
          <Button
            size="sm"
            variant="outline"
            className="w-full h-7 text-[11px]"
            onClick={() => {
              useSessionStore.getState().captureSnapshot(session.id, document, {
                source: 'manual',
                label: 'Manual snapshot',
                createdBy: 'user',
              });
            }}
          >
            <Camera className="h-3 w-3 mr-1" />
            Capture current state
          </Button>
        </div>
      )}
    </div>
  );
}

function RunCard({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const toolCallsMap = useSessionStore((s) => s.toolCalls);
  const toolCalls: ToolCallRecord[] = useMemo(() => {
    return run.toolCallIds
      .map((id) => toolCallsMap[id])
      .filter(Boolean)
      .sort((a, b) => a.stepIndex - b.stepIndex);
  }, [run.toolCallIds, toolCallsMap]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          className="w-full text-left rounded border border-slate-200 hover:border-slate-300 bg-white px-2 py-1.5"
        >
          <div className="flex items-start gap-1.5">
            <ChevronRight className={`h-3 w-3 mt-0.5 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-medium text-slate-700 line-clamp-1">{run.prompt}</div>
              <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-slate-400">
                <StatusBadge status={run.status} />
                <span className="flex items-center gap-0.5">
                  <Clock className="h-2.5 w-2.5" />
                  {formatDuration(run.durationMs)}
                </span>
                <span>·</span>
                <span className="flex items-center gap-0.5">
                  <Wrench className="h-2.5 w-2.5" />
                  {toolCalls.length}
                </span>
                <span>·</span>
                <span>{relativeTime(run.createdAt)}</span>
              </div>
            </div>
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pl-4 pr-1 py-1 space-y-0.5">
          {toolCalls.length === 0 && (
            <div className="text-[10px] text-slate-400 italic px-2 py-1">No tool calls in this run.</div>
          )}
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} tc={tc} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCallCard({ tc }: { tc: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded border border-slate-200 bg-slate-50/60 px-2 py-1">
      <button
        className="w-full text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-1.5 text-[10px] font-medium text-slate-700">
          <Wrench className="h-2.5 w-2.5 text-slate-400" />
          <code className="text-[9px] bg-slate-200/60 px-1 py-0.5 rounded">{tc.name}</code>
          <StatusBadge status={tc.status} />
          {tc.durationMs != null && (
            <span className="ml-auto text-[9px] text-slate-400">{formatDuration(tc.durationMs)}</span>
          )}
        </div>
      </button>
      {tc.summary && (
        <div className="mt-1 text-[10px] text-slate-500">{tc.summary}</div>
      )}
      {expanded && tc.argsPreview && (
        <pre className="mt-1 text-[9px] text-slate-500 font-mono overflow-x-auto whitespace-pre-wrap break-all bg-white border border-slate-200 rounded p-1">
          {tc.argsPreview}
        </pre>
      )}
    </div>
  );
}

function SnapshotCard({
  snapshot, isActive, onRestore, onFork, onBookmark,
}: {
  snapshot: Snapshot;
  isActive: boolean;
  onRestore: () => void;
  onFork: () => void;
  onBookmark: () => void;
}) {
  const sourceColor: Record<Snapshot['source'], string> = {
    turn_end: 'text-slate-500 bg-slate-100',
    fork: 'text-violet-700 bg-violet-50',
    restore: 'text-amber-700 bg-amber-50',
    manual: 'text-blue-700 bg-blue-50',
  };
  return (
    <div className={`rounded border px-2 py-1.5 ${
      isActive ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200 bg-white hover:border-slate-300'
    }`}>
      <div className="flex items-center gap-1.5">
        <Camera className="h-3 w-3 text-slate-400" />
        <span className="text-[11px] font-medium text-slate-700 flex-1 truncate">
          {snapshot.label ?? snapshot.id.slice(0, 12)}
        </span>
        {isActive && (
          <span className="text-[9px] text-emerald-700 bg-emerald-100 px-1 py-0 rounded font-medium">
            current
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 mt-1 text-[9px] text-slate-400">
        <span className={`px-1 py-0 rounded font-medium ${sourceColor[snapshot.source]}`}>
          {snapshot.source}
        </span>
        <span>{snapshot.nodeCount} nodes</span>
        <span>·</span>
        <span>{relativeTime(snapshot.createdAt)}</span>
      </div>
      <div className="flex items-center gap-1 mt-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-5 text-[9px] px-1.5"
          onClick={onRestore}
          disabled={isActive}
          title="Restore this snapshot"
        >
          <RotateCcw className="h-2.5 w-2.5 mr-0.5" />
          Restore
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-5 text-[9px] px-1.5"
          onClick={onFork}
          title="Fork from this snapshot"
        >
          <GitFork className="h-2.5 w-2.5 mr-0.5" />
          Fork
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 p-0 ml-auto"
          onClick={onBookmark}
          title={snapshot.bookmarked ? 'Remove bookmark' : 'Bookmark'}
        >
          {snapshot.bookmarked
            ? <BookmarkCheck className="h-3 w-3 text-amber-500" />
            : <Bookmark className="h-3 w-3 text-slate-400" />}
        </Button>
      </div>
    </div>
  );
}
