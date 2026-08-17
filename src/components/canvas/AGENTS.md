# AGENTS.md — `src/components/canvas/`

## Purpose

Canvas UI components: the drawing surface, the toolbar, the layers panel, the properties inspector, and the agent chat panel. These are the primary interactive surfaces the user sees and touches.

## Ownership

- `Canvas.tsx` — the SVG/HTML drawing surface. Renders shapes from `useCanvasStore`. Handles pan/zoom, selection, drag, resize. Reads `toolMode` from the store to decide pan vs select on click-drag. Cursor changes to `grab` when `toolMode === 'pan'` or Space is held.
- `Toolbar.tsx` — **floating pill** at the bottom-center of the canvas (tldraw/Excalidraw pattern). Tool buttons: Select (V), Pan (H), Rectangle, Ellipse, Text, Line, Frame, Clear. Shape buttons are `disabled` when `agentBusy`. Clear is `disabled` when canvas is empty. Select/Pan buttons toggle `toolMode` in the store with `aria-pressed`.
- `CommandPalette.tsx` — ⌘K command palette (Dialog + cmdk). Fuzzy-searchable list of all 19 preset prompts grouped by category. Supports custom free-form prompts as a fallback. Opens via the "Ask anything" header button or `⌘K`. Disabled when `agentBusy`.
- `LayersPanel.tsx` — left panel tab: shape list with rename / reorder / lock / hide / delete. Badges capped at 1 visible per row (priority: Master > Instance > AL > theme > token); rest go into hover tooltip.
- `PropertiesPanel.tsx` — right panel tab (Design): form for the selected shape. Fill/Stroke/Radius/Opacity wrapped in a single "Style" Collapsible. Sections are type-conditional (Auto Layout only for frame/group; Text only for text shapes; Slot only for frames). Empty state shows canvas background + design tokens + variables/themes summary.
- `AgentPanel.tsx` — right panel tab (Chat): chat input + streaming message list + tool-call cards + "Fork from this message" button on each user message. Status strip (variables/tokens) removed — moved to PropertiesPanel empty state. Send button only renders when there's input.

## Local Contracts

### Design token usage (root contract, restated)
- All components MUST consume the `--ac-*` design tokens from `src/app/globals.css` via the utility classes (`.ac-text-1` ... `.ac-text-5`, `.ac-border-subtle` / `.ac-border-default` / `.ac-border-strong`, `.ac-surface-0` ... `.ac-surface-3`, `.ac-active-row`, `.ac-focus-ring`, `.ac-transition`, `.ac-hide-scrollbar`).
- Do NOT hardcode `slate-{n}` / `zinc-{n}` / `gray-{n}` Tailwind color literals. Use the tokens or the `--ac-*` CSS variables directly.
- Status colors (success/warning/error/info) use the `--ac-status-*` OKLCH variables.

### Component contracts
- `Canvas.tsx`:
  - Reads `document.shapes`, `selectedIds`, `toolMode` from the canvas store.
  - `toolMode === 'pan'` makes click-drag pan the canvas (same as Space-held). `onShapeMouseDown` returns early in pan mode (no selection).
  - Cursor: `cursor-grab` when `spaceDown || toolMode === 'pan'`, else `cursor-default`.
  - Zoom controls (bottom-left) have `aria-label` + `title` (Zoom out / Zoom in / Reset zoom to 100%).
  - All shape property access MUST be null-safe (`shape?.x ?? 0`) — the LLM can emit patches referencing deleted shapes.
  - Numeric fields used in `toFixed` / `Math.round` MUST be coerced via `Number()` first.
  - **Empty-canvas drop zone**: when `document.shapes.length === 0`, renders a subtle centered placeholder.
  - **Backdrop grid**: uses `color-mix(in oklch, var(--ac-text-primary) 12%, transparent)` for dark-mode-correct dots.
- `Toolbar.tsx`:
  - Floating pill: `absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none` wrapper; inner pill re-enables pointer events.
  - Select/Pan buttons use `aria-pressed={toolMode === 'select'/'pan'}` + `aria-label`.
  - Shape buttons use `disabled={agentBusy}` to prevent race conditions.
  - Clear button uses `disabled={canvasEmpty || agentBusy}`.
  - All buttons are `rounded-full` (pill style).
- `CommandPalette.tsx`:
  - Built on `cmdk` (wrapped by `@/components/ui/command`).
  - Opens via `⌘K` / `⌘K` or the "Ask anything" header button.
  - `PROMPT_GROUPS` is a verbatim copy of `AgentPanel.tsx`'s `PROMPT_GROUPS` (intentional duplication — see X5 in the UI audit; extraction to a shared module is a P3 cleanup).
  - Custom prompt fallback: if query doesn't exactly match a preset, shows a "Send '...' as a custom prompt" item.
  - `runPrompt()` calls `promptAgent(text)` + closes the palette.
- `PropertiesPanel.tsx`:
  - Reads `selectedIds`, looks up the shape, renders a form.
  - Fill + Stroke + Radius + Opacity are wrapped in a single "Style" Collapsible (defaultOpen).
  - Auto Layout, Theme, Slot, Text sections are type-conditional + collapsed by default.
  - Empty state shows Canvas Background + Design Tokens + variables/themes summary (moved here from AgentPanel's status strip).
  - Token access MUST be null-safe: `document.tokens?.colors ?? []`.
- `LayersPanel.tsx`:
  - Renders a flat list of shapes (groups expand inline).
  - Badge cluster: at most 1 visible badge per row by priority (Master > Instance > AL > theme > token). Rest go into the row's `title` attribute.
  - Visibility/lock toggle buttons have `aria-label` + `aria-pressed` + `title`.
  - Context menu: Delete, Duplicate, Rename.
- `AgentPanel.tsx`:
  - Input field is decoupled from the `connected` dependency — works over both WebSocket and HTTP fallback.
  - Send button only renders when `input.trim()` is non-empty (cleaner empty state).
  - Placeholder text includes `(⌘K for prompts)` hint.
  - Empty state shows ⌘K hint + prompt group chips + preset prompt buttons.
  - Each user message has a "Fork from this message" button with `aria-label`.

### React subscription safety (root contract, restated)
- Zustand selectors MUST return stable references.
- The token selector uses a module-level `EMPTY_TOKENS` constant: `useCanvasStore((s) => s.document.tokens ?? EMPTY_TOKENS)`.
- Never write `?? { colors: [], textStyles: [] }` inline — it creates a new object every render and triggers an infinite re-render loop.

## Work Guidance

- When adding a new shape type: update `Canvas.tsx` (rendering), `LayersPanel.tsx` (icon), `PropertiesPanel.tsx` (form fields), `tools.ts` (tool schema + `executeTool` case), `prisma/schema.prisma` (comment in the `type` field).
- When changing the design system: edit `src/app/globals.css` first, then sweep components for hardcoded colors.
- When adding a new panel: follow the 4-pane layout in `src/app/page.tsx` — do not introduce a 5th column without restructuring.
- Capture before/after screenshots to `download/<feature-name>/` for any visual change.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run lint` — ESLint.
- Manual: open the app, verify all 5 panels render, shapes are selectable, properties form edits dispatch updates, agent chat streams.
- `bunx tsx scripts/screenshot-ui-after.ts` — captures 5 states to `download/ui-polish-after/`.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../sessions/AGENTS.md` (Session management UI), `../ui/AGENTS.md` (shadcn/ui primitives).*
