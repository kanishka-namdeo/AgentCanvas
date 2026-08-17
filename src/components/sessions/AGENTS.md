# AGENTS.md — `src/components/sessions/`

## Purpose

Session management UI: the sidebar (session list + new/search/fork/archive), the header (title + status + fork button), the run history panel (runs + snapshots tabs), and the status badge component.

These components read from `useSessionStore` (the persisted Zustand store in `src/lib/sessions/`) and dispatch actions to either the session store (CRUD) or the canvas store (fork/restore).

## Ownership

- `SessionSidebar.tsx` — left panel tab (Chats): search, New button, pinned-first sorting, archived section, context menu (Rename / Pin / Star / Fork this chat / Archive / Delete). "Fork this chat" calls `forkSession(session.id, null)` directly (NOT `forkActiveSession` — which used the wrong active session). Toasts on Pin/Star/Archive/Delete/Fork.
- `SessionHeader.tsx` — top of the right panel (compact mode in header): inline-editable title, status badge, fork indicator, Fork button, branded bot avatar.
- `RunHistoryPanel.tsx` — right panel tab (History): tabbed (Runs / Snapshots). Expandable run cards with tool-call timeline. Snapshot cards with Restore / Fork / Bookmark. "Capture current state" button. Accepts `hideHeader` prop (compact tab strip when inside the right tabbed panel). Toasts on Restore/Fork/Capture/Bookmark.
- `RunStopButton.tsx` — header button. When idle: shows "Ask" button that opens the Command Palette via `onAsk` prop (replaces the old "Run" button that was a silent no-op when not on Chat tab). When busy: shows "Stop" button with pulsing white dot.
- `StatusBadge.tsx` — color-coded status pill for runs / tool-calls / sessions. Includes a `StatusDot` variant.

## Local Contracts

### Design token usage (root contract, restated)
- All components consume the `--ac-*` design tokens via utility classes. No hardcoded `slate-{n}` colors.
- Status colors come from `--ac-status-*` OKLCH variables. The `StatusBadge` color map is the single source of truth for status → color.

### Component contracts

#### `SessionSidebar.tsx`
- "New chat" button is a solid violet primary CTA (the brand accent), visually distinct from secondary actions.
- Active session row uses `.ac-active-row` (2px left accent bar + soft violet bg).
- Pinned sessions sort first; archived sessions collapse into a disclosure section at the bottom.
- Context menu actions: Rename (opens Dialog), Pin/Unpin, Star/Unstar, "Fork this chat" (calls `forkSession(session.id, null)` — NOT `forkActiveSession`), Archive/Unarchive, Delete (with confirm). All actions show a `sonner` toast on success.
- Context menu (`DropdownMenuContent`):
  - `min-w-[180px]` for consistent width.
  - Opens with a `DropdownMenuLabel` showing the session title (uppercase, `ac-text-4`, truncated) — provides context for which session the menu applies to.
  - Items use `py-1.5` (slightly taller than the primitive's default `py-1.5` — kept consistent).
  - Destructive item (Delete) uses the primitive's `variant="destructive"` (NOT a hand-rolled `text-rose-600` class) so it swaps correctly in dark mode.
- Rename Dialog (`DialogContent`):
  - Has `DialogDescription` ("This name appears in the sidebar…") for context — not just a bare title + input.
  - Input is wrapped in a labeled group: `<label>` "TITLE" (uppercase, `ac-text-4`) + `Input` with `ac-border-default` → `focus-visible:ac-border-strong`.
  - Input handles `Enter` (save) and `Escape` (cancel) via `onKeyDown`.
  - Footer: ghost Cancel button (`ac-text-2` → `ac-text-1` on hover) + brand-colored Save button (`backgroundColor: var(--ac-accent)`, white text). Save is `disabled` when the input is empty.
- Empty state: friendly message + CTA pointing at the New button.
- Search filters by title (case-insensitive substring).
- Subtle scrollbars via `.ac-hide-scrollbar`.

#### `SessionHeader.tsx`
- Title is inline-editable (click to edit, Enter to save, Esc to cancel).
- Title font size is 13px (was 12px — too small).
- Branded bot avatar: gradient fill + ring.
- Metadata row uses consistent dot separators (no mixed `·`/`•`/`|`).
- Fork button is outline style (secondary action).
- Status badge sits next to the title.

#### `RunHistoryPanel.tsx`
- Two tabs: **Runs** and **Snapshots**.
- Tab styling is unified: filled white bg on active tab, light gray bg on inactive (was previously alternating dark/light inversion between screenshots — fixed).
- Run cards are expandable: collapsed shows prompt + status + duration; expanded shows the full tool-call timeline with status badges and per-call duration.
- Snapshot cards: thumbnail (canvas preview), label, timestamp, Restore / Fork / Bookmark buttons.
- Action buttons use consistent outline styling — no mixing of solid/outline within the same card.
- Empty states for both tabs.

#### `StatusBadge.tsx`
- Color map (single source of truth):
  - `queued` — neutral gray
  - `in_progress` — blue (animated pulse on the dot variant)
  - `awaiting_tool` — amber
  - `completed` — emerald-800 on emerald-100 with emerald-300 border (was 700/50/200 — too low contrast)
  - `failed` — red
  - `cancelled` — muted gray
- `StatusDot` variant: just the colored dot, no label. Used in dense layouts.

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
