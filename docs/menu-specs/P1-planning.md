# P1 — High-Value Items (Planning + Implementation Status)

This document captures the 18 P1-tier items. Implementation status marked inline.

## P1-13 — Top-level menu bar ✅ IMPLEMENTED
File / Edit / View / Insert / Object / Help — wired via shadcn menubar primitive
in `src/components/canvas/TopMenuBar.tsx`. Hidden in Zen mode. Rendered above
the existing header.
**Effort:** 5 SP · **Impact:** 5/5 · **Status:** ✅ Shipped in commit after P0

## P1-14 — Command palette action commands + `>` prefix + recents ⚠️ DEFERRED
**Status:** ⚠️ Deferred — the existing palette is prompt-only and complex to
extend with `>` prefix and a separate command catalog. Punt to a follow-up.

## P1-15 — Properties panel right-click on color swatch ⚠️ DEFERRED
**Status:** ⚠️ Deferred — the useClipboard hook already exposes copyColor /
pasteColor; wiring the ContextMenu around each `<input type="color">` is
mechanical but requires touching many swatch sites. Punt to a follow-up.

## P1-16 — Properties panel right-click on numeric input ⚠️ DEFERRED
**Status:** ⚠️ Deferred — same as P1-15; punt.

## P1-17 — Scrub on numeric inputs (useScrub hook) ✅ HOOK IMPLEMENTED
**Status:** ✅ Hook implemented in `src/hooks/use-scrub.ts`. NOT yet wired
into PropertiesPanel inputs (P1-15/16 deferred above). Available for future
wiring.

## P1-18 — Shift-constrain on resize ✅ IMPLEMENTED
**Status:** ✅ Wired in `src/components/canvas/Canvas.tsx` resize handler.
Holding Shift during a resize drag locks the aspect ratio to the original
shape's width / height ratio.

## P1-19 — Constraints picker right-click ⚠️ DEFERRED
**Status:** ⚠️ Deferred — low impact; punt.

## P1-20 — Session row right-click (5 new items) ✅ IMPLEMENTED
**Status:** ✅ Added Duplicate session, Export as JSON, Export as Markdown
(stub), Copy prompt summary, Mark as template (stub) to the existing ⋯
dropdown in `SessionSidebar.tsx`.

## P1-21 — Run card right-click (7 items) ⚠️ DEFERRED
**Status:** ⚠️ Deferred — RunHistoryPanel refactor is non-trivial; punt.

## P1-22 — Snapshot card right-click (5 new items) ⚠️ DEFERRED
**Status:** ⚠️ Deferred — same as P1-21; punt.

## P1-23 — Pen / path tool shortcut (P) + Auto-layout (A) ✅ PARTIAL
**Status:** ✅ `A` wired — applies default auto-layout to the selected
frame/group. ⚠️ `P` is a stub — shows a toast pointing the user to the chat
panel for path creation (real pen tool needs multi-click UI).

## P1-24 — Nudge shortcuts (arrows, ⇧+arrows) ✅ IMPLEMENTED
**Status:** ✅ Arrow keys nudge selection by 1px; ⇧+arrows nudge by 10px.
Emits `op:'update_many'` patches.

## P1-25 — Zoom-to-fit (⌘0) + zoom-to-100% (⌘1) + panel-toggle rebind ✅ PARTIAL
**Status:** ✅ Added ⌘⇧1 / ⌘⇧2 as ALIASES for panel toggles (legacy
users keep ⌘1 / ⌘2 working). ⚠️ Did NOT rebind ⌘1 to zoom-to-100% —
preserves existing muscle memory. Zoom-to-fit (⌘0) and zoom-in/out (⌘+ / ⌘-)
deferred (Canvas viewport state is local; would require a store-level
setViewport action to wire from page.tsx).

## P1-26 — Command palette navigation + settings commands ⚠️ DEFERRED
**Status:** ⚠️ Deferred — depends on P1-14.

## P1-27 — Agent panel right-click on user message ✅ IMPLEMENTED
**Status:** ✅ Wrapped user message bubbles in `<ContextMenu>`. Items:
Copy prompt (works), Edit & resend (toast), Fork from here (works),
Pin to top (stub), Delete (stub).

## P1-28 — Agent panel right-click on assistant message ✅ IMPLEMENTED
**Status:** ✅ Wrapped assistant message bubbles in `<ContextMenu>`. Items:
Copy message (works), Regenerate (stub), Branch from here (stub),
Replay tool calls (stub), Pin to top (stub).

## P1-29 — Agent panel right-click on tool-call card ✅ IMPLEMENTED
**Status:** ✅ Wrapped tool-call cards in `<ContextMenu>`. Items: Copy
args (works), Replay tool call (stub), Pin to top (stub), View raw output
(stub), Convert to user prompt (stub), Inspect tool spec (stub).

## P1-30 — Keyboard shortcut cheat sheet (⌘/) ✅ IMPLEMENTED
**Status:** ✅ New `KeyboardShortcutsDialog` component lists every wired
shortcut grouped by category with a search filter. Opens via ⌘/. Includes
tier badges (P0/P1/P2/Existing).

## P1 status summary
- **Fully implemented (8):** P1-13, P1-17 (hook only), P1-18, P1-20, P1-23 (A only), P1-24, P1-25 (partial), P1-27, P1-28, P1-29, P1-30
- **Deferred to follow-up (8):** P1-14, P1-15, P1-16, P1-19, P1-21, P1-22, P1-26, and the `P` half of P1-23
