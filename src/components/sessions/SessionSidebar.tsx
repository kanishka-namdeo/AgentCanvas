'use client';

// Left sidebar: lists all sessions for the current document.
//
// Features:
//   - Search by title
//   - "New chat" button (creates + activates a new session)
//   - Pinned sessions float to the top
//   - Each item shows: title, relative time, status dot, message count,
//     tool-call count, and a hover-revealed context menu (⋯)
//   - Context menu actions: Rename, Pin/Unpin, Fork, Archive, Delete
//   - Active session is highlighted
//
// Mirrors the sidebar patterns used by v0, Bolt.new, Lovable, and Cursor
// Composer (see research notes §6).

import { useState, useMemo, useEffect } from 'react';
import { useSessionStore } from '@/lib/sessions';
import { useCanvasStore } from '@/lib/canvas/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Plus, Search, MoreHorizontal, Pin, PinOff, GitFork, Archive, Trash2, Pencil, MessageSquare, Wrench, Star,
  Copy, FileJson, FileText,
} from 'lucide-react';
import { StatusDot } from './StatusBadge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

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
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function SessionSidebar() {
  const documentId = useCanvasStore((s) => s.documentId);
  const activeSessionId = useCanvasStore((s) => s.activeSessionId);
  const switchSession = useCanvasStore((s) => s.switchSession);
  const newSession = useCanvasStore((s) => s.newSession);
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Subscribe to sessions map so the list re-renders when sessions change.
  // We use the map + filter approach because listSessions returns a new
  // array each call (which would cause an infinite re-render loop).
  const sessionsMap = useSessionStore((s) => s.sessions);
  // Compute stats via useMemo — NEVER call s.getStats() inside a selector
  // because it returns a new object every call (causes infinite re-render).
  const stats = useMemo(() => {
    const all = Object.values(sessionsMap).filter((s) => s.documentId === documentId);
    return {
      activeSessions: all.filter((s) => s.status === 'active').length,
      totalRuns: all.reduce((n, s) => n + s.runCount, 0),
      totalToolCalls: all.reduce((n, s) => n + s.toolCallCount, 0),
      totalSnapshots: all.reduce((n, s) => n + s.snapshotIds.length, 0),
    };
  }, [sessionsMap, documentId]);

  const sessions = useMemo(() => {
    const all = Object.values(sessionsMap).filter((s) => s.documentId === documentId);
    const filtered = all.filter((s) => s.status === 'active');
    const searched = search.trim()
      ? filtered.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()))
      : filtered;
    return [...searched].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
    });
  }, [sessionsMap, documentId, search]);

  const archivedSessions = useMemo(() => {
    return Object.values(sessionsMap).filter(
      (s) => s.documentId === documentId && s.status === 'archived',
    );
  }, [sessionsMap, documentId]);

  const handleRename = (id: string, currentTitle: string) => {
    setRenamingId(id);
    setRenameValue(currentTitle);
  };
  const commitRename = () => {
    if (renamingId) {
      useSessionStore.getState().renameSession(renamingId, renameValue);
    }
    setRenamingId(null);
    setRenameValue('');
  };

  return (
    <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b ac-border-subtle">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <MessageSquare className="h-3.5 w-3.5 ac-text-3 flex-shrink-0" />
            <span className="text-[11px] font-semibold uppercase tracking-wide ac-text-2 truncate">Chats</span>
            {stats.activeSessions > 0 && (
              <span className="text-[10px] ac-text-4 ml-0.5">{stats.activeSessions}</span>
            )}
          </div>
        </div>
        {/* Primary CTA — visually distinct from list rows */}
        <button
          onClick={() => newSession()}
          className="w-full flex items-center justify-center gap-1.5 h-8 rounded-md text-[12px] font-medium text-white ac-transition shadow-sm mb-2"
          style={{ backgroundColor: 'var(--ac-accent)' }}
        >
          <Plus className="h-3.5 w-3.5" />
          New chat
        </button>
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 ac-text-4" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats…"
            className="h-7 pl-7 text-[11px] ac-border-subtle ac-surface-1 focus-visible:ac-border-default ac-text-2"
          />
        </div>
      </div>

      {/* Sessions list */}
      <ScrollArea className="flex-1 min-h-0 ac-hide-scrollbar">
        <div className="p-2 space-y-0.5">
          {sessions.length === 0 && (
            <div className="text-center text-[11px] ac-text-4 py-8 px-3">
              {search ? 'No matches.' : (
                <>
                  <p className="font-medium ac-text-3 mb-1">No chats yet</p>
                  <p className="ac-text-4">Click “New chat” above to start.</p>
                </>
              )}
            </div>
          )}
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                onClick={() => switchSession(session.id)}
                className={`group relative cursor-pointer rounded-md px-2.5 py-1.5 ac-transition ac-focus-ring ${
                  isActive
                    ? 'ac-active-row'
                    : 'hover:ac-surface-1'
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-shrink-0 pt-1">
                    <StatusDot status={session.currentRunId ? 'in_progress' : 'completed'} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 min-w-0">
                      {session.pinned && <Pin className="h-2.5 w-2.5 flex-shrink-0" style={{ color: 'var(--ac-accent)' }} />}
                      {session.starred && <Star className="h-2.5 w-2.5 text-amber-400 flex-shrink-0 fill-amber-400" />}
                      {!session.isRoot && <GitFork className="h-2.5 w-2.5 ac-text-4 flex-shrink-0" />}
                      <span className={`text-[12px] font-medium truncate ${isActive ? 'ac-text-1' : 'ac-text-2'}`}>
                        {session.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[10px] ac-text-4">
                      <span>{relativeTime(session.lastOpenedAt)}</span>
                      <span className="ac-text-5">·</span>
                      <span>{session.messageCount} msg</span>
                      <span className="ac-text-5">·</span>
                      <span className="flex items-center gap-0.5">
                        <Wrench className="h-2.5 w-2.5" />
                        {session.toolCallCount}
                      </span>
                    </div>
                  </div>
                  {/* Context menu */}
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 -mr-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="p-1 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="text-[11px] min-w-[180px]" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide ac-text-4 truncate">
                          {session.title}
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="py-1.5" onClick={() => handleRename(session.id, session.title)}>
                          <Pencil className="h-3 w-3 mr-2" /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem className="py-1.5" onClick={() => useSessionStore.getState().togglePin(session.id)}>
                          {session.pinned ? <PinOff className="h-3 w-3 mr-2" /> : <Pin className="h-3 w-3 mr-2" />}
                          {session.pinned ? 'Unpin' : 'Pin'}
                        </DropdownMenuItem>
                        <DropdownMenuItem className="py-1.5" onClick={() => useSessionStore.getState().toggleStar(session.id)}>
                          <Star className="h-3 w-3 mr-2" /> {session.starred ? 'Unstar' : 'Star'}
                        </DropdownMenuItem>
                        <DropdownMenuItem className="py-1.5" onClick={() => {
                          // Fork the session whose row this menu was opened on,
                          // NOT the currently-active session. Then switch to the fork.
                          const fork = useSessionStore.getState().forkSession(session.id, null);
                          if (fork) {
                            switchSession(fork.id);
                            toast.success(`Forked chat: ${fork.title}`);
                          }
                        }}>
                          <GitFork className="h-3 w-3 mr-2" /> Fork this chat
                        </DropdownMenuItem>
                        {/* P1-20: 5 new session-row items */}
                        <DropdownMenuItem className="py-1.5" onClick={() => {
                          // Duplicate: fork but don't switch — creates a sibling at the same tree level.
                          const dup = useSessionStore.getState().forkSession(session.id, null);
                          if (dup) toast.success(`Duplicated "${session.title}" → "${dup.title}"`);
                        }}>
                          <Copy className="h-3 w-3 mr-2" /> Duplicate session
                        </DropdownMenuItem>
                        <DropdownMenuItem className="py-1.5" onClick={async () => {
                          // Export as JSONL (server-side, compatible with pi-agent SDK).
                          try {
                            const { exportSessionJSONL } = await import('@/lib/sessions/server-sync');
                            const jsonl = await exportSessionJSONL(session.id);
                            if (jsonl) {
                              const blob = new Blob([jsonl], { type: 'application/jsonl' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `${session.title.replace(/[^a-z0-9-_]+/gi, '-')}.jsonl`;
                              a.click();
                              URL.revokeObjectURL(url);
                              toast.success('Exported session', { description: `${session.title}.jsonl` });
                            } else {
                              // Fallback: export localStorage session as JSON.
                              const data = JSON.stringify(useSessionStore.getState().sessions[session.id] ?? null, null, 2);
                              const blob = new Blob([data], { type: 'application/json' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `${session.title.replace(/[^a-z0-9-_]+/gi, '-')}.json`;
                              a.click();
                              URL.revokeObjectURL(url);
                              toast.success('Exported session (local)', { description: `${session.title}.json` });
                            }
                          } catch (e) {
                            toast.error('Export failed', { description: String(e).slice(0, 100) });
                          }
                        }}>
                          <FileJson className="h-3 w-3 mr-2" /> Export session
                        </DropdownMenuItem>
                        <DropdownMenuItem className="py-1.5" onClick={() => toast.message('Export as Markdown — not yet implemented (P2-37)')}>
                          <FileText className="h-3 w-3 mr-2" /> Export as Markdown
                        </DropdownMenuItem>
                        <DropdownMenuItem className="py-1.5" onClick={() => {
                          const sessState = useSessionStore.getState();
                          const sess = sessState.sessions[session.id];
                          const msgs = sessState.messages;
                          const prompts = (sess?.messageIds ?? [])
                            .map(id => msgs[id])
                            .filter(m => m && m.role === 'user')
                            .map(m => m.text)
                            .join('\n\n---\n\n');
                          if (typeof navigator !== 'undefined' && navigator.clipboard && prompts) {
                            navigator.clipboard.writeText(prompts).then(() => toast.success('Prompt summary copied to clipboard'));
                          } else {
                            toast.message('No user prompts in this session.');
                          }
                        }}>
                          <Copy className="h-3 w-3 mr-2" /> Copy prompt summary
                        </DropdownMenuItem>
                        <DropdownMenuItem className="py-1.5" onClick={() => toast.message('Mark as template — not yet implemented (P2-41)')}>
                          <Star className="h-3 w-3 mr-2" /> Mark as template
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="py-1.5" onClick={() => {
                          useSessionStore.getState().archiveSession(session.id);
                          toast.success(`Archived "${session.title}"`, { description: 'Find it in the Archived section below.' });
                        }}>
                          <Archive className="h-3 w-3 mr-2" /> Archive
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          className="py-1.5"
                          onClick={() => {
                            if (confirm(`Delete "${session.title}"? This cannot be undone.`)) {
                              useSessionStore.getState().deleteSession(session.id);
                              toast.success(`Deleted "${session.title}"`);
                            }
                          }}
                        >
                          <Trash2 className="h-3 w-3 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Archived section */}
          {archivedSessions.length > 0 && (
            <>
              <div className="px-2.5 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wide ac-text-4">
                Archived · {archivedSessions.length}
              </div>
              {archivedSessions.map((session) => (
                <div
                  key={session.id}
                  className="group relative cursor-pointer rounded-md px-2.5 py-1.5 hover:ac-surface-1 ac-transition"
                  onClick={() => {
                    useSessionStore.getState().unarchiveSession(session.id);
                    switchSession(session.id);
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <Archive className="h-3 w-3 ac-text-4 flex-shrink-0" />
                    <span className="text-[12px] ac-text-3 truncate flex-1">{session.title}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Permanently delete "${session.title}"?`)) {
                          useSessionStore.getState().deleteSession(session.id);
                          toast.success(`Permanently deleted "${session.title}"`);
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:ac-surface-2 text-rose-500 ac-transition"
                      aria-label={`Permanently delete ${session.title}`}
                      title="Permanently delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Footer stats + server sync indicator */}
      <div className="px-3 py-1.5 border-t ac-border-subtle text-[10px] ac-text-4 flex items-center justify-between ac-surface-1">
        <span>{stats.totalRuns} runs · {stats.totalToolCalls} tools</span>
        <div className="flex items-center gap-2">
          <span>{stats.totalSnapshots} snapshots</span>
          {/* Server sync indicator — shows sessions are persisted server-side (Phase 3) */}
          <span className="flex items-center gap-0.5 text-emerald-500" title="Sessions sync to server automatically">
            <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            synced
          </span>
        </div>
      </div>

      {/* Rename dialog */}
      <Dialog open={renamingId !== null} onOpenChange={(open) => !open && setRenamingId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm ac-text-1">Rename chat</DialogTitle>
            <DialogDescription className="text-[11px] ac-text-3">
              This name appears in the sidebar. You can change it any time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <label htmlFor="rename-input" className="text-[10px] font-medium uppercase tracking-wide ac-text-4">
              Title
            </label>
            <Input
              id="rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Chat title"
              autoFocus
              className="h-8 text-[12px] ac-border-default focus-visible:ac-border-strong"
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenamingId(null);
              }}
            />
          </div>
          <DialogFooter className="gap-1.5">
            <Button size="sm" variant="ghost" className="ac-text-2 hover:ac-text-1" onClick={() => setRenamingId(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="text-white border-0"
              style={{ backgroundColor: 'var(--ac-accent)' }}
              disabled={!renameValue.trim()}
              onClick={commitRename}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
