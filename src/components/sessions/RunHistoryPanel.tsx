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
import type { CanvasDocument } from '@/lib/canvas/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  ChevronRight, Wrench, Clock, History, Bookmark, BookmarkCheck, RotateCcw, Camera, MessageSquare, PlayCircle, FileText, Trash2,
  Pencil, FileDown, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import {
  exportRunMarkdown, updateDocumentSnapshot, fetchDocumentSnapshot,
} from '@/lib/sessions/server-sync';
import { classifyRunError } from '@/lib/sessions/error-classify';
import { formatCost } from '@/lib/sessions/format';

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

  // Rename-snapshot dialog state (P2-38). Lifted to RunHistoryPanel so a single
  // Dialog instance serves every SnapshotCard in the list — same pattern as
  // SessionSidebar's "Rename chat" dialog.
  const [renameSnap, setRenameSnap] = useState<Snapshot | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  const openRenameSnapshot = useCallback((snap: Snapshot) => {
    setRenameSnap(snap);
    setRenameValue(snap.label ?? snap.id.slice(0, 12));
  }, []);

  const cancelRenameSnapshot = useCallback(() => {
    setRenameSnap(null);
    setRenameValue('');
    setRenameBusy(false);
  }, []);

  const commitRenameSnapshot = useCallback(async () => {
    if (!renameSnap) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    const snapId = renameSnap.id;
    const docId = renameSnap.documentId;
    setRenameBusy(true);
    // Optimistic local update — mirrors renameSession's local-first pattern.
    useSessionStore.setState((s) => ({
      snapshots: {
        ...s.snapshots,
        [snapId]: { ...s.snapshots[snapId], label: trimmed },
      },
    }));
    // Fire-and-forget server sync (PATCH /api/documents/[id]/snapshots/[snapId]
    // already supports { label }).
    let ok = false;
    try {
      ok = await updateDocumentSnapshot(docId, snapId, { label: trimmed });
    } catch {
      ok = false;
    }
    setRenameBusy(false);
    setRenameSnap(null);
    setRenameValue('');
    if (ok) {
      toast.success('Snapshot renamed');
    } else {
      toast.error('Snapshot label did not sync', {
        description: 'Saved locally — will retry on next server sync.',
      });
    }
  }, [renameSnap, renameValue]);

  // Export snapshot as .pen — reuses POST /api/pen/export (the same converter
  // path PenFileMenu uses) with the snapshot's stored document. Remote
  // (metadata-only) entries are hydrated via fetchDocumentSnapshot first.
  const handleExportSnapshotPen = useCallback(async (snap: Snapshot) => {
    let doc: CanvasDocument | undefined = snap.document;
    const needsFetch =
      snap.remote ||
      !doc ||
      !Array.isArray(doc.shapes) ||
      doc.shapes.length === 0 ||
      doc.id === 'remote-placeholder';
    if (needsFetch) {
      try {
        const fetched = await fetchDocumentSnapshot(snap.documentId, snap.id);
        if (fetched && fetched.document) {
          doc = fetched.document as CanvasDocument;
        }
      } catch {
        // fallthrough to the empty-check below
      }
    }
    if (!doc || !Array.isArray(doc.shapes) || doc.shapes.length === 0) {
      toast.error('Snapshot has no canvas data');
      return;
    }
    const baseName =
      (snap.label ?? snap.id.slice(0, 12))
        .replace(/[^a-z0-9-_]+/gi, '-')
        .replace(/^-+|-+$/g, '') || 'snapshot';
    try {
      const res = await fetch('/api/pen/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document: doc, filename: baseName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      // Use globalThis.document — the component's outer scope has a
      // `document` (the CanvasDocument from useCanvasStore) that shadows
      // the browser global here.
      const a = globalThis.document.createElement('a');
      a.href = url;
      a.download = `${baseName}.pen`;
      globalThis.document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${baseName}.pen`, {
        description: `${doc.shapes.length} nodes → .pen format`,
      });
    } catch (e: any) {
      toast.error('Export failed', { description: e?.message ?? 'Unknown error' });
    }
  }, []);

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
                  onRename={() => openRenameSnapshot(snap)}
                  onExportPen={() => handleExportSnapshotPen(snap)}
                />
              ))}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Rename-snapshot dialog (P2-38) — mirrors SessionSidebar's Rename-chat dialog. */}
      <Dialog open={renameSnap !== null} onOpenChange={(open) => !open && cancelRenameSnapshot()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm ac-text-1">Rename snapshot</DialogTitle>
            <DialogDescription className="text-[11px] ac-text-3">
              This label appears in the snapshot timeline. You can change it any time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <label htmlFor="snap-rename-input" className="text-[10px] font-medium uppercase tracking-wide ac-text-4">
              Label
            </label>
            <Input
              id="snap-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Snapshot label"
              autoFocus
              disabled={renameBusy}
              className="h-8 text-[12px] ac-border-default focus-visible:ac-border-strong"
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRenameSnapshot();
                if (e.key === 'Escape') cancelRenameSnapshot();
              }}
            />
          </div>
          <DialogFooter className="gap-1.5">
            <Button size="sm" variant="ghost" className="ac-text-2 hover:ac-text-1" onClick={cancelRenameSnapshot} disabled={renameBusy}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="text-white border-0"
              style={{ backgroundColor: 'var(--ac-accent)' }}
              disabled={!renameValue.trim() || renameBusy}
              onClick={commitRenameSnapshot}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
  // agentBusy — read from the canvas store so we can DISABLE the Retry
  // button while another run is mid-flight (avoids stacking retries on
  // top of an in-progress turn — mirrors v0's "agent is busy" guard).
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const toolCalls: ToolCallRecord[] = useMemo(() => {
    // Render-time id dedupe (defensive): toolCallIds are guarded against
    // duplicates at insertion, but runs persisted before that guard existed
    // can still carry the same id twice — which surfaced as React
    // "two children with the same key" in this timeline. First occurrence
    // wins (stable step order preserved by the sort below).
    const seen = new Set<string>();
    return run.toolCallIds
      .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
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
      try {
        // promptAgent returns void (it routes through the socket / HTTP
        // fallback internally; failures surface as agent:error events).
        canvasStore.promptAgent(userMsg.text);
      } catch (e) {
        toast.error('Re-run failed to start', { description: String(e).slice(0, 120) });
      }
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

  // Retry button visibility (Task 4b-retry-turn): show only when the run is
  // in a terminal FAILURE state (failed / incomplete / stuck) AND no other
  // run is in flight (agentBusy guard — avoids stacking retries on top of
  // a still-running turn). Reuses `handleRerun` so the semantics match the
  // existing "Re-run from here" context-menu action (fork + auto-prompt).
  const canRetry =
    (run.status === 'failed' || run.status === 'incomplete' || run.status === 'stuck') &&
    !agentBusy;

  // Error classification (Task 4b-retry-turn): when the run carries an
  // `errorMessage`, classify it as transient / permanent / unknown so the
  // chip can hint whether retry is plausible. Pure helper — see
  // src/lib/sessions/error-classify.ts.
  const errorClass = useMemo(
    () => classifyRunError(run.errorMessage),
    [run.errorMessage],
  );

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
                  {/* Error display (Task 4b-retry-turn): when the run carries
                      an `errorMessage`, show the raw text (truncated) + a
                      small classification chip so the user knows whether a
                      retry is likely to succeed. Mirrors bolt.diy / v0
                      inline-error patterns. */}
                  {run.errorMessage && (
                    <div className="flex items-center gap-1 mt-0.5 text-[10px] ac-text-danger min-w-0">
                      <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate" title={run.errorMessage}>
                        {run.errorMessage}
                      </span>
                      {errorClass.kind !== 'unknown' && (
                        <span
                          className={`inline-flex items-center text-[9px] px-1 py-0 rounded border font-medium shrink-0 ${
                            errorClass.kind === 'transient'
                              ? 'ac-status-warning'
                              : 'ac-status-danger'
                          }`}
                          title={errorClass.hint}
                        >
                          {errorClass.kind === 'transient' ? 'Transient' : 'Config'}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 mt-1 text-[10px] ac-text-4 flex-wrap">
                    <StatusBadge status={run.status} />
                    {/* Retry button (Task 4b-retry-turn): small accent-filled
                        button next to the StatusBadge. Rendered via
                        `<Button asChild>` + a span so we don't nest a <button>
                        inside the CollapsibleTrigger's outer <button> (invalid
                        HTML). Reuses `handleRerun` — same fork+re-prompt flow
                        as the "Re-run from here" context-menu item. */}
                    {canRetry && (
                      <Button
                        asChild
                        size="sm"
                        className="h-5 px-1.5 text-[9px] border-0 text-white hover:opacity-90 ac-transition"
                        style={{ backgroundColor: 'var(--ac-accent)' }}
                      >
                        <span
                          role="button"
                          tabIndex={0}
                          title="Retry this turn in a new chat"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRerun();
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              handleRerun();
                            }
                          }}
                        >
                          <RotateCcw className="h-2.5 w-2.5 mr-0.5" />
                          Retry
                        </span>
                      </Button>
                    )}
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
                          title={`Per-run tokens: ${run.inputTokens.toLocaleString()} input + ${run.outputTokens.toLocaleString()} output${run.costUsd > 0 ? ` · ${formatCost(run.costUsd)}` : ''}`}
                        >
                          {formatTokens(run.inputTokens + run.outputTokens)} tok
                          {run.costUsd > 0 && (
                            <span className="ac-text-4 ml-0.5">{formatCost(run.costUsd)}</span>
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
        <pre className="mt-1 max-h-48 overflow-y-auto ac-hide-scrollbar text-[10px] ac-text-3 font-mono overflow-x-auto whitespace-pre-wrap break-all ac-surface-0 border ac-border-subtle rounded p-1.5">
          {tc.argsPreview}
        </pre>
      )}
    </div>
  );
}

function SnapshotCard({
  snapshot, isActive, sourceLabel, onRestore, onDelete, onBookmark, onRename, onExportPen,
}: {
  snapshot: Snapshot;
  isActive: boolean;
  sourceLabel: string;
  onRestore: () => void;
  onDelete: () => void;
  onBookmark: () => void;
  onRename: () => void;
  onExportPen: () => void;
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
      {/* P1-22: Snapshot card right-click — Set as current (P2-45), Restore,
          Bookmark, Rename (P2-38), Delete, Export .pen, Copy JSON.
          (Fork-from-snapshot was removed in the shared-canvas model — restore
          covers the semantics. "Set as current" is a one-click restore alias
          surfaced as a separate menu verb for parity with v0 / Linear.) */}
      <ContextMenuContent>
        <ContextMenuItem onClick={onRestore} disabled={isActive}>
          <CheckCircle2 className="h-3 w-3 mr-2" />
          Set as current
        </ContextMenuItem>
        <ContextMenuItem onClick={onRestore} disabled={isActive}>
          <RotateCcw className="h-3 w-3 mr-2" />
          Restore
        </ContextMenuItem>
        <ContextMenuItem onClick={onBookmark}>
          {snapshot.bookmarked
            ? <BookmarkCheck className="h-3 w-3 mr-2" />
            : <Bookmark className="h-3 w-3 mr-2" />}
          {snapshot.bookmarked ? 'Remove bookmark' : 'Bookmark'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onRename}>
          <Pencil className="h-3 w-3 mr-2" />
          Rename snapshot
        </ContextMenuItem>
        <ContextMenuItem onClick={onExportPen}>
          <FileDown className="h-3 w-3 mr-2" />
          Export as .pen
        </ContextMenuItem>
        <ContextMenuItem onClick={onDelete} className="ac-text-danger">
          <Trash2 className="h-3 w-3 mr-2" />
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
      </ContextMenuContent>
    </ContextMenu>
  );
}
