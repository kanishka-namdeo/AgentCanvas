# P0-08 — Shape-tool shortcuts (R / O / T / L / F)

## Goal
Wire R / O / T / L / F to switch to the rectangle / ellipse / text / line / frame tool respectively. Following the Excalidraw pattern, the tool mode shows a click-to-place cursor on the canvas; the next click drops the shape at the click position.

## Files to touch
- `src/app/page.tsx` — add 5 new keydown bindings.
- `src/lib/canvas/store.ts` — add a `pendingShape: ShapeType | null` field + `setPendingShape(type)` action + a `commitPendingShapeAt(x, y)` action.
- `src/components/canvas/Canvas.tsx` — when `pendingShape` is set, change cursor to crosshair and on canvas click, drop the shape at the click coords.

## Implementation steps
1. Extend `CanvasStore` interface with `pendingShape: ShapeType | null`.
2. Add `setPendingShape(type: ShapeType | null)` action that sets the field and clears selection.
3. Add `commitPendingShapeAt(x: number, y: number)` action that emits an `op: 'add'` patch with the pending shape type, x/y from the click, default width/height.
4. In `page.tsx` keydown, add: `r → setPendingShape('rectangle')`, `o → 'ellipse'`, `t → 'text'`, `l → 'line'`, `f → 'frame'`.
5. In `Canvas.tsx`, if `pendingShape` is set:
   - Set cursor to `crosshair`.
   - On canvas click (empty area), call `commitPendingShapeAt(canvasX, canvasY)`.
   - After commit, `pendingShape` is cleared and the new shape is selected.
6. Pressing Escape cancels the pending shape mode.
7. Existing tools (V, H) clear pending shape.

## Tests
- Extend `tests/integration/keyboard-shortcuts.test.ts` with 5 shape-tool cases.
- New `tests/unit/canvas-store.test.ts` cases for `pendingShape` state transitions.

## Acceptance criteria
- [ ] R sets pendingShape = 'rectangle'; cursor changes to crosshair; click on canvas drops a 100×100 rect.
- [ ] O / T / L / F work similarly with default sizes for each type.
- [ ] Escape cancels pending mode.
- [ ] V / H switch to select / pan and cancel pending mode.
- [ ] Default size for text is 100×24; for line is 100×0; for frame is 200×200.
- [ ] After commit, the new shape is selected.
