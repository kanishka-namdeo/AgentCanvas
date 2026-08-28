'use client';

// Run history panel — docked below the agent chat.
//
// Shows:
//   - Timeline of Runs in the ACTIVE CHAT (newest first)
//   - Per-run: prompt, status badge, tool-call count, duration, per-run
//     cost badge (input/output tokens + USD — accumulated from
//     agent:context_update events).
//   - Expandable tool-call list with status + args preview + summary
//   - Snapshot list for the SHARED CANVAS (document-scoped timeline with
//     per-chat provenance — every chat on this canvas contributes entries)
//     with restore / bookmark / delete actions
//
// Replaced stubs (P3-5 / P3-6):
//   - "Restore run" → "Re-run from here": forks the session at this run's
//     user prompt and auto-sends the same prompt so the new chat diverges
//     from the same starting point. (v0 / Cursor consensus: re-running
//     creates a sibling conversation, not an in-place retry that destroys
//     the original transcript.)
//   - "Export run as Markdown" (P2-37): exports a single-run transcript
//     via GET /api/sessions/[id] + renderRunMarkdown.
//
// Mirrors patterns from Bolt.new's workbench, Cursor's agent log,
// and Replit's checkpoint timeline (see research notes §4 + §9).

import { useState, useMemo, useCallback } from 'react';
import { useSessionStore } from '@/lib/sessions';
import { useCanvasStore } from '@/lib/canvas/store';
import type { Run, ToolCallRecord, Snapshot } from '@/lib/sessions';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { toast } from 'sonner';
import {
  ChevronRight, Wrench, Clock, History, Bookmark, BookmarkCheck, RotateCcw, Camera, MessageSquare, PlayCircle, FileText, Trash2,
} from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import { exportRunMarkdown } from '@/lib/sessions/server-sync';

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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

export function RunHistoryPanel({ hideHeader = false }: { hideHeader?: boolean } = {}) {
  const activeSessionId = useCanvasStore((s) => s.activeSessionId);
  const documentId = useCanvasStore((s) => s.documentId);
  const document = useCanvasStore((s) => s.document);

  // Subscribe to the session + its runs / the document's snapshots so we
  // re-render on change. Snapshots are DOCUMENT-scoped (shared canvas).
  const session = useSessionStore((s) => (activeSessionId ? s.sessions[activeSessionId] : undefined));
  const runsMap = useSessionStore((s) => s.runs);
  const snapshotsMap = useSessionStore((s) => s.snapshots);
  const sessionsMap = useSessionStore((s) => s.sessions);

  const runs = useMemo(() => {
    if (!session) return [];
    return session.runIds
      .map((id) => runsMap[id])
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [session, runsMap]);

  const snapshots = useMemo(() => {
    // Shared-canvas model: the snapshot timeline belongs to the DOCUMENT —
    // entries from every chat on this canvas, newest first.
    return Object.values(snapshotsMap)
      .filter((snap) => snap.documentId === documentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [snapshotsMap, documentId]);

  /// Provenance lookup: which chat produced a snapshot (informational — the
  /// session may since have been deleted).
  const snapshotSource = (snap: Snapshot): string => {
    if (!snap.sessionId) return 'system';
    return sessionsMap[snap.sessionId]?.title ?? 'deleted chat';
  };

  const [tab, setTab] = useState<'runs' | 'snapshots'>('runs');

  if (!session) {
    return (
      <div className="flex flex-col h-full ac-surface-0">
        <div className="px-3 py-2.5 border-b ac-border-subtle text-[11px] ac-text-4 ac-surface-1 text-center">
          No active chat
        </div>
      </div>
    );
  }

  const handleRestoreSnapshot = (snap: Snapshot) => {
    // Canvas-store action: appends a 'restore' snapshot (append-only), swaps
    // the shared document, and broadcasts document:restore so every viewer
    // follows. Remote (metadata-only) entries are fetched from the server.
    useCanvasStore.getState().restoreSnapshot(snap.id)
      .then(() => {
        toast.success(`Restored canvas from ${relativeTime(snap.createdAt)}`, {
          description: `${snap.nodeCount} nodes · shared across all chats`,
        });
      })
      .catch(() => {
        toast.error('Restore failed', { description: 'Could not fetch the snapshot from the server.' });
      });
  };

  const handleDeleteSnapshot = (snap: Snapshot) => {
    if (snap.bookmarked) {
      toast.message('Snapshot is bookmarked', { description: 'Unbookmark it before deleting.' });
      return;
    }
    useSessionStore.getState().deleteSnapshot(snap.id);
    toast.success('Snapshot deleted');
  };

  return (
    <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
      {/* Header — full or compact (when hosted inside the right tabbed panel) */}
      {!hideHeader && (
        <div className="px-3 pt-2.5 pb-2 border-b ac-border-subtle">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <History className="h-3.5 w-3.5 ac-text-3" />
              <span className="text-[11px] font-semibold uppercase tracking-wide ac-text-2">History</span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] ac-text-4">
              <span>{runs.length} runs</span>
              <span className="ac-text-5">·</span>
              <span>{snapshots.length} snapshots</span>
            </div>
          </div>
          {/* Unified tabs — selected = filled dark, unselected = subtle ghost */}
          <div className="flex gap-1 p-0.5 ac-surface-2 rounded-md">
            <button
              onClick={() => setTab('runs')}
              className={`flex-1 px-2 py-1 rounded text-[10px] font-medium ac-transition ${
                tab === 'runs' ? 'ac-surface-0 ac-text-1 shadow-sm' : 'ac-text-3 hover:ac-text-1'
              }`}
            >
              Runs · {runs.length}
            </button>
            <button
              onClick={() => setTab('snapshots')}
              className={`flex-1 px-2 py-1 rounded text-[10px] font-medium ac-transition ${
                tab === 'snapshots' ? 'ac-surface-0 ac-text-1 shadow-sm' : 'ac-text-3 hover:ac-text-1'
              }`}
            >
              Snapshots · {snapshots.length}
            </button>
          </div>
        </div>
      )}
      {hideHeader && (
        <div className="flex items-center gap-1 p-1.5 border-b ac-border-subtle ac-surface-1">
          <button
            onClick={() => setTab('runs')}
            className={`flex-1 px-2 py-1 rounded text-[10px] font-medium ac-transition ${
              tab === 'runs' ? 'ac-surface-0 ac-text-1 shadow-sm' : 'ac-text-3 hover:ac-text-1'
            }`}
          >
            Runs · {runs.length}
          </button>
          <button
            onClick={() => setTab('snapshots')}
            className={`flex-1 px-2 py-1 rounded text-[10px] font-medium ac-transition ${
              tab === 'snapshots' ? 'ac-surface-0 ac-text-1 shadow-sm' : 'ac-text-3 hover:ac-text-1'
            }`}
          >
            Snapshots · {snapshots.length}
          </button>
        </div>
      )}

      <ScrollArea className="flex-1 min-h-0 ac-hide-scrollbar">
        <div className="p-2 space-y-1.5">
          {tab === 'runs' && (
            <>
              {runs.length === 0 && (
                <div className="text-center text-[11px] ac-text-4 py-8 px-3">
                  <p className="font-medium ac-text-3 mb-1">No runs yet</p>
                  <p>Send a prompt to start.</p>
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
                <div className="text-center text-[11px] ac-text-4 py-8 px-3">
                  <p className="font-medium ac-text-3 mb-1">No snapshots yet</p>
                  <p>They’re captured at the end of each turn — shared by every chat on this canvas.</p>
                </div>
              )}
              {snapshots.map((snap, i) => (
                <SnapshotCard
                  key={snap.id}
                  snapshot={snap}
                  sourceLabel={snapshotSource(snap)}
                  isActive={i === 0}
                  onRestore={() => handleRestoreSnapshot(snap)}
                  onDelete={() => handleDeleteSnapshot(snap)}
                  onBookmark={() => useSessionStore.getState().bookmarkSnapshot(snap.id)}
                />
              ))}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Capture manual snapshot — document-scoped (shared canvas) */}
      {tab === 'snapshots' && (
        <div className="px-2 py-1.5 border-t ac-border-subtle ac-surface-1">
          <Button
            size="sm"
            variant="outline"
            className="w-full h-7 text-[11px] ac-border-default ac-text-2 hover:ac-surface-2 ac-transition"
            onClick={() => {
              const snap = useSessionStore.getState().captureSnapshot(documentId, document, {
                sessionId: activeSessionId,
                source: 'manual',
                label: 'Manual snapshot',
                createdBy: 'user',
              });
              toast.success('Captured canvas snapshot', {
                description: `${snap.nodeCount} nodes · visible in every chat's history`,
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

  const handleRerun = useCallback(async () => {
    // Re-run from here (P3-5): forks the active session at this run's user
    // message, switches to the fork, and prompts the agent with the SAME
    // prompt. The original transcript stays untouched — the user can compare
    // the new attempt against the original. Mirrors v0 / Cursor consensus.
    const canvasStore = useCanvasStore.getState();
    const sessStore = useSessionStore.getState();
    // Find the user message that owns this run — the message whose runId
    // matches and role === 'user'.
    const parent = sessStore.sessions[run.sessionId];
    if (!parent) {
      toast.error('Cannot re-run — parent session missing');
      return;
    }
    const userMsg = parent.messageIds
      .map((id) => sessStore.messages[id])
      .find((m) => m && m.role === 'user' && m.runId === run.id);
    if (!userMsg) {
      toast.error('Cannot re-run — original user message not found', {
        description: 'The transcript may have been pruned.',
      });
      return;
    }
    // Fork at the user message (preserves its prefix as context).
    const fork = sessStore.forkSession(run.sessionId, userMsg.id);
    if (!fork) {
      toast.error('Fork failed');
      return;
    }
    canvasStore.switchSession(fork.id);
    // Prompt the agent with the same text. Don't include image attachments —
    // they may have expired from the localStorage cache and re-sending them
    // risks confusion if the user explicitly meant "retry without images".
    setTimeout(() => {
      canvasStore.promptAgent(userMsg.text).catch((e) => {
        toast.error('Re-run failed to start', { description: String(e).slice(0, 120) });
      });
    }, 200);
    toast.success(`Re-running in "${fork.title}"`, {
      description: 'Original transcript is preserved — switch back to compare.',
    });
  }, [run.id, run.sessionId]);

  const handleExportMarkdown = useCallback(async () => {
    try {
      const md = await exportRunMarkdown(run.sessionId, run.id);
      if (!md) {
        toast.error('Export failed', { description: 'Server returned no transcript.' });
        return;
      }
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fname = run.prompt.slice(0, 40).replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'run';
      a.download = `run-${fname}.md`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Exported run as Markdown');
    } catch (e) {
      toast.error('Export failed', { description: String(e).slice(0, 100) });
    }
  }, [run.id, run.sessionId, run.prompt]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <button
              className="w-full text-left rounded-md border ac-border-subtle hover:ac-border-default hover:ac-surface-1 ac-surface-0 px-2.5 py-1.5 ac-transition ac-focus-ring"
            >
              <div className="flex items-start gap-1.5">
                <ChevronRight className={`h-3 w-3 mt-0.5 ac-text-4 transition-transform ${open ? 'rotate-90' : ''}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium ac-text-1 line-clamp-1">{run.prompt}</div>
                  <div className="flex items-center gap-1.5 mt-1 text-[10px] ac-text-4 flex-wrap">
                    <StatusBadge status={run.status} />
                    <span className="flex items-center gap-0.5">
                      <Clock className="h-2.5 w-2.5" />
                      {formatDuration(run.durationMs)}
                    </span>
                    <span className="ac-text-5">·</span>
                    <span className="flex items-center gap-0.5">
                      <Wrench className="h-2.5 w-2.5" />
                      {toolCalls.length}
                    </span>
                    {/* Per-run cost badge (P3-6): only render if non-zero. */}
                    {(run.inputTokens > 0 || run.outputTokens > 0) && (
                      <>
                        <span className="ac-text-5">·</span>
                        <span
                          className="font-mono ac-text-3"
                          title={`Per-run tokens: ${run.inputTokens.toLocaleString()} input + ${run.outputTokens.toLocaleString()} output${run.costUsd > 0 ? ` · $${run.costUsd.toFixed(4)}` : ''}`}
                        >
                          {formatTokens(run.inputTokens + run.outputTokens)} tok
                          {run.costUsd > 0 && (
                            <span className="ac-text-4 ml-0.5">${run.costUsd.toFixed(4)}</span>
                          )}
                        </span>
                      </>
                    )}
                    <span className="ac-text-5 ml-auto">{relativeTime(run.createdAt)}</span>
                  </div>
                </div>
              </div>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="pl-4 pr-1 py-1 space-y-0.5">
              {toolCalls.length === 0 && (
                <div className="text-[10px] ac-text-4 italic px-2 py-1">No tool calls in this run.</div>
              )}
              {toolCalls.map((tc) => (
                <ToolCallCard key={tc.id} tc={tc} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </ContextMenuTrigger>
      {/* Run card right-click — Expand/Collapse, Re-run from here (P3-5),
          Fork from here, Copy prompt, Copy tool calls JSON, Export MD (P2-37),
          Delete run. */}
      <ContextMenuContent>
        <ContextMenuItem onClick={() => setOpen((v) => !v)}>
          {open ? 'Collapse' : 'Expand'}
        </ContextMenuItem>
        <ContextMenuItem onClick={handleRerun}>
          <PlayCircle className="h-3 w-3 mr-2" />
          Re-run from here
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          // Fork from this run — fork at the run's user message so the new
          // chat has the prefix up to & including the prompt (no auto-send).
          const sessStore = useSessionStore.getState();
          const canvasStore = useCanvasStore.getState();
          const parent = sessStore.sessions[run.sessionId];
          if (!parent) return;
          const userMsg = parent.messageIds
            .map((id) => sessStore.messages[id])
            .find((m) => m && m.role === 'user' && m.runId === run.id);
          if (!userMsg) {
            toast.message('Original user message not found');
            return;
          }
          const fork = sessStore.forkSession(run.sessionId, userMsg.id);
          if (fork) {
            canvasStore.switchSession(fork.id);
            toast.success(`Forked chat: ${fork.title}`, {
              description: 'Same prefix as the original — diverge freely.',
            });
          }
        }}>
          Fork from here
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(run.prompt).then(() => toast.message('Prompt copied'));
          }
        }}>
          Copy prompt
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            const data = JSON.stringify(toolCalls, null, 2);
            navigator.clipboard.writeText(data).then(() => toast.message('Tool calls copied as JSON'));
          }
        }}>
          Copy all tool calls as JSON
        </ContextMenuItem>
        <ContextMenuItem onClick={handleExportMarkdown}>
          <FileText className="h-3 w-3 mr-2" />
          Export run as Markdown
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            if (confirm('Delete this run? Messages and tool-call records are removed; snapshots stay (document-scoped).')) {
              useSessionStore.getState().deleteRun?.(run.id);
              toast.success('Run deleted');
            }
          }}
          className="ac-text-danger"
        >
          <Trash2 className="h-3 w-3 mr-2" />
          Delete run
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ToolCallCard({ tc }: { tc: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded ac-surface-1 border ac-border-subtle px-2 py-1">
      <button
        className="w-full text-left ac-focus-ring rounded"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-1.5 text-[10px] font-medium ac-text-2">
          <Wrench className="h-2.5 w-2.5 ac-text-4" />
          <code className="text-[9px] ac-surface-2 ac-text-2 px-1 py-0.5 rounded font-mono">{tc.name}</code>
          <StatusBadge status={tc.status} />
          {tc.durationMs != null && (
            <span className="ml-auto text-[9px] ac-text-4 font-mono">{formatDuration(tc.durationMs)}</span>
          )}
        </div>
      </button>
      {tc.summary && (
        <div className="mt-1 text-[10px] ac-text-3">{tc.summary}</div>
      )}
      {expanded && tc.argsPreview && (
        <pre className="mt-1 text-[9px] ac-text-3 font-mono overflow-x-auto whitespace-pre-wrap break-all ac-surface-0 border ac-border-subtle rounded p-1.5">
          {tc.argsPreview}
        </pre>
      )}
    </div>
  );
}

function SnapshotCard({
  snapshot, isActive, sourceLabel, onRestore, onDelete, onBookmark,
}: {
  snapshot: Snapshot;
  isActive: boolean;
  sourceLabel: string;
  onRestore: () => void;
  onDelete: () => void;
  onBookmark: () => void;
}) {
  const sourceColor: Record<Snapshot['source'], string> = {
    turn_end: 'ac-text-3 ac-surface-2',
    fork: 'ac-status-info',
    restore: 'ac-status-warning',
    manual: 'ac-status-neutral',
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={`rounded-md border px-2.5 py-1.5 ac-transition ${
          isActive ? 'border-[var(--ac-success-border)] bg-[var(--ac-success-soft)]' : 'ac-border-subtle ac-surface-0 hover:ac-border-default hover:ac-surface-1'
        }`}>
          <div className="flex items-center gap-1.5">
            <Camera className="h-3 w-3 ac-text-4" />
            <span className="text-[11px] font-medium ac-text-1 flex-1 truncate">
              {snapshot.label ?? snapshot.id.slice(0, 12)}
            </span>
            {snapshot.remote && (
              <span className="text-[9px] ac-status-info px-1 py-0 rounded font-medium" title="Synced from the server">
                remote
              </span>
            )}
            {isActive && (
              <span className="text-[9px] ac-status-success px-1 py-0 rounded font-medium">
                latest
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1 text-[9px] ac-text-4">
            <span className={`px-1 py-0 rounded font-medium ${sourceColor[snapshot.source]}`}>
              {snapshot.source}
            </span>
            <span>{snapshot.nodeCount} nodes</span>
            <span className="ac-text-5">·</span>
            <span>{relativeTime(snapshot.createdAt)}</span>
          </div>
          <div className="flex items-center gap-1 mt-1 text-[9px] ac-text-4 min-w-0">
            <MessageSquare className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate" title={`Captured by chat: ${sourceLabel}`}>
              {sourceLabel}
            </span>
          </div>
          <div className="flex items-center gap-1 mt-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-5 text-[9px] px-1.5 ac-border-default ac-text-2 hover:ac-surface-1 ac-transition"
              onClick={onRestore}
              disabled={isActive}
              title="Restore the shared canvas to this snapshot"
            >
              <RotateCcw className="h-2.5 w-2.5 mr-0.5" />
              Restore
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 w-5 p-0 ml-auto ac-text-4 hover:ac-text-1 hover:ac-surface-1 ac-transition"
              onClick={onBookmark}
              title={snapshot.bookmarked ? 'Remove bookmark' : 'Bookmark'}
            >
              {snapshot.bookmarked
                ? <BookmarkCheck className="h-3 w-3 ac-text-warning" />
                : <Bookmark className="h-3 w-3" />}
            </Button>
          </div>
        </div>
      </ContextMenuTrigger>
      {/* P1-22: Snapshot card right-click — Restore, Bookmark, Rename,
          Delete, Export .pen, Copy JSON. (Fork-from-snapshot was removed in
          the shared-canvas model — restore covers the semantics.) */}
      <ContextMenuContent>
        <ContextMenuItem onClick={onRestore} disabled={isActive}>Restore</ContextMenuItem>
        <ContextMenuItem onClick={onBookmark}>{snapshot.bookmarked ? 'Remove bookmark' : 'Bookmark'}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => toast.message('Rename snapshot — not yet implemented (P2-38)')}>
          Rename snapshot
        </ContextMenuItem>
        <ContextMenuItem onClick={onDelete} className="ac-text-danger">
          Delete snapshot
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2)).then(() => toast.message('Snapshot copied as JSON'));
          }
        }}>
          Copy as JSON
        </ContextMenuItem>
        <ContextMenuItem onClick={() => toast.message('Export as .pen — not yet implemented')}>
          Export as .pen
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
