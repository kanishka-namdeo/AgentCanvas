# AGENTS.md — `src/components/ui/`

## Purpose

shadcn/ui primitives: Radix UI wrappers styled with `class-variance-authority` and Tailwind. These are the building blocks for all higher-level components in `src/components/canvas/` and `src/components/sessions/`.

## Ownership

- Every file in this folder is a shadcn/ui component generated via `bunx shadcn@latest add <component>`.
- The component inventory is registered in `components.json`.
- Owned by the shadcn/ui upstream + the project's `components.json` config. Not owned by any individual feature.

## Local Contracts

### Do not hand-edit
- These files are machine-generated. Do not hand-edit unless:
  1. Syncing with an upstream shadcn/ui release, OR
  2. Applying a project-wide style override that cannot be expressed via the `--ac-*` tokens in `globals.css`, OR
  3. Fixing a clear bug in the generated code, OR
  4. **Upgrading a third-party dependency with breaking API changes** (e.g. the v4/v10/v3 migrations below).
- If you need a variant of a component, create a wrapper in `src/components/canvas/` or `src/components/sessions/` — do not fork the primitive.

### Dependency-migration overrides (post-major-bump, 2026-08)

These `src/components/ui/` files were hand-edited to absorb breaking changes from major dependency upgrades. They are NOT pristine shadcn output anymore:

- **`resizable.tsx`** — migrated to `react-resizable-panels` v4. The wrapper now imports `Group`, `Panel`, `Separator` (renamed from `PanelGroup`, `Panel`, `PanelResizeHandle`). The public names (`ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`) are preserved for call-site stability — only the underlying primitives changed. The wrapper also forwards new v4 props (`orientation`, `defaultLayout`, `onLayoutChanged`, `panelRef`).
- **Other primitives** (`dialog.tsx`, `dropdown-menu.tsx`, `tooltip.tsx`, etc.) — updated via `bun update` within semver range; no hand-edits needed.

(2026-09 dependency-hygiene pass: 20 zero-import primitives — accordion, alert, alert-dialog, aspect-ratio, breadcrumb, calendar, chart, drawer, form, hover-card, input-otp, menubar, navigation-menu, pagination, progress, radio-group, sheet, skeleton, toggle, toggle-group — were deleted after a repo-wide grep proved zero imports, together with their now-orphaned backing deps (recharts, vaul, react-day-picker, react-hook-form, @hookform/resolvers, input-otp, and 10 unused @radix-ui packages) and the never-used embla-carousel-react. `table.tsx` and `avatar.tsx` were KEPT: they are string-referenced by `src/lib/design-systems/registry.json`'s `importMap` (agent guidance + DesignSystemPicker). Re-add any primitive via `bunx shadcn@latest add <name>` if a feature needs it.)

### Style overrides
- The primitives consume CSS variables defined in `src/app/globals.css` (e.g. `--background`, `--foreground`, `--primary`, `--radius`). The `--ac-*` design tokens layer ON TOP of these — components in `canvas/` and `sessions/` use `--ac-*` for semantic spacing/border/text roles.
- Do not introduce a second design token system. If the shadcn variables are insufficient, extend `--ac-*` in `globals.css`.
- **`scroll-area.tsx` — added optional `viewportClassName` prop (2026-09-11).** `className` lands on Radix's `Root`, which is only `position: relative` (not scrollable); the inner `[data-radix-scroll-area-viewport]` carries `overflow: scroll` and is the real scroll container. `viewportClassName` lets a caller tag that inner viewport (e.g. `AgentPanel`'s `.agent-panel-scroll`) so an external `document.querySelector(...).scrollBy()` in `src/app/page.tsx` (⌘↑/⌘↓ chat navigation) scrolls messages. Optional — all existing call sites unaffected.

### Component inventory
- 26 primitives: `avatar`, `badge`, `button`, `card`, `checkbox`, `collapsible`, `command`, `context-menu`, `dialog`, `dropdown-menu`, `input`, `label`, `popover`, `resizable`, `scroll-area`, `select`, `separator`, `slider`, `sonner`, `switch`, `table`, `tabs`, `textarea`, `toast`, `toaster`, `tooltip`. (`carousel`/`sidebar` were listed here previously but never existed as files; the 20 zero-import primitives named above were deleted in the 2026-09 dependency-hygiene pass.)
- Adding a new primitive: `bunx shadcn@latest add <name>`, then verify the import path resolves and the component renders.

## Work Guidance

- Prefer composing these primitives over building raw HTML in feature components.
- If a primitive is missing a needed variant, add the variant to the primitive's `cva` definition (this counts as a project-wide override — document it here).
- The `button.tsx` `cva` already defines `default`, `destructive`, `outline`, `secondary`, `ghost`, `link` variants. New variants go here, not in call sites.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run lint` — ESLint.
- Manual: any feature using the primitive should render without console errors.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../canvas/AGENTS.md` (Canvas UI components), `../sessions/AGENTS.md` (Session management UI), `../settings/AGENTS.md` (Settings dialog).*
