# AGENTS.md — `src/components/sessions/`

## Purpose

Session management UI: the sidebar (session list + new/search/fork/archive), the header (title + status + fork button), the run history panel (runs + snapshots tabs), and the status badge component.

These components read from `useSessionStore` (the persisted Zustand store in `src/lib/sessions/`) and dispatch actions to either the session store (CRUD) or the canvas store (fork/restore).

## Ownership

- `SessionSidebar.tsx` — left rail: search, New button, pinned-first sorting, archived section, context menu (Rename / Pin / Star / Fork / Archive / Delete).
- `SessionHeader.tsx` — top of the agent column: inline-editable title, status badge, fork indicator, Fork button, branded bot avatar.
- `RunHistoryPanel.tsx` — tabbed (Runs / Snapshots). Expandable run cards with tool-call timeline. Snapshot cards with Restore / Fork / Bookmark.
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
- Context menu actions: Rename (inline), Pin/Unpin, Star/Unstar, Fork, Archive/Unarchive, Delete (with confirm).
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

No child `AGENTS.md` files. This folder is flat.
