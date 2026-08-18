# P0-04 — Layers panel expanded context menu (22 items)

## Goal
Grow the Layers panel right-click menu from 3 items (Delete / Duplicate / Rename) to 22 items, grouped by operation type with separators.

## Files to touch
- `src/components/canvas/LayersPanel.tsx` — extend the existing `<ContextMenu>` block with 19 new items + 4 separators.

## Implementation steps
1. The existing `<ContextMenuContent>` already wraps the 3 existing items. Add the new items in this order with `<ContextMenuSeparator>` between groups:
   - Group 1 (clipboard): Cut ⌘X, Copy ⌘C, Paste ⌘V, Paste in place ⌘⇧V, Duplicate here ⌘D
   - Group 2 (z-order): Bring forward ⌘], Bring to front ⌘⇧], Send backward ⌘[, Send to back ⌘⇧[
   - Group 3 (structure): Group ⌘G, Ungroup ⌘⇧G (only if shape is group)
   - Group 4 (visibility): Lock ⌘L, Hide ⌘;
   - Group 5 (components): Create component ⌘⇧C, Create instance, Mark as slot (frames only)
   - Group 6 (export) — submenu: Copy as ▶ (HTML / React / Tailwind / SVG / JSON), Export ▶ (PNG / SVG / .pen)
   - Group 7 (tree): Select all children, Expand all, Collapse all
   - Group 8 (existing): Rename, Delete, Duplicate
2. Each item's `onSelect` emits the corresponding patch via `sendPatch`.
3. Conditional rendering:
   - "Ungroup" only shown when `shape.type === 'group'`.
   - "Mark as slot" only shown when `shape.type === 'frame'`.
   - "Create instance" only shown when `shape.componentId` exists (i.e. shape is a component master).
   - "Select all children" only shown when shape has children (parentId matches any other shape).

## Tests
- `tests/unit/LayersPanel.test.tsx` (new) — render LayersPanel with various shape types, assert the correct items appear / are hidden per type.
- Verify all 22 items fire the correct patch.

## Acceptance criteria
- [ ] Right-click on a leaf shape shows 22 items minus the conditional ones (Ungroup, Mark as slot, Create instance).
- [ ] Right-click on a group shape adds Ungroup.
- [ ] Right-click on a frame adds Mark as slot.
- [ ] Right-click on a component master adds Create instance.
- [ ] All items fire the correct patch via sendPatch.
