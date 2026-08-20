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
- **`calendar.tsx`** — migrated to `react-day-picker` v10. The `table` key in the `classNames` prop was renamed to `month_grid` (v10 renamed the underlying UI enum value from `UI.Table` to `UI.MonthGrid`). All other class keys are unchanged.
- **`chart.tsx`** — migrated to `recharts` v3. The `Tooltip` and `Legend` payload types in v3 gained many internal fields (`graphicalItemId`, etc.) that we don't use. We replaced the strict `React.ComponentProps<typeof RechartsPrimitive.Tooltip>['payload']` with a local `TooltipPayload = Array<Record<string, any>>` to avoid leaking recharts internals into the public API. Same for `LegendPayload`. The `formatter` prop signature also uses `any` to stay compatible with both v2 and v3 callers. (Note: this file is currently NOT consumed by any feature — it's a shadcn primitive reserved for future use.)
- **Other primitives** (`accordion.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `tooltip.tsx`, etc.) — updated via `bun update` within semver range; no hand-edits needed.

### Style overrides
- The primitives consume CSS variables defined in `src/app/globals.css` (e.g. `--background`, `--foreground`, `--primary`, `--radius`). The `--ac-*` design tokens layer ON TOP of these — components in `canvas/` and `sessions/` use `--ac-*` for semantic spacing/border/text roles.
- Do not introduce a second design token system. If the shadcn variables are insufficient, extend `--ac-*` in `globals.css`.

### Component inventory
- ~50 primitives: `accordion`, `alert`, `alert-dialog`, `aspect-ratio`, `avatar`, `badge`, `breadcrumb`, `button`, `calendar`, `card`, `carousel`, `chart`, `checkbox`, `collapsible`, `command`, `context-menu`, `dialog`, `drawer`, `dropdown-menu`, `form`, `hover-card`, `input`, `input-otp`, `label`, `menubar`, `navigation-menu`, `pagination`, `popover`, `progress`, `radio-group`, `resizable`, `scroll-area`, `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `slider`, `sonner`, `switch`, `table`, `tabs`, `textarea`, `toast`, `toaster`, `toggle`, `toggle-group`, `tooltip`.
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
