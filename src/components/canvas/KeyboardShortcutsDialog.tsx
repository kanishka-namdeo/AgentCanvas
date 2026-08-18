'use client';

// KeyboardShortcutsDialog — modal that lists every wired keyboard shortcut,
// grouped by tier. Searchable. Opens via ⌘/ (mirrors Figma's Ctrl+Shift+?
// cheat sheet).
//
// P1-30 item from the UI Audit.

import { useState, useMemo } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Search } from 'lucide-react';

interface ShortcutEntry {
  keys: string;
  action: string;
  tier: 'P0' | 'P1' | 'P2' | 'Existing';
  category: string;
}

const SHORTCUTS: ShortcutEntry[] = [
  // === Existing (pre-P0) ===
  { keys: '⌘1', action: 'Toggle left panel', tier: 'Existing', category: 'Panels' },
  { keys: '⌘2', action: 'Toggle right panel', tier: 'Existing', category: 'Panels' },
  { keys: '⌘K', action: 'Open command palette', tier: 'Existing', category: 'Navigation' },
  { keys: '⌘,', action: 'Open settings', tier: 'Existing', category: 'Navigation' },
  { keys: '⌘\\', action: 'Toggle zen / UI mode', tier: 'Existing', category: 'Panels' },
  { keys: '⌘Z', action: 'Undo', tier: 'Existing', category: 'Edit' },
  { keys: '⌘⇧Z', action: 'Redo', tier: 'Existing', category: 'Edit' },
  { keys: 'V', action: 'Select tool', tier: 'Existing', category: 'Tools' },
  { keys: 'H', action: 'Pan tool', tier: 'Existing', category: 'Tools' },
  { keys: 'Space (hold)', action: 'Temporary pan', tier: 'Existing', category: 'Tools' },
  { keys: '⌫ / Delete', action: 'Delete selection', tier: 'Existing', category: 'Edit' },
  { keys: '⎋ (Escape)', action: 'Clear selection / cancel rename', tier: 'Existing', category: 'Edit' },
  { keys: 'Enter', action: 'Send prompt / commit rename', tier: 'Existing', category: 'Chat' },
  { keys: '⇧+Enter', action: 'Newline in chat input', tier: 'Existing', category: 'Chat' },

  // === P0 (must-have — implemented) ===
  { keys: '⌘C', action: 'Copy selected shape(s)', tier: 'P0', category: 'Clipboard' },
  { keys: '⌘V', action: 'Paste with +24 offset', tier: 'P0', category: 'Clipboard' },
  { keys: '⌘⇧V', action: 'Paste in place (0 offset)', tier: 'P0', category: 'Clipboard' },
  { keys: '⌘X', action: 'Cut selected shape(s)', tier: 'P0', category: 'Clipboard' },
  { keys: '⌘A', action: 'Select all shapes', tier: 'P0', category: 'Edit' },
  { keys: '⌘G', action: 'Group selection', tier: 'P0', category: 'Structure' },
  { keys: '⌘⇧G', action: 'Ungroup', tier: 'P0', category: 'Structure' },
  { keys: '⌘D', action: 'Duplicate selection', tier: 'P0', category: 'Edit' },
  { keys: '⌘]', action: 'Bring forward', tier: 'P0', category: 'Z-order' },
  { keys: '⌘⇧]', action: 'Bring to front', tier: 'P0', category: 'Z-order' },
  { keys: '⌘[', action: 'Send backward', tier: 'P0', category: 'Z-order' },
  { keys: '⌘⇧[', action: 'Send to back', tier: 'P0', category: 'Z-order' },
  { keys: 'R', action: 'Rectangle tool (drop at viewport center)', tier: 'P0', category: 'Tools' },
  { keys: 'O', action: 'Ellipse tool', tier: 'P0', category: 'Tools' },
  { keys: 'T', action: 'Text tool', tier: 'P0', category: 'Tools' },
  { keys: 'L', action: 'Line tool', tier: 'P0', category: 'Tools' },
  { keys: 'F', action: 'Frame tool', tier: 'P0', category: 'Tools' },

  // === P1 (high-value — implemented) ===
  { keys: '⌘/', action: 'Open this keyboard shortcuts cheat sheet', tier: 'P1', category: 'Navigation' },
  { keys: '↑ ↓ ← →', action: 'Nudge selection by 1px', tier: 'P1', category: 'Edit' },
  { keys: '⇧+arrow', action: 'Nudge selection by 10px', tier: 'P1', category: 'Edit' },
  { keys: '⇧+drag (resize)', action: 'Constrain aspect ratio during resize', tier: 'P1', category: 'Canvas' },
  { keys: 'Drag on number', action: 'Scrub numeric value (⇧ = 10× speed)', tier: 'P1', category: 'Properties' },
  { keys: 'P', action: 'Pen / path tool (chat-driven)', tier: 'P1', category: 'Tools' },
  { keys: 'A', action: 'Apply auto-layout to selected frame', tier: 'P1', category: 'Tools' },

  // === P2 (nice-to-have) ===
  { keys: '⌥+drag (move)', action: 'Duplicate shape while dragging', tier: 'P2', category: 'Canvas' },
  { keys: '⌘L', action: 'Lock selection', tier: 'P2', category: 'Edit' },
  { keys: '⌘;', action: 'Hide selection', tier: 'P2', category: 'Edit' },
  { keys: '⌘E', action: 'Export as .pen', tier: 'P2', category: 'File' },
  { keys: 'C', action: 'Comment mode (P2 — not yet implemented)', tier: 'P2', category: 'Tools' },
  { keys: 'Tab', action: 'Focus next shape in z-order', tier: 'P2', category: 'Navigation' },
  { keys: '⌘↑ / ⌘↓', action: 'Navigate chat messages', tier: 'P2', category: 'Chat' },
];

const TIER_COLORS: Record<ShortcutEntry['tier'], string> = {
  P0: 'bg-rose-100 text-rose-700 border-rose-200',
  P1: 'bg-amber-100 text-amber-700 border-amber-200',
  P2: 'bg-blue-100 text-blue-700 border-blue-200',
  Existing: 'bg-slate-100 text-slate-700 border-slate-200',
};

export function KeyboardShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return SHORTCUTS;
    const q = query.toLowerCase();
    return SHORTCUTS.filter((s) =>
      s.action.toLowerCase().includes(q) ||
      s.keys.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      s.tier.toLowerCase().includes(q)
    );
  }, [query]);

  // Group by category for display.
  const byCategory = useMemo(() => {
    const m = new Map<string, ShortcutEntry[]>();
    for (const s of filtered) {
      if (!m.has(s.category)) m.set(s.category, []);
      m.get(s.category)!.push(s);
    }
    return [...m.entries()];
  }, [filtered]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Every wired keyboard shortcut, grouped by category. Type to filter.
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
          {byCategory.length === 0 ? (
            <div className="text-center py-8 ac-text-4 text-xs">No shortcuts match "{query}".</div>
          ) : (
            byCategory.map(([cat, entries]) => (
              <div key={cat} className="mb-4">
                <div className="text-[10px] uppercase tracking-wide ac-text-4 font-semibold mb-1.5">{cat}</div>
                <div className="space-y-0.5">
                  {entries.map((s, i) => (
                    <div key={`${cat}-${i}`} className="flex items-center justify-between text-xs px-2 py-1 rounded hover:ac-surface-1">
                      <div className="flex items-center gap-2">
                        <span className="ac-text-2">{s.action}</span>
                        <Badge variant="outline" className={`text-[9px] h-3.5 px-1 py-0 font-normal ${TIER_COLORS[s.tier]}`}>
                          {s.tier}
                        </Badge>
                      </div>
                      <kbd className="font-mono text-[10px] ac-text-3 ac-surface-2 px-1.5 py-0.5 rounded">{s.keys}</kbd>
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
