# AGENTS.md — `src/components/canvas/`

## Purpose

Canvas UI components: the drawing surface, the toolbar, the layers panel, the properties inspector, and the agent chat panel. These are the primary interactive surfaces the user sees and touches.

## Ownership

- `Canvas.tsx` — the SVG/HTML drawing surface. Renders shapes from `useCanvasStore`. Handles pan/zoom (planned), selection, drag.
- `Toolbar.tsx` — top toolbar: tool selection (Select / Rectangle / Ellipse / Text / Line), zoom controls, background color picker.
- `LayersPanel.tsx` — left panel: shape list with rename / reorder / lock / hide / delete.
- `PropertiesPanel.tsx` — right panel: form for the selected shape's properties (position, size, fill, stroke, text, etc.).
- `AgentPanel.tsx` — bottom panel: chat input + streaming message list + tool-call cards + "Fork from here" button on each user message.

## Local Contracts

### Design token usage (root contract, restated)
- All components MUST consume the `--ac-*` design tokens from `src/app/globals.css` via the utility classes (`.ac-text-1` ... `.ac-text-5`, `.ac-border-subtle` / `.ac-border-default` / `.ac-border-strong`, `.ac-surface-0` ... `.ac-surface-3`, `.ac-active-row`, `.ac-focus-ring`, `.ac-transition`, `.ac-hide-scrollbar`).
- Do NOT hardcode `slate-{n}` / `zinc-{n}` / `gray-{n}` Tailwind color literals. Use the tokens or the `--ac-*` CSS variables directly.
- Status colors (success/warning/error/info) use the `--ac-status-*` OKLCH variables.

### Component contracts
- `Canvas.tsx`:
  - Reads `document.shapes`, `selectedId` from the canvas store.
  - Renders shapes as SVG elements (rectangles, ellipses, lines, text) or HTML (frames/groups).
  - All shape property access MUST be null-safe (`shape?.x ?? 0`) — the LLM can emit patches referencing deleted shapes.
  - Numeric fields used in `toFixed` / `Math.round` MUST be coerced via `Number()` first.
- `PropertiesPanel.tsx`:
  - Reads `selectedId`, looks up the shape, renders a form.
  - Form fields dispatch `canvas_update_shape` via the canvas store (NOT the agent) for direct edits.
  - Token access MUST be null-safe: `document.tokens?.colors ?? []`, `document.tokens?.textStyles ?? []`.
  - Header uses uppercase + tracking-wide per the design system.
- `LayersPanel.tsx`:
  - Renders a flat list of shapes (groups expand inline).
  - Active row uses `.ac-active-row` (2px left accent bar + soft violet bg).
  - Empty state: friendly message + CTA.
- `AgentPanel.tsx`:
  - Input field is decoupled from the `connected` dependency — it works over both WebSocket and HTTP fallback. Do not re-couple.
  - Send button is grouped INSIDE the textarea container (single visual unit). Disabled Send shows 40% opacity + `not-allowed` cursor.
  - Accepts a `hideHeader` prop (the `SessionHeader` component replaces the inline header when in the 4-pane layout).
  - Each user message has a "Fork from here" button.
  - Prompt suggestion cards show a send-arrow affordance on hover.

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

No child `AGENTS.md` files. This folder is flat.
