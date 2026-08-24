# P0-11 — Canvas right-click on frame/container

## Goal
When the user right-clicks a frame or group shape, show a variant of the single-shape menu with frame-specific items: Paste into, Mark as slot, Apply auto layout, Frame properties, Select all children, Collapse layer subtree.

## Files to touch
- `src/components/canvas/Canvas.tsx` — share menu-variant logic with P0-02.

## Implementation steps
1. Reuse the menu-variant dispatcher from P0-02. When the right-clicked shape's `type === 'frame' || 'group'`, render the frame menu.
2. "Paste into" — if clipboard has a shape, paste it as a child of the right-clicked frame: `op: 'add'` with `parentId: shape.id`.
3. "Mark as slot" — `op: 'mark_slot'` with `shapeId`.
4. "Apply auto layout" — `op: 'update'` with `autoLayout: { direction: 'vertical', gap: 8, padding: 16, alignX: 'center', alignY: 'min' }` (default values; user can fine-tune in Properties).
5. "Frame properties" — focuses the Properties panel and scrolls to the Auto Layout section (requires a small new event the Properties panel listens to).
6. "Select all children" — `select(childIds)`.
7. "Collapse layer subtree" — invokes the Layers panel's collapse action for this shape id (requires a small new event).

## Tests
- Render a frame shape; right-click; assert the 6 frame-specific items appear above the standard single-shape items.

## Acceptance criteria
- [ ] Right-click on a frame shows the frame-specific items (Paste into, Mark as slot, Apply auto layout, Frame properties, Select all children, Collapse layer subtree).
- [ ] Right-click on a group shows the same items minus "Mark as slot" (which is frame-only).
- [ ] Each item fires the correct patch / event.
