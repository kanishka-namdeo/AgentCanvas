'use client';

// Document switcher — dropdown in SessionHeader for multi-document support
// (P3-1). Mirrors v0 / Bolt / Replit's project picker pattern.
//
// - Lists every server-side Document (most recent first).
// - "New document" item prompts for a name, calls POST /api/documents,
//   then calls canvas store's init(newId) to swap the live document.
// - Switching documents: calls init(docId) which tears down the existing
//   socket subscription + rehydrates from the new document's journal.
//
// The picker ALSO keeps a small localStorage cache of known document ids
// (key `agentcanvas.documents.v1`) so the switcher renders instantly on
// reload before the server fetch resolves.

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { ChevronDown, FilePlus2, FileText, Trash2, Pencil } from 'lucide-react';
import { useCanvasStore } from '@/lib/canvas/store';
import { BUSY_LOCK_HINT } from '@/lib/canvas/run-phase';
import {
  fetchServerDocuments, createServerDocument, updateServerDocument, deleteServerDocument,
  type ServerDocument,
} from '@/lib/sessions/server-sync';

const LOCAL_CACHE_KEY = 'agentcanvas.documents.v1';

/// LocalStorage cache shape: id+name pairs so the switcher renders instantly
/// before the server fetch resolves.
interface LocalDoc { id: string; name: string; updatedAt: string; }

function readLocalCache(): LocalDoc[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((d) => d && typeof d.id === 'string' && typeof d.name === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeLocalCache(docs: LocalDoc[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(docs.slice(0, 50)));
  } catch {
    // localStorage may be full / disabled — non-fatal; the server is the source of truth.
  }
}

export function DocumentSwitcher() {
  const documentId = useCanvasStore((s) => s.documentId);
  const document = useCanvasStore((s) => s.document);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const init = useCanvasStore((s) => s.init);
  const setDocumentName = useCanvasStore((s) => s.setDocumentName);

  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<ServerDocument[]>([]);
  const [localDocs, setLocalDocs] = useState<LocalDoc[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Initial local-cache read (once). The setState is intentionally
  // synchronous (localStorage read → first-paint cache) — the rule's
  // cascading-render concern doesn't apply to a mount-time cache hydrate.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalDocs(readLocalCache());
  }, []);

  // Fetch server-side document list whenever the dropdown opens — keeps the
  // list fresh without burning a poll loop.
  const refresh = useCallback(async () => {
    const server = await fetchServerDocuments();
    if (server.length > 0) {
      setDocs(server);
      writeLocalCache(server.map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt })));
      setLocalDocs(readLocalCache());
    }
  }, []);

  useEffect(() => {
    // refresh() is async — its setStates land after `await`, never
    // synchronously during the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void refresh();
  }, [open, refresh]);

  // UI-audit round 2: also fetch the server list once on MOUNT — the label
  // previously refreshed only when the dropdown opened, so a rename made on
  // another tab/session left the header showing the stale cached name after
  // reload. Server rows win over the cache in `shownDocs`.
  useEffect(() => {
    // refresh() is async — its setStates land after `await`, never
    // synchronously during the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // The list shown to the user merges local cache (fast first paint) with
  // server rows (authoritative). Server rows win on conflict. The ACTIVE
  // document is always present (appended if the server list somehow omits
  // it) so the user can never strand themselves on an unlisted doc — the
  // round-2 audit hit exactly that after creating a second document.
  const shownDocs: LocalDoc[] = useMemo(() => {
    const seen = new Set<string>();
    const merged: LocalDoc[] = [];
    for (const d of docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      merged.push({ id: d.id, name: d.name, updatedAt: d.updatedAt });
    }
    for (const d of localDocs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      merged.push(d);
    }
    if (!seen.has(documentId)) {
      merged.push({ id: documentId, name: document?.name ?? documentId, updatedAt: '' });
    }
    return merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [docs, localDocs, documentId, document?.name]);

  // Active document's display name. Prefer the merged list's entry for the
  // CURRENT id: store.init() re-keys the previous document when switching
  // (store keeps the old name until the new snapshot lands), which made the
  // header show the PREVIOUS document's name right after a switch — the
  // round-2 audit's "stale switcher label" bug.
  const activeName = shownDocs.find((d) => d.id === documentId)?.name ?? document?.name ?? documentId;

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name) {
      toast.message('Name required');
      return;
    }
    // D5 (2026-09-05 depth pass): creating a document mid-run calls init(),
    // which ABORTS an in-flight HTTP-fallback run (C4) — same family as the
    // C5 newSession guard. Gate BEFORE the POST so no orphan rows appear.
    if (useCanvasStore.getState().agentBusy) {
      toast.warning('Agent is running', {
        description: `${BUSY_LOCK_HINT} before creating a new document — switching canvases would abandon the run.`,
      });
      return;
    }
    // Generate a safe id from the name (slug-style). If the slug is empty,
    // fall back to a cuid-like timestamp+random id.
    const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    const id = slug || `doc-${Date.now().toString(36)}`;
    const doc = await createServerDocument({ id, name });
    if (!doc) {
      toast.error('Failed to create document', { description: 'A document with that id may already exist.' });
      return;
    }
    init(id);
    // init() re-keys the previous document — set the new name immediately so
    // the header never flashes the old document's title.
    setDocumentName(name);
    setCreateOpen(false);
    setCreateName('');
    toast.success(`Created "${name}"`, { description: 'Switched to the new document.' });
    void refresh();
  };

  const handleRename = async () => {
    if (!renameId || !renameValue.trim()) return;
    const updated = await updateServerDocument(renameId, { name: renameValue.trim() });
    if (!updated) {
      toast.error('Rename failed');
      return;
    }
    if (renameId === documentId) {
      setDocumentName(renameValue.trim());
    }
    setRenameId(null);
    setRenameValue('');
    void refresh();
    toast.success('Document renamed');
  };

  const handleDelete = async (id: string, name: string) => {
    // D5: deleting the ACTIVE document mid-run destroys the sessions /
    // snapshots / canvas a server-side run is still writing into — the run's
    // late patches + turn_end then land on a dead id. Non-active documents
    // are safe (the run never touches them).
    if (id === documentId && useCanvasStore.getState().agentBusy) {
      toast.warning('Agent is running', {
        description: `${BUSY_LOCK_HINT} — deleting this canvas would destroy the run's history.`,
      });
      return;
    }
    if (!confirm(`Delete document "${name}"? This also deletes every session, snapshot, and canvas element on it.`)) return;
    const ok = await deleteServerDocument(id);
    if (!ok) {
      toast.error('Delete failed');
      return;
    }
    // If we deleted the active document, fall back to 'demo'.
    if (id === documentId) {
      init('demo');
    }
    void refresh();
    toast.success(`Deleted "${name}"`);
  };

  const switchDoc = (id: string) => {
    if (id === documentId) {
      setOpen(false);
      return;
    }
    init(id);
    // Same stale-label fix as handleCreate: seed the store with the known
    // name of the target document so the header updates immediately.
    const known = shownDocs.find((d) => d.id === id)?.name;
    if (known) setDocumentName(known);
    setOpen(false);
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1.5 h-7 px-2 rounded-md text-[12px] font-medium ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring max-w-[200px]"
            title="Switch document"
          >
            <FileText className="h-3.5 w-3.5 ac-text-3 flex-shrink-0" />
            <span className="truncate">{activeName}</span>
            <ChevronDown className="h-3 w-3 ac-text-4 flex-shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="text-[11px] min-w-[220px]">
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide ac-text-4">
            Documents
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {shownDocs.length === 0 && (
            <div className="px-2 py-3 text-[11px] ac-text-4 text-center">
              No documents yet. Create one below.
            </div>
          )}
          {shownDocs.map((d) => (
            <DropdownMenuItem
              key={d.id}
              className={`flex items-center gap-1.5 py-1.5 ${d.id === documentId ? 'ac-surface-1' : ''}`}
              onClick={() => switchDoc(d.id)}
            >
              <FileText className="h-3 w-3 ac-text-4 flex-shrink-0" />
              <span className="truncate flex-1">{d.name}</span>
              {d.id === documentId && (
                <span className="text-[9px] ac-status-success px-1 rounded font-medium">active</span>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={`py-1.5 ${agentBusy ? 'ac-busy' : ''}`}
            disabled={agentBusy}
            title={agentBusy ? BUSY_LOCK_HINT : 'Create a separate canvas'}
            onClick={() => { setCreateOpen(true); setOpen(false); }}
          >
            <FilePlus2 className="h-3 w-3 mr-2" /> New document…
          </DropdownMenuItem>
          {/* UI-audit round 2: Rename is available for EVERY document,
              including the seed 'demo' doc — round 1 removed the header's
              doc-name input AND the switcher hid Rename for 'demo', which
              together made the seed document impossible to rename (HIGH
              regression found by the round-2 audit). Delete stays gated:
              'demo' is the boot fallback id and deleting it is the one
              genuinely destructive foot-gun. */}
          <DropdownMenuItem
            className="py-1.5"
            onClick={() => { setRenameId(documentId); setRenameValue(activeName); setOpen(false); }}
          >
            <Pencil className="h-3 w-3 mr-2" /> Rename current…
          </DropdownMenuItem>
          {documentId !== 'demo' && (
            <DropdownMenuItem
              className={`py-1.5 ac-text-danger ${agentBusy ? 'ac-busy' : ''}`}
              disabled={agentBusy}
              title={agentBusy ? BUSY_LOCK_HINT : 'Delete this document and all its history'}
              onClick={() => handleDelete(documentId, activeName)}
            >
              <Trash2 className="h-3 w-3 mr-2" /> Delete current…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm ac-text-1">New document</DialogTitle>
            <DialogDescription className="text-[11px] ac-text-3">
              A separate canvas with its own sessions, snapshots, and chat history. The id is auto-generated from the name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <label htmlFor="doc-name" className="text-[10px] font-medium uppercase tracking-wide ac-text-4">Name</label>
            <Input
              id="doc-name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="e.g. landing-page-v2"
              autoFocus
              className="h-8 text-[12px] ac-border-default"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') setCreateOpen(false);
              }}
            />
          </div>
          <DialogFooter className="gap-1.5">
            <Button size="sm" variant="ghost" className="ac-text-2 hover:ac-text-1" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              className="text-white border-0"
              style={{ backgroundColor: 'var(--ac-accent)' }}
              disabled={!createName.trim()}
              onClick={handleCreate}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameId !== null} onOpenChange={(o) => !o && setRenameId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm ac-text-1">Rename document</DialogTitle>
            <DialogDescription className="text-[11px] ac-text-3">
              The id stays the same; only the display name changes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Document name"
              autoFocus
              className="h-8 text-[12px] ac-border-default"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename();
                if (e.key === 'Escape') setRenameId(null);
              }}
            />
          </div>
          <DialogFooter className="gap-1.5">
            <Button size="sm" variant="ghost" className="ac-text-2 hover:ac-text-1" onClick={() => setRenameId(null)}>Cancel</Button>
            <Button
              size="sm"
              className="text-white border-0"
              style={{ backgroundColor: 'var(--ac-accent)' }}
              disabled={!renameValue.trim()}
              onClick={handleRename}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
