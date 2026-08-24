# P0-01 — Canvas right-click on empty canvas

## Goal
When the user right-clicks the canvas background (no shape under the cursor), show a context menu with: Paste in place, Paste, Select all, Clear selection, Zoom to fit, Zoom to 100%, Zoom in, Zoom out, Capture snapshot, Toggle dark mode, Toggle zen.

## Files to touch
- `src/components/canvas/Canvas.tsx` — add `onContextMenu` handler on the container div; render a `<ContextMenu>` wrapping the canvas backdrop.
- `src/components/ui/context-menu.tsx` — already installed (shadcn), no changes needed.

## Implementation steps
1. Import `ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem` from `@/components/ui/context-menu`.
2. Wrap the canvas root `<div>` in `<ContextMenu>` so right-click anywhere inside the canvas opens the menu.
3. In the `onContextMenu` handler, capture the click position (used for "Paste in place" to know where to drop the pasted shape).
4. Each `ContextMenuItem`'s `onSelect` calls the relevant store action:
   - Paste / Paste in place → `useClipboard().paste({ position: canvasCoords })`
   - Select all → `select(allShapeIds)`
   - Clear selection → `select([])`
   - Zoom to fit / 100% / in / out → `setViewport(...)`
   - Capture snapshot → `captureSnapshot(documentId)`
   - Toggle dark mode → `useTheme().toggle()`
   - Toggle zen → `toggleZen()`
5. Call `e.preventDefault()` to suppress the browser default context menu.

## Tests
- `tests/unit/Canvas.test.tsx` (new) — render `<Canvas>` with an empty document, simulate right-click on the backdrop, assert all 11 menu items are present.
- Integration test: right-click → click "Select all" → assert `selectedIds` matches all shape ids.

## Acceptance criteria
- [ ] Right-click on empty canvas shows the proposed 11-item menu.
- [ ] Browser default context menu is suppressed.
- [ ] Each menu item fires the correct patch / store action.
- [ ] No regression in existing left-click / drag / wheel behavior.
