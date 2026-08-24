# P0-03 — Clipboard support (⌘C/V/X/A + useClipboard hook)

## Goal
Implement a clipboard system that carries shape payloads across copy/paste operations. Wire ⌘C / V / X / A keyboard shortcuts. Support "Paste in place" (paste at the same coords as the source) vs "Paste" (paste at cursor or with +24 offset).

## Files to touch
- `src/hooks/use-clipboard.ts` — **new** hook. Wraps `navigator.clipboard.writeText` / `readText`. Stores typed JSON payloads `{ kind: 'shape'|'color'|'value'|'constraints', data: any }` in localStorage as a fallback when clipboard API is unavailable.
- `src/app/page.tsx` — wire ⌘C, ⌘V, ⌘X, ⌘A in the existing keydown handler.
- `src/lib/canvas/clipboard.ts` — **new** module. Pure functions: `serializeShapes(shapes): string`, `deserializeShapes(json): Shape[]`, `offsetShapes(shapes, dx, dy): Shape[]`.

## Implementation steps
1. Create `src/lib/canvas/clipboard.ts` with pure serialization + offset helpers. These are browser-safe and unit-testable.
2. Create `src/hooks/use-clipboard.ts` that:
   - Reads/writes a typed payload via `navigator.clipboard.writeText(JSON.stringify(payload))`.
   - Falls back to a `useLocalStorage` key `ac:clipboard` if `navigator.clipboard` is unavailable (e.g. insecure context).
   - Exposes `copy(shapes)`, `paste(opts?)`, `cut(shapes)`, `selectAll()`.
3. In `page.tsx` keydown handler, add:
   - `Cmd+C` → `clipboard.copy(selectedShapes)`
   - `Cmd+V` → `clipboard.paste({ position: 'cursor' | 'in-place' })`
   - `Cmd+X` → `clipboard.cut(selectedShapes)` (copy + delete)
   - `Cmd+A` → `select(shapes.map(s => s.id))`
4. Each paste op emits an `op: 'bulk_add'` patch with offset shapes (+24 default, or 0 for paste-in-place).
5. Make sure to call `e.preventDefault()` to suppress the browser's default clipboard behavior.

## Tests
- `tests/unit/clipboard.test.ts` (new) — test `serializeShapes` / `deserializeShapes` / `offsetShapes`.
- `tests/unit/use-clipboard.test.tsx` (new) — render a test component using `useClipboard`, simulate copy/paste, assert the patch is emitted.
- `tests/integration/pipeline.test.ts` — extend with a clipboard round-trip test (copy → clear → paste → assert shapes restored).

## Acceptance criteria
- [ ] ⌘C copies selected shape(s) to clipboard.
- [ ] ⌘V pastes with +24 offset.
- [ ] ⌘⇧V pastes in place (0 offset).
- [ ] ⌘X copies then deletes.
- [ ] ⌘A selects all shapes.
- [ ] Clipboard survives page reload (localStorage fallback).
- [ ] No regression in existing ⌘Z, ⌘K, etc. shortcuts.
