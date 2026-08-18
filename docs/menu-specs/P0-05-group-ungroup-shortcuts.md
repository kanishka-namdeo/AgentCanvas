# P0-05 — Group / Ungroup shortcuts (⌘G / ⌘⇧G)

## Goal
Wire `⌘G` to group the current selection and `⌘⇧G` to ungroup any selected groups.

## Files to touch
- `src/app/page.tsx` — extend the existing keydown handler with two new bindings.

## Implementation steps
1. In the keydown handler in `page.tsx`, add:
   ```ts
   if ((e.metaKey || e.ctrlKey) && e.key === 'g' && !e.shiftKey) {
     e.preventDefault();
     if (selectedIds.length >= 2) {
       sendPatch({ op: 'group', shapeIds: selectedIds, summary: `Grouped ${selectedIds.length} shape(s)` });
     }
     return;
   }
   if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'g') {
     e.preventDefault();
     const groups = shapes.filter(s => s.type === 'group' && selectedIds.includes(s.id));
     if (groups.length > 0) {
       sendPatch({ op: 'ungroup', shapeIds: groups.map(g => g.id), summary: `Ungrouped ${groups.length} group(s)` });
     }
     return;
   }
   ```
2. Guard against editable targets (input / textarea / contenteditable) — skip the shortcut when the user is typing.
3. Group only fires when 2+ shapes are selected. Ungroup only fires when at least one selected shape is a group.

## Tests
- `tests/integration/keyboard-shortcuts.test.ts` (new) — drive `page.tsx`'s keydown handler with simulated ⌘G / ⌘⇧G events, assert the correct patches are emitted.

## Acceptance criteria
- [ ] ⌘G with 2+ shapes selected emits `op: 'group'`.
- [ ] ⌘G with 0-1 shapes selected is a no-op.
- [ ] ⌘⇧G with a group selected emits `op: 'ungroup'`.
- [ ] ⌘⇧G without a group selected is a no-op.
- [ ] Shortcuts don't fire when typing in an input.
