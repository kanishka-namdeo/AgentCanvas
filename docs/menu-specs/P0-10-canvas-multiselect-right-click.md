# P0-10 — Canvas right-click on multi-selection

## Goal
When the user right-clicks inside the bounding box of a multi-shape selection, show a context menu tuned for multi-selection ops: Group, Ungroup (if all groups), Cut/Copy/Paste/Paste-in-place, Align ▶ submenu, Distribute ▶ submenu, Bring forward / to front / backward / to back, Create component from selection, Apply auto layout to selection.

## Files to touch
- `src/components/canvas/Canvas.tsx` — share menu-variant logic with P0-02.

## Implementation steps
1. Reuse the menu-variant dispatcher from P0-02. When `selectedIds.length >= 2`, render the multi-selection menu.
2. The Align / Distribute submenus reuse the existing `alignSelection` helper from PropertiesPanel.
3. "Create component from selection" wraps the selection in a group first (via `op: 'group'`), then marks the group as reusable (via `op: 'update'` with `reusable: true`).
4. "Apply auto layout to selection" wraps the selection in a frame first, then applies auto-layout (via `op: 'update'` with `autoLayout`).

## Tests
- Render with 2+ shapes selected, right-click, assert the multi-selection items appear.
- Verify "Create component from selection" emits a group-then-update sequence.

## Acceptance criteria
- [ ] Right-click on 2+ selected shapes shows the multi-selection menu (not the single-shape menu).
- [ ] Align / Distribute submenus open.
- [ ] Each item fires the correct patch(es).
