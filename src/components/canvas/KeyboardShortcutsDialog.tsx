'use client';

// KeyboardShortcutsDialog — modal that lists every wired keyboard shortcut.
//
// REGENERATED FROM THE REGISTRY (spec Phase 7): the table is gone; the dialog
// renders `SHORTCUTS` from lib/canvas/shortcuts.ts — the same module the
// keymap dispatchers (page.tsx + Canvas.tsx) match against — so the help can
// never drift from reality. Grouping comes from `groupShortcutsForDialog()`
// (canvas / layers / application scopes); the search filter stays.

import { useState, useMemo } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Search } from 'lucide-react';
import {
  SHORTCUTS,
  chordFor,
  currentPlatform,
  groupShortcutsForDialog,
  type ShortcutDef,
} from '@/lib/canvas/shortcuts';

const SCOPE_COLORS: Record<ShortcutDef['scope'], string> = {
  canvas: 'ac-status-info',
  layers: 'ac-status-warning',
  app: 'ac-status-neutral',
};

export function KeyboardShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [query, setQuery] = useState('');
  const platform = currentPlatform();

  const filtered = useMemo(() => {
    if (!query.trim()) return SHORTCUTS;
    const q = query.toLowerCase();
    return SHORTCUTS.filter((s) =>
      s.action.toLowerCase().includes(q) ||
      s.label.toLowerCase().includes(q) ||
      s.mac.toLowerCase().includes(q) ||
      s.win.toLowerCase().includes(q) ||
      s.scope.toLowerCase().includes(q)
    );
  }, [query]);

  // Group by scope for display (registry order preserved within groups).
  const groups = useMemo(() => groupShortcutsForDialog(filtered), [filtered]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Every wired keyboard shortcut, straight from the shortcut registry. Type to filter.
            Press ⌘/ to toggle this dialog.
          </DialogDescription>
        </DialogHeader>
        <div className="relative mb-3">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 ac-text-4" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter shortcuts…"
            className="h-7 text-xs pl-7"
            autoFocus
          />
        </div>
        <div className="overflow-y-auto flex-1 -mx-1 px-1">
          {groups.length === 0 ? (
            <div className="text-center py-8 ac-text-4 text-xs">No shortcuts match "{query}".</div>
          ) : (
            groups.map((group) => (
              <div key={group.scope} className="mb-4">
                <div className="text-[10px] uppercase tracking-wide ac-text-4 font-semibold mb-1.5">{group.title}</div>
                <div className="space-y-0.5">
                  {group.entries.map((s) => (
                    <div key={s.action} className="flex items-center justify-between text-xs px-2 py-1 rounded hover:ac-surface-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="ac-text-2 truncate" title={s.description ?? s.label}>{s.label}</span>
                        <Badge variant="outline" className={`text-[9px] h-3.5 px-1 py-0 font-normal flex-shrink-0 ${SCOPE_COLORS[s.scope]}`}>
                          {s.scope}
                        </Badge>
                        {s.also && s.also.length > 0 && (
                          <span className="text-[9px] ac-text-4 font-mono flex-shrink-0">also {s.also.join(' / ')}</span>
                        )}
                      </div>
                      <kbd className="font-mono text-[10px] ac-text-3 ac-surface-2 px-1.5 py-0.5 rounded flex-shrink-0">
                        {chordFor(s, platform)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
