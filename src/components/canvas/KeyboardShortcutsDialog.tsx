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
import { Search } from 'lucide-react';
import { platformChord } from '@/lib/canvas/shortcuts';
import { ShortcutsReference } from './ShortcutsReference';

export function KeyboardShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [query, setQuery] = useState('');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Every wired keyboard shortcut, straight from the shortcut registry. Type to filter.
            Press {platformChord('⌘/')} to toggle this dialog.
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
          <ShortcutsReference query={query} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
