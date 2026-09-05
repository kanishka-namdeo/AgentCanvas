'use client';

// Left sidebar: lists all sessions for the current document.
//
// Features:
//   - Debounced content search (title + message body + tool-call args via
//     GET /api/sessions/search) — replaces the previous title-only local filter
//   - Tag chips per session row + tag filter bar (P3-3)
//   - "New chat" button (creates + activates a new session)
//   - Pinned sessions float to the top
//   - Each item shows: title, relative time, status dot, message count,
//     tool-call count, and a hover-revealed context menu (⋯)
//   - Context menu actions: Rename, Pin/Unpin, Fork, Archive, Delete,
//     Export as JSONL, Export as Markdown (P2-37 — implemented)
//   - Active session is highlighted
//
// Mirrors the sidebar patterns used by v0, Bolt.new, Lovable, and Cursor
// Composer (see research notes §6).

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '@/lib/sessions';
import { useCanvasStore } from '@/lib/canvas/store';
import { BUSY_LOCK_HINT } from '@/lib/canvas/run-phase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Plus, Search, MoreHorizontal, Pin, PinOff, GitFork, Archive, Trash2, Pencil, MessageSquare, Wrench, Star, Tag as TagIcon, X,
  Copy, FileJson, FileText,
} from 'lucide-react';
import { StatusDot } from './StatusBadge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { searchServerSessions, exportSessionMarkdown, type ServerSessionSearchHit } from '@/lib/sessions/server-sync';

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

/// Highlight matched substring `q` inside `text` with a strong chip background.
function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-[var(--ac-warning-soft)] ac-text-1 rounded px-0.5">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export function SessionSidebar() {
  const documentId = useCanvasStore((s) => s.documentId);
  const activeSessionId = useCanvasStore((s) => s.activeSessionId);
  const switchSession = useCanvasStore((s) => s.switchSession);
  const newSession = useCanvasStore((s) => s.newSession);
  // Session switching mid-turn corrupts the streaming agent's transcript
  // recording (the canvas itself is shared — only the chat turns buffer is
  // per-session; the store guard exists too — this disables the affordance
  // and hints why).
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Content-search state — populated by the debounced server fetch.
  // When `hits` is non-null, we render server hits; when null (server
  // unreachable or empty q), we render the local filtered list.
  const [hits, setHits] = useState<ServerSessionSearchHit[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  // Tag-filter state — when non-null, only sessions containing this tag are shown.
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  // Subscribe to the sessions map so the list re-renders on change. We use
  // the map + filter approach because listSessions returns a new array each
  // call (which would cause an infinite re-render loop).
  const sessionsMap = useSessionStore((s) => s.sessions);
  const setSessionTags = useSessionStore((s) => s.setSessionTags);
  // UI-audit round 2: the old stats memo also totaled runs / tool calls /
  // snapshots for a footer bar that round 1 removed — and its snapshots-map
  // subscription re-rendered the sidebar on EVERY snapshot write for
  // nothing. Only the active-chat count (the "CHATS n" header) is consumed.
  const activeCount = useMemo(
    () => Object.values(sessionsMap).filter((s) => s.documentId === documentId && s.status === 'active').length,
    [sessionsMap, documentId],
  );

  // Document-scoped tag suggestions — derived locally from the in-memory
  // sessions map (instant); the server-side suggestions endpoint is the
  // authoritative source but the local computation is good enough for the
  // sidebar filter chips and matches the documentId scope.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of Object.values(sessionsMap)) {
      if (s.documentId !== documentId) continue;
      for (const t of s.tags ?? []) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort(
      (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
    ).slice(0, 12);
  }, [sessionsMap, documentId]);

  // Debounced server content search — fires 350ms after the last keystroke.
  // Empty q (< 2 chars) clears the hits and reverts to local-only filtering.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = search.trim();
    if (q.length < 2) {
      setHits(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    debounceRef.current = setTimeout(async () => {
      const serverHits = await searchServerSessions({ q, documentId, scope: 'document' });
      setHits(serverHits);
      setSearchLoading(false);
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, documentId]);

  // When server search is active (hits !== null), render hits. Otherwise
  // fall back to the local title-filtered list (preserves instant UX).
  const sessions = useMemo(() => {
    const all = Object.values(sessionsMap).filter((s) => s.documentId === documentId);
    const filtered = all.filter((s) => s.status === 'active');
    const tagFiltered = tagFilter
      ? filtered.filter((s) => (s.tags ?? []).includes(tagFilter))
      : filtered;
    if (hits !== null) {
      // Server content search — render only sessions that returned a hit.
      const hitIds = new Set(hits.map((h) => h.sessionId));
      return tagFiltered
        .filter((s) => hitIds.has(s.id))
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
        });
    }
    const searched = search.trim()
      ? filtered.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()))
      : filtered;
    const tagFinal = tagFilter
      ? searched.filter((s) => (s.tags ?? []).includes(tagFilter))
      : searched;
    return [...tagFinal].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
    });
  }, [sessionsMap, documentId, search, hits, tagFilter]);

  // Search-hit lookup by sessionId (for snippet + matchIn chip).
  const hitBySession = useMemo(() => {
    const m = new Map<string, ServerSessionSearchHit>();
    if (hits) for (const h of hits) m.set(h.sessionId, h);
    return m;
  }, [hits]);

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

  const triggerMarkdownExport = useCallback(async (sessionId: string, title: string) => {
    try {
      const md = await exportSessionMarkdown(sessionId);
      if (!md) {
        toast.error('Export failed', { description: 'Server returned no transcript.' });
        return;
      }
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title.replace(/[^a-z0-9-_]+/gi, '-')}.md`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Exported as Markdown', { description: `${title}.md` });
    } catch (e) {
      toast.error('Export failed', { description: String(e).slice(0, 100) });
    }
  }, []);

  return (
    <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
      {/* Header — UI-audit 2026-08-29: compressed ~112px → ~68px. The
          full-width accent "New chat" CTA (the loudest element in the whole
          app, for a secondary action) became a compact ghost button inline
          with the "CHATS" label, matching how every mature chat app treats
          "new conversation" (ChatGPT / Linear / Slack). */}
      <div className="px-3 pt-2.5 pb-2 border-b ac-border-subtle">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <MessageSquare className="h-3.5 w-3.5 ac-text-3 flex-shrink-0" />
            <span className="text-[11px] font-semibold uppercase tracking-wide ac-text-2 truncate">Chats</span>
            {activeCount > 0 && (
              <span className="text-[10px] ac-text-4 ml-0.5">{activeCount}</span>
            )}
          </div>
          <button
            onClick={() => newSession()}
            title={agentBusy ? `${BUSY_LOCK_HINT} — a new chat abandons the run's transcript` : 'New chat (⌘N)'}
            aria-label="New chat"
            aria-disabled={agentBusy}
            className={`flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium ac-text-2 ac-surface-1 ac-border-subtle border hover:ac-text-1 hover:ac-border-default ac-transition ac-focus-ring flex-shrink-0 ac-busy ${agentBusy ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        </div>
        {/* Search — debounced content search (title + body + tool args) */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 ac-text-4" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats…"
            className="h-7 pl-7 pr-7 text-[11px] ac-border-subtle ac-surface-1 focus-visible:ac-border-default ac-text-2"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 ac-text-4 hover:ac-text-1 ac-transition"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {searchLoading && (
          <div className="text-[9px] ac-text-4 mt-1 px-0.5">searching…</div>
        )}
        {/* Tag filter chips */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {tagFilter && (
              <button
                onClick={() => setTagFilter(null)}
                className="text-[9px] px-1.5 py-0.5 rounded ac-surface-2 ac-text-1 ac-transition flex items-center gap-0.5"
                title="Clear tag filter"
              >
                <X className="h-2 w-2" /> clear
              </button>
            )}
            {allTags.map(({ tag, count }) => (
              <button
                key={tag}
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                className={`text-[9px] px-1.5 py-0.5 rounded ac-transition flex items-center gap-0.5 ${
                  tagFilter === tag
                    ? 'text-white'
                    : 'ac-surface-2 ac-text-2 hover:ac-text-1'
                }`}
                style={tagFilter === tag ? { backgroundColor: 'var(--ac-accent)' } : undefined}
              >
                <TagIcon className="h-2 w-2" />
                {tag}
                <span className="opacity-60 ml-0.5">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Sessions list */}
      <ScrollArea className="flex-1 min-h-0 ac-hide-scrollbar">
        <div className="p-2 space-y-0.5">
          {sessions.length === 0 && (
            <div className="text-center text-[11px] ac-text-4 py-8 px-3">
              {search ? 'No matches.' : (
                <>
                  <p className="font-medium ac-text-3 mb-1">No chats yet</p>
                  <p className="ac-text-4">Hit “New” above to start a chat.</p>
                </>
              )}
            </div>
          )}
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const hit = hitBySession.get(session.id);
            return (
              <div
                key={session.id}
                onClick={() => { if (!agentBusy) switchSession(session.id); }}
                aria-disabled={agentBusy && !isActive}
                title={agentBusy && !isActive ? `${BUSY_LOCK_HINT} — switching chats mid-run strands the stream` : undefined}
                className={`group relative rounded-md px-2.5 py-1.5 ac-transition ac-focus-ring ac-busy ${
                  agentBusy && !isActive ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                } ${
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
                      {session.starred && <Star className="h-2.5 w-2.5 ac-text-warning flex-shrink-0" style={{ fill: 'var(--ac-warning)' }} />}
                      {!session.isRoot && <GitFork className="h-2.5 w-2.5 ac-text-4 flex-shrink-0" />}
                      <span className={`text-[12px] font-medium truncate ${isActive ? 'ac-text-1' : 'ac-text-2'}`}>
                        {hit ? highlight(session.title, search.trim()) : session.title}
                      </span>
                    </div>
                    {/* Tag chips per session row */}
                    {(session.tags ?? []).length > 0 && (
                      <div className="flex flex-wrap gap-0.5 mt-0.5">
                        {(session.tags ?? []).slice(0, 3).map((t) => (
                          <button
                            key={t}
                            onClick={(e) => {
                              e.stopPropagation();
                              setTagFilter(tagFilter === t ? null : t);
                            }}
                            className="text-[10px] px-1.5 py-0.5 rounded ac-surface-2 ac-text-3 hover:ac-text-1 ac-transition"
                            title={`Filter by "${t}"`}
                          >
                            {t}
                          </button>
                        ))}
                        {(session.tags ?? []).length > 3 && (
                          <span className="text-[8px] ac-text-4">+{session.tags.length - 3}</span>
                        )}
                      </div>
                    )}
                    {/* Search-hit snippet — first message-body or tool-args match */}
                    {hit?.snippet && (
                      <div className="mt-0.5 text-[10px] ac-text-3 ac-surface-1 px-1 py-0.5 rounded truncate">
                        {highlight(hit.snippet, search.trim())}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-1 text-[10px] ac-text-4">
                      <span>{relativeTime(session.lastOpenedAt)}</span>
                      <span className="ac-text-5">·</span>
                      <span>{session.messageCount} msg</span>
                      <span className="ac-text-5">·</span>
                      <span className="flex items-center gap-0.5">
                        <Wrench className="h-2.5 w-2.5" />
                        {session.toolCallCount}
                      </span>
                      {hit && (
                        <>
                          <span className="ac-text-5">·</span>
                          <span className="ac-text-4 flex items-center gap-0.5">
                            {hit.matchIn.includes('title') && <span>title</span>}
                            {hit.matchIn.includes('message') && <span>msg</span>}
                            {hit.matchIn.includes('tool_calls') && <span>tool</span>}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {/* Context menu */}
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 -mr-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`More actions for ${session.title}`}
                          title="More actions (rename, pin, star, tags, fork, archive…)"
                          className="p-1 rounded ac-text-4 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="text-[11px] min-w-[200px]" onClick={(e) => e.stopPropagation()}>
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
                        <DropdownMenuSeparator />
                        {/* Tag editor inline — quick add/remove */}
                        <TagEditorInline sessionId={session.id} tags={session.tags ?? []} onSet={(tags) => setSessionTags(session.id, tags)} />
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="py-1.5" disabled={agentBusy} onClick={() => {
                          // Busy guard — the fork switches chats (the store
                          // backstops with a toast; the affordance matches).
                          if (agentBusy) return;
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
                        {/* D5: Duplicate forks WITHOUT switching — safe for
                            non-active rows, but duplicating the ACTIVE session
                            mid-run snapshots a half-streamed transcript (and
                            the fork guard family should behave alike). */}
                        <DropdownMenuItem
                          className={`py-1.5 ${agentBusy && isActive ? 'ac-busy' : ''}`}
                          disabled={agentBusy && isActive}
                          title={agentBusy && isActive ? BUSY_LOCK_HINT : 'Create a copy of this chat'}
                          onClick={() => {
                            if (agentBusy && isActive) return;
                            // Duplicate: fork but don't switch — creates a sibling at the same tree level.
                            const dup = useSessionStore.getState().forkSession(session.id, null);
                            if (dup) toast.success(`Duplicated "${session.title}" → "${dup.title}"`);
                          }}
                        >
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
                          <FileJson className="h-3 w-3 mr-2" /> Export as JSONL
                        </DropdownMenuItem>
                        <DropdownMenuItem className="py-1.5" onClick={() => triggerMarkdownExport(session.id, session.title)}>
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
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="py-1.5" disabled={agentBusy && isActive} onClick={() => {
                          // Busy guard — archiving the ACTIVE session while the
                          // agent streams into it corrupts the run's transcript
                          // landing. Non-active rows archive freely.
                          if (agentBusy && isActive) return;
                          useSessionStore.getState().archiveSession(session.id);
                          toast.success(`Archived "${session.title}"`, { description: 'Find it in the Archived section below.' });
                        }}>
                          <Archive className="h-3 w-3 mr-2" /> Archive
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          className="py-1.5"
                          disabled={agentBusy && isActive}
                          onClick={() => {
                            if (agentBusy && isActive) return;
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
                  aria-disabled={agentBusy}
                  title={agentBusy ? `${BUSY_LOCK_HINT} — switching chats mid-run strands the stream` : undefined}
                  className={`group relative rounded-md px-2.5 py-1.5 ac-transition ac-busy ${agentBusy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:ac-surface-1'}`}
                  onClick={() => {
                    if (agentBusy) return; // switchSession's guard backstops
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
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:ac-surface-2 ac-text-danger ac-transition"
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

      {/* UI-audit 2026-08-29: footer stats bar removed. "N runs · N tools ·
          N snapshots · ✓ synced" wrapped to two lines at the bottom of the
          panel and duplicated (a) the RunHistory tab's own header counts and
          (b) sync status already carried by the header's single bot chip.
          Exception-only: sync failures surface via toast. */}

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

/// Inline tag editor rendered inside the session-row context menu.
/// A small combobox: shows existing tags as removable chips, plus a text
/// input that adds a new tag on Enter. Submitting calls onSet with the
/// full new array (full replacement — the store's setSessionTags sends
/// the whole array to the server, not a delta).
function TagEditorInline({
  sessionId, tags, onSet,
}: {
  sessionId: string;
  tags: string[];
  onSet: (tags: string[]) => void;
}) {
  const [newTag, setNewTag] = useState('');
  // Reset the input whenever this editor re-mounts (the dropdown menu item
  // re-renders per session row). Synchronous reset is intentional — the
  // editor is keyed per session, so this runs once per mount, not per render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setNewTag(''); }, [sessionId]);

  const addTag = () => {
    const v = newTag.trim();
    if (!v) return;
    if (tags.includes(v)) {
      setNewTag('');
      return;
    }
    onSet([...tags, v]);
    setNewTag('');
  };
  const removeTag = (t: string) => {
    onSet(tags.filter((x) => x !== t));
  };

  return (
    <div className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
      <div className="text-[9px] font-semibold uppercase tracking-wide ac-text-4 mb-1 flex items-center gap-1">
        <TagIcon className="h-2.5 w-2.5" /> Tags
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-0.5 mb-1">
          {tags.map((t) => (
            <span key={t} className="text-[9px] px-1 py-0.5 rounded ac-surface-2 ac-text-2 flex items-center gap-0.5">
              {t}
              <button
                onClick={() => removeTag(t)}
                className="ac-text-4 hover:ac-text-danger ac-transition"
                aria-label={`Remove tag ${t}`}
              >
                <X className="h-2 w-2" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={newTag}
        onChange={(e) => setNewTag(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addTag();
          }
          if (e.key === 'Backspace' && !newTag && tags.length > 0) {
            removeTag(tags[tags.length - 1]);
          }
        }}
        placeholder="Add tag, Enter to save"
        className="h-6 text-[11px] ac-border-subtle"
      />
    </div>
  );
}
