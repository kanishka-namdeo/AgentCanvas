'use client';

// ShortcutsReference — the ONE registry-driven shortcut table renderer.
//
// Both help surfaces render this component (interaction-consistency pass):
//   - KeyboardShortcutsDialog (⌘/) — with the search filter;
//   - SettingsDialog's Shortcuts section — plain, no filter.
// The old Settings hand-maintained table had drifted from reality ("Wheel =
// Zoom canvas" while trackpad wheel pans, stale ⌘1/⌘2 labels, none of the
// Phase 7 chords) — violating the registry's single-source-of-truth
// contract (shortcuts.ts: the help can never drift from the keymap).

import { Badge } from '@/components/ui/badge';
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

export function ShortcutsReference({ query = '' }: { query?: string }) {
  const platform = currentPlatform();

  // No manual useMemo here (react-compiler preserve-manual-memoization):
  // the filter is a ~60-item scan over a module constant — the compiler
  // memoizes what it can on its own, and both host surfaces re-render rarely.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? SHORTCUTS.filter((s) =>
        s.action.toLowerCase().includes(q) ||
        s.label.toLowerCase().includes(q) ||
        s.mac.toLowerCase().includes(q) ||
        s.win.toLowerCase().includes(q) ||
        s.scope.toLowerCase().includes(q)
      )
    : SHORTCUTS;
  const groups = groupShortcutsForDialog(filtered);

  if (groups.length === 0) {
    return (
      <div className="text-center py-8 ac-text-4 text-xs">
        No shortcuts match "{query}".
      </div>
    );
  }

  return (
    <>
      {groups.map((group) => (
        <div key={group.scope} className="mb-4">
          <div className="ac-label mb-1.5">{group.title}</div>
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
                <kbd className="ac-kbd flex-shrink-0">
                  {chordFor(s, platform)}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
