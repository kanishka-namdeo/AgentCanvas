# P0-06 — Duplicate shortcut (⌘D)

## Goal
Wire `⌘D` to duplicate the current selection (offset +24px, matching the existing Properties-panel Duplicate button).

## Files to touch
- `src/app/page.tsx` — extend the keydown handler.

## Implementation steps
1. In the keydown handler, add:
   ```ts
   if ((e.metaKey || e.ctrlKey) && e.key === 'd' && !e.shiftKey) {
     e.preventDefault();
     if (selectedIds.length > 0) {
       sendPatch({ op: 'duplicate', shapeIds: selectedIds, summary: `Duplicated ${selectedIds.length} shape(s)` });
     }
     return;
   }
   ```
2. Guard against editable targets.

## Tests
- Extend `tests/integration/keyboard-shortcuts.test.ts` with a ⌘D case.

## Acceptance criteria
- [ ] ⌘D with shapes selected emits `op: 'duplicate'`.
- [ ] ⌘D with no selection is a no-op.
- [ ] Doesn't fire when typing in an input.
