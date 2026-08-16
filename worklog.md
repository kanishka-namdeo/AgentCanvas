---
Task ID: session-management
Agent: main (Super Z)
Task: Research how production AI agent apps manage sessions, then build a session management feature into the existing Figma-like canvas app.

Work Log:
- Researched session management patterns from OpenAI Assistants, v0, Bolt.new, Replit Agent, Lovable, Cursor, Claude Code, Manus (via subagent).
- Explored existing codebase: found NO session/run/message persistence — every reload lost all chat history. Zustand store was in-memory only. Prisma schema had stub `AgentAction` model, never used.
- Designed session data model: Session → Run → Message + ToolCallRecord + Snapshot (mirrors OpenAI Run lifecycle + v0 fork model + Lovable snapshots).
- Built `src/lib/sessions/types.ts` — Session, Run, Message, ToolCallRecord, Snapshot, RunStatus state machine (queued → in_progress → awaiting_tool → completed/failed/cancelled).
- Built `src/lib/sessions/store.ts` — Zustand store with `persist` middleware (localStorage). Skip-hydration for SSR safety. Full CRUD for sessions/runs/messages/tool-calls/snapshots. Fork via parentId + forkedFromSnapshotId. Restore via append-only new snapshot (Lovable model).
- Bridged canvas store (`src/lib/canvas/store.ts`) to session store: `promptAgent` now starts a Run + appends Messages; `_onSync` mirrors every event (deltas, tool calls, errors) into the session store; `turn_end` captures a Snapshot. Added `switchSession`, `newSession`, `forkActiveSession` actions. `_syncTurnsFromSession` rebuilds the live `turns` buffer from session store messages (with tool calls joined by runId).
- Built UI components:
  - `StatusBadge` + `StatusDot` — color-coded status for runs/tool-calls/sessions.
  - `SessionSidebar` — left rail with search, New button, pinned-first sorting, archived section, context menu (Rename/Pin/Star/Fork/Archive/Delete).
  - `SessionHeader` — inline-editable title, status badge, fork indicator, Fork button.
  - `RunHistoryPanel` — tabbed (Runs / Snapshots), expandable run cards with tool-call timeline, snapshot cards with Restore/Fork/Bookmark.
- Updated `src/app/page.tsx` — added 4-pane layout: SessionSidebar | Layers/Properties | Canvas | (SessionHeader + AgentPanel + RunHistoryPanel).
- Updated `src/components/canvas/AgentPanel.tsx` — added `hideHeader` prop (SessionHeader replaces it), added "Fork from here" button on each user message.
- Fixed infinite loop: `useSessionStore((s) => s.getStats(...))` returned a new object every call → replaced with `useMemo` over `sessionsMap`.
- Fixed SSR hydration: added `skipHydration: true` to persist + manual `hydrateSessionStore()` call in canvas `init()`.
- Fixed tool calls not showing after session switch: `_syncTurnsFromSession` now joins tool calls from the run (session store keeps them normalized by runId).
- Fixed duplicate snapshots: runner emits `turn_end` from two paths (normal exit + MAX_ITERATIONS) → added guard to skip if run already `completed`.
- Verified the pre-existing `s.x.toFixed is not a function` bug was already fixed in a prior pass (runner uses `round()` helper now).

Stage Summary:
- 10 screenshots in `/home/z/my-project/download/session-mgmt/` showing: initial state, agent running, post-reload persistence, new session, session switch, expanded run history, snapshots panel, snapshot restore, final state.
- Tested end-to-end: create session → run agent (8 tool calls) → reload (session restored from localStorage) → create new session → switch back (canvas + chat + tool calls restored) → fork (inherits canvas, fresh chat) → restore snapshot (append-only, new snapshot created) → expand run (all 8 tool calls visible with status/duration).
- Final stats: 3 sessions, 1 run, 2 messages, 8 tool calls, 1 snapshot — all persisted across reloads.
- Zero new TypeScript errors (all session code typechecks clean; remaining errors are pre-existing in tools.ts/runner.ts/patch.ts).
- Dev server healthy at http://127.0.0.1:3000/

Artifacts:
- `/home/z/my-project/src/lib/sessions/types.ts` — type definitions
- `/home/z/my-project/src/lib/sessions/store.ts` — Zustand store with persist
- `/home/z/my-project/src/lib/sessions/index.ts` — re-exports
- `/home/z/my-project/src/components/sessions/StatusBadge.tsx`
- `/home/z/my-project/src/components/sessions/SessionSidebar.tsx`
- `/home/z/my-project/src/components/sessions/SessionHeader.tsx`
- `/home/z/my-project/src/components/sessions/RunHistoryPanel.tsx`
- `/home/z/my-project/src/lib/canvas/store.ts` — updated (session bridge)
- `/home/z/my-project/src/app/page.tsx` — updated (4-pane layout)
- `/home/z/my-project/src/components/canvas/AgentPanel.tsx` — updated (hideHeader + fork button)

---
Task ID: ui-polish
Agent: main (Super Z)
Task: Use ui-ux-pro-max skill (closest available to user's "taste-design" reference) to audit and fix UI issues in the AgentCanvas app.

Work Log:
- Loaded ui-ux-pro-max skill (in /home/z/my-project/skills/ui-ux-pro-max/) — design intelligence for "improving existing UI/UX" + "building polished interfaces".
- Audited 3 existing screenshots (01-initial, 02-running, 06-run-expanded + 07-snapshots) with VLM CLI. Identified concrete issues across 7 dimensions:
  - Layout: inconsistent panel widths, weak dividers, bottom-left clipping
  - Typography: monospace overuse, weak header/label hierarchy
  - Color: low-contrast borders, scattered shades of gray
  - Spacing: tight input padding, uniform gaps, dense icon packing
  - Components: Send button detached from input, ambiguous toggles, inconsistent tab styling
  - SessionSidebar: weak active state, "New chat" not visually distinct, search padding tight
  - RunHistoryPanel: tab styling inconsistent between screenshots, dense cards, action button clutter
- Added unified design token system to /home/z/my-project/src/app/globals.css:
  - Semantic text hierarchy (--ac-text-primary through --ac-text-faint, mapped to .ac-text-1..5)
  - Stronger border scale (--ac-border-subtle/default/strong)
  - Surface elevation tokens (--ac-surface-0..3)
  - Brand accent + status colors as OKLCH
  - Utility classes: .ac-active-row (left-bar accent), .ac-focus-ring, .ac-transition, .ac-hide-scrollbar
- Polished 8 components:
  - page.tsx (top bar): pill-style status badges, "local-only" replaces alarming "offline", safer spacing
  - SessionSidebar.tsx: solid violet primary CTA for "New chat", stronger active row (left accent bar), better empty state with CTA, subtle scrollbars
  - SessionHeader.tsx: 13px title (was 12px), branded bot avatar with gradient + ring, cleaner metadata row with consistent dot separators, outline Fork button
  - RunHistoryPanel.tsx: unified tab design (filled white on light gray bg, vs old dark/light inversion that was inconsistent), cards with stronger hover border, action buttons with consistent outline styling, better empty states
  - AgentPanel.tsx: Send button now grouped INSIDE the textarea container (single visual unit), disabled Send shows 40% opacity + not-allowed cursor, prompt suggestion cards show send-arrow affordance on hover, tighter status strip
  - StatusBadge.tsx: stronger `completed` contrast (emerald-800 on emerald-100 with emerald-300 border, was 700/50/200)
  - LayersPanel.tsx: stronger hover, semantic text colors, better empty state
  - PropertiesPanel.tsx: uppercase header, consistent label hierarchy, semantic text colors
  - Toolbar.tsx: tighter gap (0.5 vs 1), branded Select tool (filled surface), stronger separator
- Wrote /home/z/my-project/scripts/screenshot-ui-after.ts (Playwright script) — captures 5 states.
- Re-audited polished screenshots with VLM. Final verdict: "Visual hierarchy: Strong. Borders & separators: Adequate. Active states: Visible."

Stage Summary:
- 5 polished screenshots in /home/z/my-project/download/ui-polish-after/
- Zero TypeScript errors (clean compiles throughout)
- Dev server healthy at http://127.0.0.1:3000/
- All 4 panels (sidebar, header, agent, history) now share one semantic design token system instead of scattered slate-{300..900} colors
- Send button + textarea unified into single visual unit (was previously detached, biggest UI issue)
- Run history tabs consistent (was alternating styling between screenshots)
- Active session row uses 2px left accent bar + soft violet bg (was weak border + faint bg)

Artifacts:
- /home/z/my-project/src/app/globals.css (added AC design tokens + utility classes)
- /home/z/my-project/src/app/page.tsx (top bar polished)
- /home/z/my-project/src/components/sessions/SessionSidebar.tsx
- /home/z/my-project/src/components/sessions/SessionHeader.tsx
- /home/z/my-project/src/components/sessions/RunHistoryPanel.tsx
- /home/z/my-project/src/components/sessions/StatusBadge.tsx
- /home/z/my-project/src/components/canvas/AgentPanel.tsx
- /home/z/my-project/src/components/canvas/LayersPanel.tsx
- /home/z/my-project/src/components/canvas/PropertiesPanel.tsx
- /home/z/my-project/src/components/canvas/Toolbar.tsx
- /home/z/my-project/scripts/screenshot-ui-after.ts
- /home/z/my-project/download/ui-polish-after/{01-initial,02-hover-session,03-input-focused,04-snapshots-tab,05-runs-expanded}.png

---
Task ID: dox-tree-init
Agent: main (Super Z)
Task: Initialize and set up a DOX tree in the project according to https://github.com/agent0ai/dox/blob/main/AGENTS.md

Work Log:
- Fetched and read the upstream dox AGENTS.md (raw from https://raw.githubusercontent.com/agent0ai/dox/main/AGENTS.md). Understood the framework: hierarchical AGENTS.md files acting as binding work contracts, with a default section order (Purpose / Ownership / Local Contracts / Work Guidance / Verification / Child DOX Index) and a "read before editing, update after editing" protocol.
- Surveyed the existing project structure to identify durable folder boundaries: src/lib/{agent,canvas,sessions}, src/components/{canvas,sessions,ui}, src/app + src/app/api, scripts, mini-services/canvas-sync, prisma, research, tests.
- Read key files to ensure AGENTS.md content is accurate: package.json (scripts + deps), prisma/schema.prisma (Document/Shape/AgentAction models), src/lib/agent/runner.ts (LLM shim policy + system prompt), src/lib/canvas/store.ts (Zustand + session bridge), mini-services/canvas-sync/index.ts (Socket.IO contract), scripts/start-dev.sh, tests/python-runtime-build.sh, research/pi_agent_sdk.json.
- Created 14 AGENTS.md files (1 root + 13 children), each following the dox default section order:
  - /home/z/my-project/AGENTS.md (root rail — project-wide contracts, tech stack, hard rules, verification, full Child DOX Index table)
  - src/lib/agent/AGENTS.md (24-tool surface, LLM shim policy, system prompt, event stream shape, number safety / the s.x.toFixed fix)
  - src/lib/canvas/AGENTS.md (store contract, React subscription safety / EMPTY_TOKENS, patch null-safety, types ↔ Prisma sync)
  - src/lib/sessions/AGENTS.md (Session/Run/Message/ToolCallRecord/Snapshot data model, run status state machine, fork model, restore model, persistence)
  - src/components/canvas/AGENTS.md (Canvas/Toolbar/LayersPanel/PropertiesPanel/AgentPanel contracts, design token usage, null-safe shape access)
  - src/components/sessions/AGENTS.md (SessionSidebar/SessionHeader/RunHistoryPanel/StatusBadge contracts, StatusBadge color map as single source of truth)
  - src/components/ui/AGENTS.md (shadcn primitives — do not hand-edit, style override policy, ~50-component inventory)
  - src/app/AGENTS.md (layout, 4-pane page, --ac-* design token system, Tailwind 4)
  - src/app/api/AGENTS.md (/api/agent SSE-style stream contract, /api health check, HTTP fallback equivalence with WebSocket)
  - scripts/AGENTS.md (script persistence rule, shell + Playwright conventions)
  - mini-services/canvas-sync/AGENTS.md (Socket.IO on port 3003, in-memory DocState, event protocol, coupling with canvas types + runner)
  - prisma/AGENTS.md (datasource, Document/Shape/AgentAction models, migration rules, sync with src/lib/canvas/types.ts)
  - research/AGENTS.md (read-only — do not edit, 7-file inventory)
  - tests/AGENTS.md (runtime build smoke tests, NOT app unit tests, depends on ../.zscripts/)
- Verified tree integrity: `find` confirms all 14 AGENTS.md files exist at expected paths. (A pre-existing /home/z/my-project/skills/design/design-templates/ppt/AGENTS.md is inside the skills folder — not part of project source, left untouched.)

Stage Summary:
- 14 AGENTS.md files installed, totaling ~940 lines of operational documentation.
- Root AGENTS.md is the DOX rail: lists all 13 direct children in a Child DOX Index table with scope summaries.
- Each child AGENTS.md follows the dox default section order (Purpose / Ownership / Local Contracts / Work Guidance / Verification / Child DOX Index) and restates root contracts locally where relevant (design tokens, React subscription safety, LLM shim policy, script persistence).
- Captured the previously-fixed bugs as durable contracts: the s.x.toFixed number-safety rule (in agent/AGENTS.md), the EMPTY_TOKENS stable-reference rule (in canvas/AGENTS.md), the HTTP fallback equivalence rule (in api/AGENTS.md), the append-only snapshot restore rule (in sessions/AGENTS.md).
- No source code changed — this is a pure documentation install.
- Future agents editing this repo MUST now walk the DOX chain (root → nearest owning AGENTS.md) before editing, and run a DOX closeout pass after editing.

Artifacts:
- /home/z/my-project/AGENTS.md
- /home/z/my-project/src/lib/agent/AGENTS.md
- /home/z/my-project/src/lib/canvas/AGENTS.md
- /home/z/my-project/src/lib/sessions/AGENTS.md
- /home/z/my-project/src/components/canvas/AGENTS.md
- /home/z/my-project/src/components/sessions/AGENTS.md
- /home/z/my-project/src/components/ui/AGENTS.md
- /home/z/my-project/src/app/AGENTS.md
- /home/z/my-project/src/app/api/AGENTS.md
- /home/z/my-project/scripts/AGENTS.md
- /home/z/my-project/mini-services/canvas-sync/AGENTS.md
- /home/z/my-project/prisma/AGENTS.md
- /home/z/my-project/research/AGENTS.md
- /home/z/my-project/tests/AGENTS.md

---
Task ID: polish-pass2
Agent: main (Super Z)
Task: Three-part polish pass — (1) subtle empty-canvas drop zone, (2) dark-mode token variant, (3) polish rename Dialog + dropdown menus.

Work Log:
- Read the DOX chain before editing: root AGENTS.md → src/components/canvas/AGENTS.md (for Canvas.tsx), src/app/AGENTS.md (for globals.css + page.tsx), src/components/sessions/AGENTS.md (for SessionSidebar.tsx).
- Task 1 — Empty-canvas drop zone (src/components/canvas/Canvas.tsx):
  - Added a centered placeholder shown when `document.shapes.length === 0`. Dashed `--ac-border-strong` border, `--ac-surface-0` 70% bg with 2px backdrop blur, violet icon tile (PenLine) using `--ac-accent-soft`/`--ac-accent`/`--ac-accent-border`, "Empty canvas" heading + descriptive subtitle + tip line ("Tip: try "Design a login form" in the chat").
  - `pointer-events: none` so it never blocks canvas clicks. `data-empty-bg="true"` so the existing click-to-clear-selection handler still works through it.
  - Fades in via new `ac-fade-in` keyframe (opacity 0→1 + 4px upward translate, 240ms ease-out).
  - Disappears the moment the first shape is added (conditional render on `document.shapes.length === 0`).
  - Bonus: tokenized the backdrop grid dot color (was hardcoded `rgba(15,23,42,0.08)` → now `color-mix(in oklch, var(--ac-text-primary) 12%, transparent)`) so it swaps correctly in dark mode.
  - Bonus: tokenized the zoom indicator (was `bg-white/90 border-slate-200 text-slate-600` → now `--ac-surface-0` via color-mix, `--ac-border-default`, `ac-text-2/3`).
- Task 2 — Dark-mode token variant (src/app/globals.css):
  - Added a `.dark` selector block that redefines every `--ac-*` token. OKLCH makes this a pure lightness inversion: same hues, inverted L axis. Text goes 0.21→0.97, surfaces go 1.0→0.17, borders go 0.88→0.32, etc.
  - Brand accent brightened slightly on dark (0.55→0.68 L) so it pops; `-soft` variants inverted to darker tints (0.96→0.30 L) so they don't glare.
  - Status colors brightened on dark; their `-soft` variants darkened.
  - Added `ac-fade-in` keyframe at the end of the file (outside the utilities layer so it's globally available).
  - Fixed doc inaccuracy: project uses `.dark` class (per `@custom-variant dark (&:is(.dark *))` at top of globals.css), NOT `[data-theme="dark"]` as the previous AGENTS.md draft claimed.
  - Created `src/components/ThemeToggle.tsx` — small client component that flips `.dark` on `<html>`, persists to `localStorage['agentcanvas-theme']`, respects `prefers-color-scheme` on first visit, uses `suppressHydrationWarning`-safe mount pattern.
  - Wired the toggle into the top bar of `src/app/page.tsx` (next to the "SDK docs" link).
  - Fixed `bg-white` on the chat column container in page.tsx → `ac-surface-0` so it swaps correctly in dark mode.
- Task 3 — Rename Dialog + dropdown menu polish (src/components/sessions/SessionSidebar.tsx):
  - Dropdown menu: added `DropdownMenuLabel` showing the session title at the top (uppercase, `ac-text-4`, truncated) — gives the user context for which session the menu applies to. Added `min-w-[180px]` for consistent width. Items use `py-1.5` for slightly taller touch targets. Destructive item (Delete) switched from hand-rolled `text-rose-600 focus:text-rose-700` class to the primitive's built-in `variant="destructive"` — cleaner + dark-mode safe (the primitive's own CSS handles dark variant).
  - Rename Dialog: added `DialogDescription` ("This name appears in the sidebar. You can change it any time.") for context. Wrapped the input in a labeled group (`<label>` "TITLE" + `Input`). Input handles `Escape` (cancel) in addition to `Enter` (save). Footer Cancel button is ghost with `ac-text-2` → `ac-text-1` hover. Save button is brand-colored (`backgroundColor: var(--ac-accent)`, white text) and `disabled` when the input is empty.
- Verification:
  - `bunx tsc --noEmit` — 12 errors, ALL pre-existing (Toolbar.tsx, runner.ts, tools.ts, patch.ts). Zero new errors in any file I touched (Canvas.tsx, SessionSidebar.tsx, page.tsx, globals.css, ThemeToggle.tsx).
  - Wrote `scripts/screenshot-polish-pass2.ts` (Playwright, 8 states) and captured to `download/polish-pass2/`.
  - VLM audit (via subagent) on 5 key screenshots: ALL PASS. Confirmed drop zone renders correctly, dropdown has header label + destructive Delete styling, rename dialog has description + labeled input + brand Save button, dark mode swaps all chrome correctly. Two minor notes from audit: (a) "Fork from here" vs "Fork" — kept as "Fork from here" (original copy, more descriptive); (b) canvas workspace stays light in dark mode — by design, since `document.background` is a user-controlled document property (like Figma), not a UI surface.
- DOX closeout pass:
  - Updated `src/app/AGENTS.md`: rewrote the design token system section (corrected token names, added keyframes, added full Dark mode section, fixed `.dark` vs `[data-theme="dark"]` inaccuracy, documented that the canvas workspace does NOT swap to dark by design). Updated Layout contract (removed inaccurate "next-themes Provider" claim — ThemeToggle uses localStorage directly). Updated Page contract (mentioned ThemeToggle in top bar, documented `bg-white` → `ac-surface-0` fix).
  - Updated `src/components/canvas/AGENTS.md`: added Empty-canvas drop zone contract, Backdrop grid color-mix contract, Zoom indicator tokenization contract.
  - Updated `src/components/sessions/AGENTS.md`: rewrote SessionSidebar.tsx contract with full dropdown menu polish details (DropdownMenuLabel, min-w, variant=destructive) and rename Dialog polish details (DialogDescription, labeled input, Enter/Escape handling, brand Save button, disabled-when-empty).
  - Updated `scripts/AGENTS.md`: added screenshot-polish-pass2.ts to the file inventory.
  - Updated root `AGENTS.md`: added `src/components/ThemeToggle.tsx` to the root-owned files list with a cross-reference to `src/app/AGENTS.md`'s Dark mode section.

Stage Summary:
- 5 files modified: Canvas.tsx, globals.css, SessionSidebar.tsx, page.tsx, + 4 AGENTS.md files updated.
- 2 files created: ThemeToggle.tsx, scripts/screenshot-polish-pass2.ts.
- 8 screenshots in `/home/z/my-project/download/polish-pass2/` covering all three deliverables in both light and dark mode.
- Zero new TypeScript errors.
- Dev server healthy at http://127.0.0.1:3000/.
- Dark mode is now a first-class citizen: the toggle persists across reloads, respects OS preference on first visit, and every panel/dialog/dropdown swaps correctly. The only surface that doesn't swap is the canvas workspace itself — by design (it's the document, not chrome).
- The empty-canvas drop zone is the audit's "last critical note" — now resolved with a subtle, branded, fade-in placeholder that disappears the moment the first shape lands.
- Rename Dialog and dropdown menu now match the polish level of the rest of the app: labeled, described, branded Save button, destructive variant, context-providing menu header.

Artifacts:
- /home/z/my-project/src/components/canvas/Canvas.tsx (drop zone + tokenized zoom indicator + tokenized backdrop grid)
- /home/z/my-project/src/app/globals.css (.dark token variant + ac-fade-in keyframe)
- /home/z/my-project/src/components/ThemeToggle.tsx (NEW)
- /home/z/my-project/src/app/page.tsx (ThemeToggle in top bar + bg-white → ac-surface-0)
- /home/z/my-project/src/components/sessions/SessionSidebar.tsx (polished dropdown + rename Dialog)
- /home/z/my-project/scripts/screenshot-polish-pass2.ts (NEW)
- /home/z/my-project/download/polish-pass2/{01-empty-canvas-dropzone, 02-new-chat-hover, 03-session-row-hover, 04-dropdown-menu-open, 05-rename-dialog, 06-dark-mode-empty, 07-dark-mode-dropdown, 08-dark-mode-rename-dialog}.png
- /home/z/my-project/AGENTS.md (root-owned files list updated)
- /home/z/my-project/src/app/AGENTS.md (token system + dark mode + layout/page contracts updated)
- /home/z/my-project/src/components/canvas/AGENTS.md (Canvas.tsx contracts updated)
- /home/z/my-project/src/components/sessions/AGENTS.md (SessionSidebar contracts updated)
- /home/z/my-project/scripts/AGENTS.md (screenshot-polish-pass2.ts added)

---
Task ID: layout-restructure-p0
Agent: main (Super Z)
Task: Implement P0 layout improvements (1) move PropertiesPanel to right column above AgentPanel, (2) make all panels collapsible, (3) add global Run/Stop control to top header.

Work Log:
- Read page.tsx, SessionHeader, PropertiesPanel, AgentPanel, resizable.tsx, canvas store, runner, sessions types/store, package.json — built complete mental model of current 4-pane layout wiring.
- Added `stopAgent` action to `src/lib/canvas/store.ts`:
  - Module-level `agentAbort: AbortController | null` ref.
  - `promptAgent` HTTP fallback now creates an AbortController and passes `signal` to `fetch()`. Catch path distinguishes `AbortError` (silent finalize) from real errors.
  - `stopAgent()` action: if HTTP in flight → abort (catch will finalize). If WebSocket path → finalize locally (set last turn `streaming=false`, `agentBusy=false`, capture snapshot with `createdBy:'user'`, end run with `'cancelled'` status if not already terminal).
- Refactored `src/components/sessions/SessionHeader.tsx` to support a `compact` prop:
  - Default: full avatar + title + meta + Fork (unchanged from before, used as fallback).
  - Compact: small 20×20 avatar with status pulse + inline-editable title (max 180px) + StatusBadge + Fork button — fits in the 44px top header.
- Created `src/components/sessions/RunStopButton.tsx`:
  - Idle: violet "Run" button (uses `--ac-accent`) that focuses the chat input via a `window.__focusAgentInput` global hook.
  - Busy: red "Stop" button (uses `--ac-danger`) with a pulsing white dot, calls `stopAgent()`.
- Updated `src/components/canvas/AgentPanel.tsx`:
  - Added `inputRef` and a `useEffect` that registers `window.__focusAgentInput = () => inputRef.current?.focus()` on mount, deletes on unmount.
  - Wired `ref={inputRef}` to the `<Textarea>`.
- Rewrote `src/app/page.tsx`:
  - Top header now has 3 sections: left (brand + doc name), center (compact SessionHeader), right (Run/Stop + 4 collapse toggles + status pills + theme).
  - 4 collapse toggle buttons (Sessions / Layers / Properties / Right column) wired to imperative panel refs via `ref.current.collapse()` / `.expand()`.
  - Keyboard shortcuts: ⌘1 Sessions, ⌘2 Layers, ⌘3 Properties, ⌘4 Right column — toggle collapse.
  - New 4-column layout: Sessions | Layers | Canvas | (Properties top / Chat middle / History bottom).
  - All 4 outer panels + Properties + RunHistory use `collapsible` + `collapsedSize={0}` + `onCollapse`/`onExpand` to track collapsed state.
  - PropertiesPanel moved from left (Col 2 bottom) to right (Col 4 top) — Figma-conventional placement.
  - SessionHeader (compact) moved from Col 4 top to the top header bar.
  - AgentPanel now renders standalone in Col 4 middle (no longer wrapped with SessionHeader).
  - `CollapseToggle` helper component for the icon buttons.
  - `toggle()` helper for the ref + state flip pattern.
- Verified TypeScript: `npx tsc --noEmit` shows zero new errors in any touched file (page.tsx, SessionHeader, RunStopButton, AgentPanel, canvas/store.ts). Pre-existing errors in tools.ts/runner.ts/patch.ts/Toolbar.tsx/skills/ unchanged.
- Verified production build: `npx next build` → "✓ Compiled successfully in 26.2s", all 4 routes generated.

Stage Summary:
- Layout is now Figma-conventional: navigation/structure on the left (Sessions, Layers), work in the center (Canvas), inspect/interact on the right (Properties, Chat, History).
- All 6 panels are collapsible via header toggle buttons or ⌘1–⌘4 keyboard shortcuts. Collapsed panels free their full width for the canvas.
- Global Run/Stop button in the top header gives the agent's run state a permanent home — no more hunting for the buried Send button to know if the agent is working.
- Stop actually works: HTTP fallback path is aborted mid-stream via `AbortController`; WebSocket path finalizes the run as `cancelled` locally (server keeps running but its late events are no-ops since `agentBusy` is already false).
- AgentPanel registers `window.__focusAgentInput` on mount so the Run button can focus the chat input without prop-drilling.
- Files touched: src/app/page.tsx (rewrite), src/lib/canvas/store.ts (+stopAgent +abort wiring), src/components/sessions/SessionHeader.tsx (+compact prop), src/components/sessions/RunStopButton.tsx (new), src/components/canvas/AgentPanel.tsx (+inputRef +focus hook).
