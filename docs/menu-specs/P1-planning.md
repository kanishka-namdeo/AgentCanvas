# P1 — High-Value Items (Planning Document)

This document captures the 18 P1-tier items as planning artifacts. Each item will be promoted to a full spec when its sprint starts.

## P1-13 — Top-level menu bar
Wire the already-installed `shadcn menubar.tsx` primitive into the top header. Render six menus: File, Edit, View, Insert, Object, Help. Each dropdown lists items with keyboard shortcut hints. Collapses to a hamburger below 1024px viewport.
**Effort:** 5 SP · **Impact:** 5/5

## P1-14 — Command palette action commands + `>` prefix + recents
Extend `CommandPalette.tsx` to accept a `>` prefix that switches to command-mode. Add 4 command categories: action, edit, nav, settings. Add a "Recently used" section at the top (last 5 commands, persisted in localStorage).
**Effort:** 5 SP · **Impact:** 4/5

## P1-15 — Properties panel right-click on color swatch
Wrap each `<input type="color">` in `<ContextMenu>`. Items: Copy color, Paste color, Copy as hex/rgba/hsl, Save as token, Bind to existing token ▶ submenu.
**Effort:** 2 SP · **Impact:** 4/5

## P1-16 — Properties panel right-click on numeric input
Wrap each numeric `<Input type="number">` in `<ContextMenu>`. Items: Copy value, Paste value, Reset to default, Set to 0.
**Effort:** 1 SP · **Impact:** 3/5

## P1-17 — Scrub on numeric inputs (useScrub hook)
New hook `src/hooks/use-scrub.ts`. On `onPointerDown`, calls `Element.requestPointerLock()`; listens to `mousemove`; adjusts the value by `movementX * step`; Shift = 10× speed. On `pointerup`, exits pointer lock and emits a single `op: 'update'` patch with the final value. Attach to every numeric Input in `PropertiesPanel.tsx`.
**Effort:** 3 SP · **Impact:** 5/5

## P1-18 — Shift-constrain on resize
In `Canvas.tsx` resize handler, when `e.shiftKey` is true during the resize drag, lock the aspect ratio to the original shape's `width / height` ratio. Apply the larger delta (width or height) and compute the other dimension from the ratio.
**Effort:** 1 SP · **Impact:** 4/5

## P1-19 — Constraints picker right-click
Wrap the Constraints `<Select>` in `<ContextMenu>`. Items: Reset to defaults, Copy constraints, Paste constraints.
**Effort:** 1 SP · **Impact:** 2/5

## P1-20 — Session row right-click (5 new items)
Extend the existing `⋯` dropdown (or add a parallel right-click menu) with: Duplicate session, Export as JSON, Export as Markdown, Copy prompt summary, Mark as template.
**Effort:** 2 SP · **Impact:** 4/5

## P1-21 — Run card right-click (7 items)
Add a right-click menu to each `RunCard` in `RunHistoryPanel.tsx`. Items: Expand/Collapse, Restore run, Fork from here, Copy prompt, Copy all tool calls as JSON, Export run as Markdown, Delete run.
**Effort:** 2 SP · **Impact:** 3/5

## P1-22 — Snapshot card right-click (5 new items)
Extend the existing inline buttons with a right-click menu. New items: Rename snapshot, Delete snapshot, Export as .pen, Copy as JSON, Set as current.
**Effort:** 2 SP · **Impact:** 3/5

## P1-23 — Pen / path tool shortcut (P) + Auto-layout (A)
Wire `P` to switch to a "pending path" mode (click-to-place points; Enter to commit). Wire `A` to apply auto-layout to the currently selected frame (if any).
**Effort:** 1 SP · **Impact:** 3/5

## P1-24 — Nudge shortcuts (arrows, ⇧+arrows)
Wire ↑↓←→ to nudge the current selection by 1px. Wire ⇧+arrow to nudge by 10px. Each nudge emits an `op: 'update'` patch with the new x/y. Guard against editable targets.
**Effort:** 1 SP · **Impact:** 4/5

## P1-25 — Zoom-to-fit (⌘0) + zoom-to-100% (⌘1) + panel-toggle rebind
Rebind existing ⌘1 / ⌘2 (panel toggles) to ⌘⇧1 / ⌘⇧2. Wire ⌘0 to "zoom to fit" (compute bounding box of all shapes + scale viewport to fit). Wire ⌘1 to "zoom to 100%" (viewport.zoom = 1, centered on selection or first shape).
**Effort:** 2 SP · **Impact:** 4/5

## P1-26 — Command palette navigation + settings commands
Add navigation commands (`> go to layer "X"`, `> zoom to fit`, `> focus next shape`) and settings commands (`> open settings → agent`, etc.) to the command palette.
**Effort:** 3 SP · **Impact:** 3/5

## P1-27 — Agent panel right-click on user message
Wrap user message bubbles in `<ContextMenu>`. Items: Copy prompt, Edit & resend, Fork from here (existing as hover), Pin to top, Delete.
**Effort:** 2 SP · **Impact:** 3/5

## P1-28 — Agent panel right-click on assistant message
Wrap assistant message bubbles in `<ContextMenu>`. Items: Copy message, Regenerate, Branch from here, Stop (during stream), Replay tool calls, Pin to top.
**Effort:** 2 SP · **Impact:** 3/5

## P1-29 — Agent panel right-click on tool-call card
Wrap tool-call cards in `<ContextMenu>`. Items: Copy args (as JSON), Replay tool call, Pin to top, View raw output, Convert to user prompt, Inspect tool spec.
**Effort:** 2 SP · **Impact:** 3/5

## P1-30 — Keyboard shortcut cheat sheet (⌘/)
Build a modal that lists every wired keyboard shortcut, grouped by tier. Searchable. Opens via ⌘/. Mirrors Figma's Ctrl+Shift+? cheat sheet.
**Effort:** 2 SP · **Impact:** 3/5

## Conflict resolution notes
- ⌘1 / ⌘2 currently toggle left / right panels. Figma uses these for zoom. We rebind to ⌘⇧1 / ⌘⇧2 and free ⌘1 / ⌘2 for zoom.
- Add a "Legacy key bindings" toggle in Settings → Shortcuts for users with existing muscle memory.
- Track this in P1-25.
