# AGENTS.md — `src/components/canvas/`

## Purpose

Canvas UI components: the drawing surface, the floating toolbar, the command palette, the layers panel, the properties inspector, the agent chat panel (with the interactive plugin-UI bundle), the top menu bar, the .pen file menu, and the keyboard shortcuts dialog. These are the primary interactive surfaces the user sees and touches.

## Ownership

- `Canvas.tsx` — the infinite canvas **shell**. Owns viewport state, gestures, selection/drag/resize interaction, agent-highlight ids, and right-click context menus, but no longer paints shapes itself: it renders `svg/SvgCanvas` (classic, default) or `dom/DomCanvas` (DOM parity mode) per the `renderer` setting and passes them identical callback props. Shape data comes from `useCanvasStore`. Handles pan (middle-mouse / space-drag / pan-tool), zoom (wheel, pointer-stable), click-to-select, drag-to-move, 8-handle resize, Alt+drag duplicate (Figma pattern), Shift-constrain resize (aspect ratio lock), and right-click context menus (empty-canvas + shape variants with cut/copy/paste/z-order/group/ungroup/lock/hide/delete).
- `svg/ShapeRenderer.tsx` — classic renderer, per-layer SVG element factory (extracted verbatim from Canvas.tsx): gradients (linear/radial defs), shadow/blur SVG filters, all 17 LayerTypes, selection outline + 8 zoom-compensated resize handles, agent-highlight pulse, component M/I badges, auto-layout indicator. Exports `ResizeHandle`, `HANDLE_SIZE`, `MIN_SIZE`, `handlePosition`, `cursorForHandle`.
- `svg/SvgCanvas.tsx` — classic renderer surface: the single `<svg>` + `<defs>` (component-hatch pattern, per-`clip:true`-frame clipPaths) + flat dedupe-by-id/zIndex-sorted shape loop with nearest-clipping-ancestor lookup. Consumed by `Canvas.tsx`.
- `Toolbar.tsx` — **floating pill** at the bottom-center of the canvas (tldraw/Excalidraw pattern). Tool buttons: Select (V), Pan (H), Rectangle, Ellipse, Text, Line, Frame, Clear, plus Undo and Redo buttons (disabled when `!canUndo`/`!canRedo` or `agentBusy`). Shape buttons are `disabled` when `agentBusy`. Clear is `disabled` when canvas is empty. Select/Pan buttons toggle `toolMode` in the store with `aria-pressed`.
- `CommandPalette.tsx` — ⌘K command palette (Dialog + cmdk). Fuzzy-searchable list of all 19 preset prompts grouped by category (Designs, User Flows, Diagrams, Design Systems, Analysis, Layers & Layout). Supports custom free-form prompts as a fallback. Opens via `⌘K`. Prompt items disabled when `agentBusy`.
- `LayersPanel.tsx` — left panel: tree-ordered shape list with per-type icons, expand/collapse containers (state persisted in localStorage), drag-to-reparent (HTML5 DnD, emits `reparent` patch), search/filter by name, rename (double-click or context menu), lock/hide toggles, badge cluster (Master > Instance > AL > theme > token > constraints; at most 1 visible per row, rest in hover tooltip). Rich context menu: clipboard (cut/copy/paste/paste-in-place/duplicate), z-order (4 items), group/ungroup, lock/hide, create component, mark as slot, copy-as submenu (HTML/React/Tailwind/SVG/JSON), export submenu (PNG/SVG/.pen), select all children, expand/collapse subtree, apply theme axis, bind to token, reparent-to picker, rename, duplicate, delete. Footer shows document variable + theme-axis counts.
- `PropertiesPanel.tsx` — right panel tab (Design): form for selected shape(s). Multi-selection shows quick actions (duplicate, group, ungroup, 6 align, 2 distribute). Single-selection shows: Name, Parent picker (reparent dropdown), Component master/instance info (with **Detach** + **Reset overrides** action buttons when an instance is selected — Phase 2 component-system), Position (X/Y), Size (Width/Height), Constraints (Figma-style horizontal/vertical), Style Collapsible (Fill + Stroke + Radius + Opacity, defaultOpen), Auto Layout (frame/group only; direction/gap/padding/justify/align), Theme (per-axis selector + clear), Slot (frames only; mark-as-slot flow), Text (text shapes only; content/font-size/color). All numeric inputs + color swatches support right-click Copy/Paste value. Empty state shows Canvas Background + Design Tokens + variables/themes summary.
- `AgentPanel.tsx` — right panel tab (Chat): chat input + streaming message list + tool-call cards (color-coded by category) + inline Stop button (when agent busy) + "Fork from this message" button on each user message. Accepts `hideHeader` prop (SessionHeader `compact` variant sits in the top header of the 3-column tabbed layout). Right-click context menus on user messages (copy prompt, edit & resend, fork, pin, delete), assistant messages (copy, regenerate, branch, replay, pin), and tool-call cards (copy args, replay, pin, view raw, convert, inspect spec). Status strip removed — moved to PropertiesPanel empty state. Send button only renders when there's input. Placeholder includes `(⌘K for prompts)` hint.
  **Chat UX layer (research-driven — NN/g "Prompt Controls in GenAI Chatbots" + AI Chat Interface Playbook patterns):**
  - **Markdown responses** — assistant text renders via `Markdown.tsx` (react-markdown; lists, bold, tables, fenced code blocks with click-to-copy). No syntax-highlight lib in chat by design (bundle weight).
  - **Follow-up chips** — after the last completed assistant turn, `FollowUps` (in AgentPanel) shows 3-4 contextual "What next?" suggestions from the pure engine `src/lib/agent/followups.ts` (derives from the turn's tool trajectory + canvas state: wireframe → hi-fi upgrade, palette → apply/bind, no variables → extract tokens, evergreen fallbacks).
  - **Slash commands** — typing `/` opens an autocomplete (`src/lib/agent/chat-commands.ts` registry): canvas utilities (/clear /undo /redo /new /select-all), instant exports (/export-svg /export-png /export-json), and prompt shortcuts (/audit /dark /icons /copy /organize with optional trailing args). Keys: ↑↓ navigate, Tab completes, Enter executes, Esc dismisses. Action commands run client-side (store patches + export helpers); unknown commands error with a hint.
  - **Prompt history** — terminal-style recall (`src/lib/agent/prompt-history.ts`, persisted to `localStorage:agentcanvas.prompthistory.v1`, cap 50, consecutive de-dup). ArrowUp recalls when input empty or navigating; ArrowDown returns to live input at position -1.
  - **Turn meta** — each completed assistant turn shows "N tools · Xs" (from `ChatTurn.startedAt`/`endedAt`, set by the store at assistant-turn creation and turn_end/message_end-cancel finalization).
- `PluginUI.tsx` — interactive plugin-UI bundle mounted inside AgentPanel: `AskUserQuestionDialog` (modal that resolves the agent's `ask_user_question` tool call via canvas-store `submitQuestionAnswers` → POST `/api/agent/answers`), `TodoOverlay` (live agent task list with status icons/colors), `BackgroundTaskList` (polled background-task statuses). All driven by canvas-store plugin state (`pendingQuestion`, `todos`, `backgroundTasks`).
- `TopMenuBar.tsx` — application menu bar (28px height, below the header). Six menus: File (new chat, open/import/export .pen, export PNG/SVG/JSON, settings), Edit (undo/redo, cut/copy/paste, duplicate, select/deselect all, delete), View (toggle panels, zen, dark mode, grid/snap), Insert (drop shapes at viewport center: rectangle/ellipse/text/line/frame/path/image), Object (group/ungroup, z-order, align/distribute submenus, lock/hide, reparent), Help (keyboard shortcuts, .pen spec, GitHub, about). Shortcut hints shown via `<MenubarShortcut>`. All items dispatch to canvas store actions, `useClipboard`, or panel state setters.
- `PenFileMenu.tsx` — dropdown for .pen file operations. Export: POST `/api/pen/export` with live CanvasDocument, downloads as `.pen` blob. Import: file picker → JSON.parse → POST `/api/pen/import` → applies returned patches through the store (undoable + broadcast). Shows busy indicator during operations.
- `KeyboardShortcutsDialog.tsx` — searchable modal listing all wired keyboard shortcuts, grouped by category (Panels, Navigation, Edit, Tools, Clipboard, Structure, Z-order, Canvas, Properties, Chat, File). Tier badges (P0/P1/P2/Existing) with color coding. Opens via ⌘/ (mirrors Figma's Ctrl+Shift+? cheat sheet). Filters by action, keys, category, or tier.

## Local Contracts

### Design token usage (root contract, restated)
- All components MUST consume the `--ac-*` design tokens from `src/app/globals.css` via the utility classes (`.ac-text-1` ... `.ac-text-5`, `.ac-border-subtle` / `.ac-border-default` / `.ac-border-strong`, `.ac-surface-0` ... `.ac-surface-3`, `.ac-active-row`, `.ac-focus-ring`, `.ac-transition`, `.ac-hide-scrollbar`).
- Do NOT hardcode `slate-{n}` / `zinc-{n}` / `gray-{n}` Tailwind color literals. Use the tokens or the `--ac-*` CSS variables directly.
- Status colors (success/warning/danger/info/neutral) MUST use the semantic utility classes:
  - `.ac-status-{info|success|warning|danger|neutral}` — bg + fg + border (use on badges, pills, chips).
  - `.ac-text-{info|success|warning|danger|neutral}` — text color only (use on inline icons, captions).
  - `.ac-dot-{info|success|warning|danger|neutral}` — solid fill color (use on indicator dots).
  - `.ac-hover-{info|success|warning|danger|neutral}:hover` — soft background on hover.
  - These resolve to `--ac-{tone}{,-fg,-soft,-border}` tokens and adapt to light/dark mode automatically.
- **Canvas SVG colors** MUST use the `--ac-canvas-*` tokens defined in `src/app/globals.css`:
  - `--ac-canvas-bg` — default canvas background (slate-50 light / dark slate dark).
  - `--ac-canvas-grid` — dot grid color.
  - `--ac-canvas-default-fill` — default shape fill (rectangle/path/image/component/instance/boolean).
  - `--ac-canvas-default-stroke` — default shape stroke (group/section/component_set).
  - `--ac-canvas-default-text` — default text/line fill.
  - `--ac-canvas-accent-fill` — warm accent fill (ellipse/star/polygon).
  - `--ac-canvas-selection` — selection outline + handle stroke.
  - `--ac-canvas-component` — component master badge + slice stroke.
  - `--ac-canvas-instance` — instance badge.
  - `--ac-canvas-highlight` — hover/agent-highlight outline + boolean_operation stroke.
  - `--ac-canvas-autolayout` — auto-layout indicator (dashed border + "AL" badge) + slice overlay.
  - `--ac-canvas-handle-fill` — selection handle interior fill.
  - **No hardcoded hex colors** (`#0ea5e9`, `#a855f7`, `#f59e0b`, etc.) are allowed in `Canvas.tsx` or `Toolbar.tsx` — use the tokens above so the canvas adapts to dark mode like the rest of the UI.

### Component contracts
- `Canvas.tsx`:
  - Reads `document.shapes`, `selectedIds`, `toolMode` from the canvas store.
  - `toolMode === 'pan'` makes click-drag pan the canvas (same as Space-held). `onShapeMouseDown` returns early in pan mode (no selection).
  - Cursor: `cursor-grab` when `spaceDown || toolMode === 'pan'`, else `cursor-default`.
  - Zoom controls (bottom-left) have `aria-label` + `title` (Zoom out / Zoom in / Reset zoom to 100%).
  - All shape property access MUST be null-safe (`shape?.x ?? 0`) — the LLM can emit patches referencing deleted shapes.
  - Numeric fields used in `toFixed` / `Math.round` MUST be coerced via `Number()` first.
  - **Empty-canvas drop zone**: when `document.shapes.length === 0`, renders a subtle centered placeholder (dashed border, blurred bg, violet icon tile, "Empty canvas" heading + subtitle + tip). `pointer-events: none`. Fades in via `ac-fade-in`. Disappears when first shape is added.
  - **Backdrop grid**: uses `color-mix(in oklch, var(--ac-text-primary) 12%, transparent)` for dark-mode-correct dots.
  - **Right-click context menu**: empty-canvas variant (paste, paste-in-place, select all, clear selection, zoom in/out/reset) and shape variant (cut/copy/paste/paste-in-place/duplicate, z-order 4-way, group/ungroup, lock/hide, delete). Selects shape under cursor if not already selected.
  - **Alt+drag duplicate**: on mouse-up, if Alt was held at drag-start, emits `duplicate` patch + reverts originals to start position.
  - **Shift-constrain resize**: locks aspect ratio to original shape's ratio during resize.
  - **Nested shape move/resize**: subtracts parent's absolute position to convert to relative coords before emitting patches.
- `Toolbar.tsx`:
  - Floating pill: `absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none` wrapper; inner pill re-enables pointer events.
  - Select/Pan buttons use `aria-pressed={toolMode === 'select'/'pan'}` + `aria-label`.
  - Shape buttons use `disabled={agentBusy}` to prevent race conditions.
  - Clear button uses `disabled={canvasEmpty || agentBusy}`.
  - All buttons are `rounded-full` (pill style).
- `CommandPalette.tsx`:
  - Built on `cmdk` (wrapped by `@/components/ui/command`).
  - Opens via `⌘K` or the "Ask anything" trigger.
  - `PROMPT_GROUPS` is a verbatim copy of `AgentPanel.tsx`'s `PROMPT_GROUPS` (intentional duplication — extraction to a shared module is a P3 cleanup).
  - Custom prompt fallback: if query doesn't exactly match a preset, shows a "Send '...' as a custom prompt" item.
  - `runPrompt()` calls `promptAgent(text)` + closes the palette.
- `PropertiesPanel.tsx`:
  - Reads `selectedIds`, looks up shape(s), renders form.
  - Fill + Stroke + Radius + Opacity are wrapped in a single "Style" Collapsible (defaultOpen).
  - Auto Layout, Theme, Slot, Text sections are type-conditional + collapsed by default.
  - Empty state shows Canvas Background + Design Tokens + variables/themes summary (moved here from AgentPanel's status strip).
  - Token access MUST be null-safe: `document.tokens?.colors ?? []`.
  - Multi-selection: shows quick actions grid (duplicate, group, ungroup, 6 align, 2 distribute).
  - Single-selection: Name, Parent picker, Component info, Position, Size, Constraints, Style, Auto Layout, Theme, Slot, Text.
  - Color swatches + numeric inputs support right-click Copy/Paste value via ContextMenu.
- `LayersPanel.tsx`:
  - Renders a tree of shapes (containers expand/collapse inline). Expand state persisted per-document in localStorage.
  - Per-type lucide icons covering all 8 ShapeType values.
  - Badge cluster: at most 1 visible badge per row by priority (Master > Instance > AL > theme > token > constraints). Rest go into the row's `title` attribute.
  - Visibility/lock toggle buttons have `aria-label` + `aria-pressed` + `title`.
  - Drag-to-reparent: HTML5 DnD, drops onto container rows or empty area (→ root). Emits `reparent` patch with `keepAbsolutePosition=true`.
  - Search filter: matches by name (case-insensitive), shows matching shapes + their ancestors.
  - Expand-all / Collapse-all buttons in header.
  - Context menu: clipboard, z-order, group/ungroup, lock/hide, create component, mark as slot, copy-as submenu, export submenu, select all children, expand/collapse subtree, apply theme axis, bind to token, reparent-to, rename, duplicate, delete.
  - Footer: document variable + theme-axis counts.
- `AgentPanel.tsx`:
  - Input field is decoupled from the `connected` dependency — works over both WebSocket and HTTP fallback.
  - Send button only renders when `input.trim()` is non-empty (cleaner empty state).
  - Placeholder text includes `(⌘K for prompts)` hint.
  - Empty state shows "How does this work?" card + ⌘K hint + prompt group chips + preset prompt buttons.
  - Each user message has a "Fork from this message" button with `aria-label`.
  - Accepts `hideHeader` prop (the compact `SessionHeader` component sits in the top header of the 3-column tabbed layout).
  - Inline Stop button appears next to streaming response when `agentBusy`.
  - Right-click context menus on user messages, assistant messages, and tool-call cards.
- `TopMenuBar.tsx`:
  - Accepts callback props for all menu actions (`onOpenSettings`, `onOpenCommandPalette`, `onToggleZen`, `onToggleTheme`, `onToggleLeftPanel`, `onToggleRightPanel`, `onNewChat`, `onExportPen`, `onImportPen`, `onOpenShortcuts`).
  - Uses `useClipboard` hook for cut/copy/paste operations.
  - `dropShape` helper places new shapes at viewport center.
  - `zorder` helper emits z-order patches against current selection.
  - All shortcut hints shown via `<MenubarShortcut>` are wired in `src/app/page.tsx`'s keydown handler.
- `PenFileMenu.tsx`:
  - Reads `document` + `sendPatch` from canvas store.
  - Export: POST to `/api/pen/export`, downloads response as blob.
  - Import: file picker → JSON.parse → POST to `/api/pen/import` → applies returned patches via `sendPatch`.
  - Shows busy indicator (fixed bottom-right) during operations.
- `KeyboardShortcutsDialog.tsx`:
  - Accepts `open` + `onOpenChange` props.
  - `SHORTCUTS` array: 46 entries across P0/P1/P2/Existing tiers.
  - Filters by action, keys, category, or tier (case-insensitive).
  - Groups by category for display.
  - Tier badges color-coded: P0=rose, P1=amber, P2=blue, Existing=slate.

### React subscription safety (root contract, restated)
- Zustand selectors MUST return stable references.
- The token selector uses a module-level `EMPTY_TOKENS` constant: `useCanvasStore((s) => s.document.tokens ?? EMPTY_TOKENS)`.
- Never write `?? { colors: [], textStyles: [] }` inline — it creates a new object every render and triggers an infinite re-render loop.

## Work Guidance

- When adding a new shape type: update `Canvas.tsx` (rendering), `LayersPanel.tsx` (icon in `TYPE_ICON`), `PropertiesPanel.tsx` (form fields), `tools.ts` (tool schema + `executeTool` case), `prisma/schema.prisma` (comment in the `type` field).
- When changing the design system: edit `src/app/globals.css` first, then sweep components for hardcoded colors.
- When adding a new panel: follow the 3-column tabbed layout in `src/app/page.tsx` — do not introduce a new column without restructuring.
- When adding a new keyboard shortcut: add it to `KeyboardShortcutsDialog.tsx`'s `SHORTCUTS` array + wire it in `src/app/page.tsx`'s keydown handler + show it as a hint in `TopMenuBar.tsx` if applicable.
- Capture before/after screenshots to `download/<feature-name>/` for any visual change.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run lint` — ESLint.
- Manual: open the app, verify all panels render, shapes are selectable, properties form edits dispatch updates, agent chat streams, menu bar items work, ⌘K palette opens, ⌘/ shortcuts dialog opens, .pen export/import works.
- `bunx tsx scripts/screenshot-ui-after.ts` — captures 5 states to `download/ui-polish-after/`.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../sessions/AGENTS.md` (Session management UI), `../ui/AGENTS.md` (shadcn/ui primitives).*
