# AGENTS.md — `src/components/sessions/`

## Purpose

Session management UI: the sidebar (session list + new/search/fork/archive), the header (title + status + fork button), the run history panel (runs + snapshots tabs), the run/stop button, and the status badge component.

These components read from `useSessionStore` (the persisted Zustand store in `src/lib/sessions/`) and dispatch actions to either the session store (CRUD) or the canvas store (fork/restore).

## Ownership

- `SessionSidebar.tsx` — left panel tab (Chats): search, New button, pinned-first sorting, archived section, footer stats (runs/tools/snapshots counts), rich context menu. "Fork this chat" calls `forkSession(session.id, null)` directly (NOT `forkActiveSession`). Toasts on Archive/Delete/Fork/Duplicate/Export/Copy-prompt.
- `SessionHeader.tsx` — top of the right panel. Two variants: `compact` (single-row for the 44px header — small avatar + inline-editable title + StatusBadge + Fork button) and default/full (avatar + title + meta row with status, fork indicator, relative time, model + Fork button). Inline-editable title, branded bot avatar.
- `RunHistoryPanel.tsx` — right panel tab (History): tabbed (Runs / Snapshots). Expandable run cards with tool-call timeline. Snapshot cards with Restore / Fork / Bookmark. "Capture current state" button. Accepts `hideHeader` prop (compact tab strip when inside the right tabbed panel). Context menus on both run cards and snapshot cards. Toasts on Restore/Fork/Capture (Bookmark does not toast).
- `RunStopButton.tsx` — header button. When idle: shows "Ask" button that opens the Command Palette via `onAsk` prop. When busy: shows "Stop" button with pulsing white dot.
- `StatusBadge.tsx` — color-coded status pill for runs / tool-calls / sessions. Three status maps (Run, ToolCall, Session). Includes a `StatusDot` variant.

## Local Contracts

### Design token usage (root contract, restated)
- All components consume the `--ac-*` design tokens via utility classes for surfaces, borders, text hierarchy, and accents.
- **Exception**: `StatusBadge.tsx` uses hardcoded Tailwind colors (`text-slate-700`, `bg-emerald-100`, etc.) for status-specific coloring. This is intentional — status colors are domain-specific and don't map to the generic `--ac-*` surface/text tokens.
- The `StatusBadge` color maps (`RUN_STATUS_CONFIG`, `TOOL_STATUS_CONFIG`, `SESSION_STATUS_CONFIG`) are the single source of truth for status → color.

### Component contracts

#### `SessionSidebar.tsx`
- "New chat" button is a solid violet primary CTA (the brand accent), visually distinct from secondary actions.
- Active session row uses `.ac-active-row` (2px left accent bar + soft violet bg).
- Pinned sessions sort first; archived sessions collapse into a disclosure section at the bottom.
- Footer stats bar: shows total runs + tools count (left) and snapshots count (right).
- Context menu (`DropdownMenuContent`):
  - `min-w-[180px]` for consistent width.
  - Opens with a `DropdownMenuLabel` showing the session title (uppercase, `ac-text-4`, truncated).
  - Items use `py-1.5`.
  - Destructive item (Delete) uses `variant="destructive"`.
  - Full action list: Rename, Pin/Unpin, Star/Unstar, Fork this chat (`forkSession(session.id, null)`), Duplicate session (fork without switching), Export as JSON (copies session JSON), Export as Markdown (stub — P2-37), Copy prompt summary (copies user messages), Mark as template (stub — P2-41), Archive, Delete (with confirm).
  - Toasts on: Archive, Delete, Fork, Duplicate, Export as JSON, Copy prompt summary. Pin/Star do NOT toast.
- Rename Dialog (`DialogContent`):
  - Has `DialogDescription` ("This name appears in the sidebar…") for context.
  - Input wrapped in labeled group: `<label>` "TITLE" (uppercase, `ac-text-4`) + `Input` with `ac-border-default` → `focus-visible:ac-border-strong`.
  - Input handles `Enter` (save) and `Escape` (cancel) via `onKeyDown`.
  - Footer: ghost Cancel button + brand-colored Save button (`backgroundColor: var(--ac-accent)`). Save is `disabled` when input is empty.
- Empty state: friendly message + CTA pointing at the New button.
- Search filters by title (case-insensitive substring).
- Subtle scrollbars via `.ac-hide-scrollbar`.

#### `SessionHeader.tsx`
- Two variants via `compact` prop:
  - **compact** (for the 44px top header): single row — small avatar (5×5) with optional status dot, inline-editable title (12px), StatusBadge, Fork button. Drops model + relative-time meta.
  - **default/full**: avatar (6×6) with gradient + ring, inline-editable title (13px semibold), meta row (StatusBadge + fork indicator + relative time + model), Fork button.
- Title is inline-editable (click to edit, Enter to save, Esc to cancel).
- Branded bot avatar: violet-to-fuchsia gradient + Bot icon.
- Metadata row uses consistent `·` dot separators.
- Fork button is outline style (secondary action).

#### `RunHistoryPanel.tsx`
- Two tabs: **Runs** and **Snapshots**.
- Tab styling is unified: selected = `ac-surface-0 ac-text-1 shadow-sm`, unselected = `ac-text-3` (token-based, not hardcoded white/gray).
- Run cards are expandable (Collapsible): collapsed shows prompt + status + duration + tool-call count; expanded shows the full tool-call timeline with status badges and per-call duration.
- Run card context menu (right-click): Expand/Collapse, Restore run (stub), Fork from here (stub), Copy prompt, Copy all tool calls as JSON, Export run as Markdown (stub — P2-37), Delete run (stub).
- Snapshot cards: Camera icon, label, source badge (color-coded by source: turn_end/fork/restore/manual), node count, timestamp, Restore / Fork / Bookmark buttons. Active snapshot highlighted with emerald border.
- Snapshot card context menu (right-click): Restore, Fork from here, Bookmark toggle, Rename snapshot (stub — P2-38), Delete snapshot (stub), Copy as JSON, Export as .pen (stub), Set as current (stub — P2-45).
- "Capture current state" button at bottom of Snapshots tab.
- Action buttons use consistent outline styling.
- Empty states for both tabs.

#### `StatusBadge.tsx`
- Three status maps (single source of truth for each domain):
  - **Run statuses**: `queued` (gray), `in_progress` → "running" (blue, pulse), `awaiting_tool` → "tool" (amber, pulse), `cancelling` (orange, pulse), `cancelled` (muted gray), `completed` (emerald-800 on emerald-100 with emerald-300 border), `failed` (red), `incomplete` (amber)
  - **ToolCall statuses**: `pending` (gray), `running` (blue, pulse), `success` (emerald), `error` (red), `cancelled` (muted gray)
  - **Session statuses**: `active` (emerald), `archived` (muted gray)
- Display labels may differ from status keys (e.g., `in_progress` → "running", `awaiting_tool` → "tool").
- `StatusDot` variant: just the colored dot, no label. Used in dense layouts (sidebar rows).

### React subscription safety (root contract, restated)
- Never call `useSessionStore((s) => s.getStats(id))` in a selector — it returns a new object every render. Use `useMemo` over `sessionsMap` instead.
- List rendering: prefer `sessionsArray` (a memoized sorted array from the store) over `Object.values(sessions)` inline.

## Work Guidance

- When adding a new run status: update `StatusBadge`'s color map first, then `RunHistoryPanel`'s filter logic, then the state machine doc in `src/lib/sessions/AGENTS.md`.
- When adding a new sidebar action: add it to the context menu, wire it to a `useSessionStore` action, add a confirmation dialog for destructive actions (Delete, Archive).
- When changing tab styling: change it ONCE in `RunHistoryPanel` — do not introduce a parallel tab implementation in another component.
- Capture screenshots before/after to `download/<feature-name>/`.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run lint` — ESLint.
- Manual: create a session, run the agent, reload (session persists), switch sessions (canvas + chat + tool calls restore), fork (inherits canvas, fresh chat), restore a snapshot (new snapshot appears in the list).
- `bunx tsx scripts/screenshot-ui-after.ts` — captures the runs-expanded and snapshots-tab states.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../canvas/AGENTS.md` (Canvas UI components), `../ui/AGENTS.md` (shadcn/ui primitives).*
