# P0-07 — Z-order shortcuts (⌘] / [ / ⌘⇧] / [)

## Goal
Wire the four z-order shortcuts: ⌘] bring forward, ⌘[ send backward, ⌘⇧] bring to front, ⌘⇧[ send to back.

## Files to touch
- `src/app/page.tsx` — extend the keydown handler.

## Implementation steps
1. In the keydown handler, add four bindings:
   ```ts
   const meta = e.metaKey || e.ctrlKey;
   if (meta && (e.key === ']' || e.key === '[')) {
     e.preventDefault();
     if (selectedIds.length === 0) return;
     const zorderKind = e.shiftKey
       ? (e.key === ']' ? 'front' : 'back')
       : (e.key === ']' ? 'forward' : 'backward');
     sendPatch({ op: 'zorder', shapeIds: selectedIds, zorderKind, summary: `Z-order: ${zorderKind}` });
     return;
   }
   ```
2. Guard against editable targets.

## Tests
- Extend `tests/integration/keyboard-shortcuts.test.ts` with 4 z-order cases.

## Acceptance criteria
- [ ] ⌘] emits `op: 'zorder'` with `zorderKind: 'forward'`.
- [ ] ⌘[ emits `op: 'zorder'` with `zorderKind: 'backward'`.
- [ ] ⌘⇧] emits `op: 'zorder'` with `zorderKind: 'front'`.
- [ ] ⌘⇧[ emits `op: 'zorder'` with `zorderKind: 'back'`.
- [ ] No-op when nothing is selected.
- [ ] Doesn't fire when typing in an input.
