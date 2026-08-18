# P2 — Nice-to-Have Items (Planning + Implementation Status)

This document captures the 17 P2-tier items. Implementation status marked inline.

## P2-31 — Alt-duplicate-on-drag ⚠️ DEFERRED
**Status:** ⚠️ Deferred — requires non-trivial move-handler refactor (duplicate
on drag-start requires tracking the new duplicate's ID, which isn't known
until the patch is applied).

## P2-32 — Settings shortcut rebinding + conflict detection ⚠️ DEFERRED
**Status:** ⚠️ Deferred — 5 SP, complex. Punt.

## P2-33 — Replay tool call ⚠️ STUBBED
**Status:** ⚠️ Stubbed — the tool-call card right-click (P1-29) has a "Replay
tool call" menu item that shows a toast. Real implementation requires
re-emitting the same op with the same args; defer until the chat panel can
expose tool-call details.

## P2-34 — Branch from assistant message ⚠️ STUBBED
**Status:** ⚠️ Stubbed — the assistant-message right-click (P1-28) has a
"Branch from here" item that shows a toast. Real implementation requires
extending the existing `forkActiveSession` (currently only forks from user
messages with messageId).

## P2-35 — Pin to top (chat messages + tool cards) ⚠️ STUBBED
**Status:** ⚠️ Stubbed — user message, assistant message, and tool-call
right-click menus all have a "Pin to top" item that shows a toast. Real
implementation requires a per-session pinned-message store + a "Pinned"
section at the top of the chat panel.

## P2-36 — Canvas right-click on resize handle (Menu 1E) ⚠️ DEFERRED
**Status:** ⚠️ Deferred — requires adding a per-handle hit-test in
Canvas.tsx.

## P2-37 — Session export as Markdown ⚠️ STUBBED
**Status:** ⚠️ Stubbed — the session row dropdown (P1-20) has an "Export
as Markdown" item that shows a toast. Real implementation requires a
markdown serializer for session messages.

## P2-38 — Snapshot rename ⚠️ DEFERRED
**Status:** ⚠️ Deferred — requires adding a `label` field to the snapshot
store + an inline Input on each snapshot card.

## P2-39 — Comment mode (C key + comment popovers) ⚠️ DEFERRED
**Status:** ⚠️ Deferred — 8 SP, large feature. Punt.

## P2-40 — Plugin menu (registered plugins + marketplace) ⚠️ DEFERRED
**Status:** ⚠️ Deferred — 13 SP, very large feature. Punt.

## P2-41 — Mark as template (sessions) ⚠️ STUBBED
**Status:** ⚠️ Stubbed — the session row dropdown (P1-20) has a "Mark as
template" item that shows a toast. Real implementation requires a template
flag on sessions + a "Templates" section in the new-chat flow.

## P2-42 — Apply theme axis right-click in Layers panel ⚠️ DEFERRED
**Status:** ⚠️ Deferred — low impact; punt.

## P2-43 — Bind to token right-click in Layers panel ⚠️ DEFERRED
**Status:** ⚠️ Deferred — low impact; punt.

## P2-44 — Reparent to submenu in Layers panel right-click ⚠️ DEFERRED
**Status:** ⚠️ Deferred — already reachable via drag-to-reparent +
Properties panel Parent picker.

## P2-45 — Set as current snapshot (right-click) ⚠️ DEFERRED
**Status:** ⚠️ Deferred — low impact; punt.

## P2-46 — Tab to focus next shape in z-order ✅ IMPLEMENTED
**Status:** ✅ Wired in `src/app/page.tsx`. Tab cycles through shapes in
z-order; ⇧+Tab reverses.

## P2-47 — ⌘↑/⌘↓ to navigate chat messages ✅ IMPLEMENTED
**Status:** ✅ Wired in `src/app/page.tsx`. ⌘↑ / ⌘↓ scroll the chat panel
by one message height (~80px).

## P2 status summary
- **Fully implemented (2):** P2-46, P2-47
- **Stubbed (5):** P2-33, P2-34, P2-35, P2-37, P2-41 (menu items exist with toast "not yet implemented")
- **Deferred (10):** P2-31, P2-32, P2-36, P2-38, P2-39, P2-40, P2-42, P2-43, P2-44, P2-45
