# P0-12 — Layers panel header (Expand-all / Search)

## Goal
Add three controls to the Layers panel header: an Expand-all button, a Collapse-all button, and a search-by-name input that filters the displayed layers in real time.

## Files to touch
- `src/components/canvas/LayersPanel.tsx` — add a header toolbar row above the scroll area.

## Implementation steps
1. In `LayersPanel.tsx`, add a small toolbar row inside the panel header. Use:
   - `<Input placeholder="Search layers…">` with a `useState` for the query.
   - Two `<Button variant="ghost" size="icon">` buttons with `ChevronsDownUp` (collapse-all) and `ChevronsUpDown` (expand-all) icons from `lucide-react`.
2. Filter the displayed shapes by the search query: a shape matches if its `name` contains the query (case-insensitive) OR any descendant matches. Matching shapes and their ancestors are shown; non-matching siblings are hidden.
3. Expand-all sets `collapsed = new Set()` (everything expanded). Collapse-all sets `collapsed = new Set(allContainerIds)` (everything collapsed).
4. Persist the search query to a per-document localStorage key `ac:layers:search:<docId>` (optional — session-only is also fine).

## Tests
- `tests/unit/LayersPanel.test.tsx` — render with a tree; type in the search; assert non-matching shapes are hidden.
- Click Expand-all; assert all containers are expanded. Click Collapse-all; assert all are collapsed.

## Acceptance criteria
- [ ] Search input filters layers by name (case-insensitive substring).
- [ ] Expand-all button expands every container.
- [ ] Collapse-all button collapses every container.
- [ ] Search query + expand/collapse state survive panel re-renders.
- [ ] No regression in the existing per-row expand/collapse chevrons.
