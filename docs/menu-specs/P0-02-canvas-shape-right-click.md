# P0-02 — Canvas right-click on a single shape

## Goal
When the user right-clicks a single selected shape on the canvas, show a context menu with: Cut, Copy, Paste, Paste in place, Duplicate here, Bring forward / to front / Send backward / to back, Group, Ungroup (if group), Lock, Hide, Create component, Create instance, Copy as ▶ (submenu: HTML/React/Tailwind/SVG), Export ▶ (submenu: PNG/SVG/.pen), Add comment, Inspect properties.

## Files to touch
- `src/components/canvas/Canvas.tsx` — wrap `ShapeRenderer` in `<ContextMenu>`; choose menu variant by selection size + shape type.
- `src/components/ui/context-menu.tsx` — already installed; may need `ContextMenuSub` / `ContextMenuSubTrigger` / `ContextMenuSubContent` for submenus (verify these are exported).

## Implementation steps
1. In `Canvas.tsx`, import the full context-menu primitive set (including `ContextMenuSub*` if available).
2. Wrap each `<ShapeRenderer>` instance in a `<ContextMenu>` whose trigger is the shape's `<g>` wrapper.
3. Use a `menuVariant` computed from `selectedIds.length` (1 vs many) and the right-clicked shape's `type` (frame/group vs leaf) to choose between Menu 1B, 1C, 1D.
4. Each menu item's `onSelect` emits the corresponding patch via `useCanvasStore(s => s.sendPatch)` or calls a higher-level helper that wraps the patch.
5. For "Copy as" / "Export" submenus, reuse the existing `pen_copy_as_code` / `pen_export_*` logic (extract into shared helpers in `src/lib/canvas/clipboard.ts`).

## Tests
- Render a single shape; right-click; assert all 17 top-level items present.
- Right-click a group shape; assert "Ungroup" item is enabled (not hidden).
- Right-click a frame shape; assert "Mark as slot" item appears (per P0-11 spec).

## Acceptance criteria
- [ ] Right-click on a single shape shows the 17-item menu.
- [ ] Menu items that don't apply (e.g. Ungroup on a leaf) are hidden, not disabled.
- [ ] Submenus (Copy as, Export) open on hover.
- [ ] Each item fires the correct patch.
