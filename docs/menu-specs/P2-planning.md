# P2 — Nice-to-Have Items (Planning Document)

This document captures the 17 P2-tier items as planning artifacts. P2 ships after P1 (roughly 6 weeks after P0 lands).

## P2-31 — Alt-duplicate-on-drag
In `Canvas.tsx` move handler, when `e.altKey` is true during a shape drag, duplicate the shape on pointer-up instead of moving it. The original stays in place; the new shape ends at the cursor position.
**Effort:** 2 SP · **Impact:** 3/5

## P2-32 — Settings shortcut rebinding + conflict detection
Make the Settings → Shortcuts section editable. Add per-binding rebinding with conflict detection (warn if a new binding collides with an existing one). Add a "Reset to default" per binding. Persist to localStorage `ac:shortcuts`.
**Effort:** 5 SP · **Impact:** 3/5

## P2-33 — Replay tool call
Add a "Replay tool call" item to the tool-call card right-click menu. Re-emits the same op with the same args (deterministic). Useful for debugging agent runs.
**Effort:** 3 SP · **Impact:** 3/5

## P2-34 — Branch from assistant message
Extend the Fork button (currently only on user messages) to assistant messages. Branching from an assistant message creates a child session that inherits the canvas state up to that assistant turn.
**Effort:** 2 SP · **Impact:** 2/5

## P2-35 — Pin to top (chat messages + tool cards)
Add a "Pin to top" item to user message, assistant message, and tool-call card right-click menus. Pinned items stay at the top of the chat panel. Stored per-session in localStorage.
**Effort:** 3 SP · **Impact:** 2/5

## P2-36 — Canvas right-click on resize handle (Menu 1E)
Add a small right-click menu when the user right-clicks one of the 8 resize handles. Items: Numeric resize…, Constrain aspect ratio, Set exact size…, Reset to default size.
**Effort:** 2 SP · **Impact:** 2/5

## P2-37 — Session export as Markdown
Add a "Export as Markdown" item to the session right-click menu. Produces a Markdown file with the session title, every user prompt as a heading, and every assistant response + tool call as a code block.
**Effort:** 2 SP · **Impact:** 2/5

## P2-38 — Snapshot rename
Add a "Rename snapshot" item to the snapshot card right-click menu. Inline `Input` like the Layers panel rename. Stored as `snapshot.label` in the session store.
**Effort:** 1 SP · **Impact:** 2/5

## P2-39 — Comment mode (C key + comment popovers)
Add a comment system. Press `C` to enter comment mode; click on the canvas to drop a comment pin at the cursor position. Comments are stored per-document in localStorage. Each comment has a thread (replies).
**Effort:** 8 SP · **Impact:** 3/5

## P2-40 — Plugin menu (registered plugins + marketplace)
Add a plugin system. Plugins are JS modules registered at startup. Surface them via a Plugins top-level menu (between Object and Help) and a "Run plugin…" item in the canvas right-click. Includes a basic marketplace (curated plugin list, install / uninstall).
**Effort:** 13 SP · **Impact:** 3/5

## P2-41 — Mark as template (sessions)
Add a "Mark as template" item to the session right-click menu. Template sessions appear in a "Templates" section at the top of the new-chat flow; selecting one creates a new session inheriting the template's prompts + initial canvas state.
**Effort:** 2 SP · **Impact:** 2/5

## P2-42 — Apply theme axis right-click in Layers panel
Add an "Apply theme axis" submenu to the Layers panel right-click menu. Lists all theme axes defined on the document; selecting one sets the node's theme axis value via `op: 'set_node_theme'`.
**Effort:** 2 SP · **Impact:** 2/5

## P2-43 — Bind to token right-click in Layers panel
Add a "Bind to token" submenu to the Layers panel right-click menu. Lists all color tokens; selecting one binds the shape's fill to that token via `op: 'update'` with `tokenBinding.fillToken`.
**Effort:** 2 SP · **Impact:** 2/5

## P2-44 — Reparent to submenu in Layers panel right-click
Add a "Reparent to" submenu to the Layers panel right-click menu. Lists all frame / group containers in the document; selecting one reparents the shape via `op: 'reparent'` with `keepAbsolutePosition: true`.
**Effort:** 2 SP · **Impact:** 2/5

## P2-45 — Set as current snapshot (right-click)
Add a "Set as current" item to the snapshot card right-click menu. Makes the snapshot the "current canvas state" without restoring it (i.e. marks it as the baseline for the next turn).
**Effort:** 1 SP · **Impact:** 1/5

## P2-46 — Tab to focus next shape in z-order
Wire `Tab` to focus the next shape in z-order (depth-first, top-most first). `Shift+Tab` reverses. The focused shape is added to the selection.
**Effort:** 2 SP · **Impact:** 1/5

## P2-47 — ⌘↑/⌘↓ to navigate chat messages
Wire ⌘↑ and ⌘↓ to navigate up / down through chat messages in the agent panel. The scroll position snaps to the previous / next message boundary.
**Effort:** 1 SP · **Impact:** 1/5
