# Menu & Right-Click Implementation Specs

This directory contains the per-item implementation specs for the UI menu overhaul proposed in the [UI Audit & Menu Recommendations](../ui-audit/AgentCanvas-UI-Audit-Menu-Recommendations.pdf) document.

Each P0 item has a focused spec with: goal, files to touch, implementation steps, tests to add, and acceptance criteria.

P1 and P2 items are captured as planning artifacts (less detailed) — they'll be promoted to full specs when their sprints start.

## P0 — Must-Have (next sprint)

| # | Item | Spec |
|---|------|------|
| 1 | Canvas right-click on empty canvas | [P0-01-canvas-empty-right-click.md](./P0-01-canvas-empty-right-click.md) |
| 2 | Canvas right-click on a single shape | [P0-02-canvas-shape-right-click.md](./P0-02-canvas-shape-right-click.md) |
| 3 | Clipboard support (⌘C/V/X/A + useClipboard hook) | [P0-03-clipboard-support.md](./P0-03-clipboard-support.md) |
| 4 | Layers panel expanded context menu (22 items) | [P0-04-layers-panel-expanded-menu.md](./P0-04-layers-panel-expanded-menu.md) |
| 5 | Group / Ungroup shortcuts (⌘G / ⌘⇧G) | [P0-05-group-ungroup-shortcuts.md](./P0-05-group-ungroup-shortcuts.md) |
| 6 | Duplicate shortcut (⌘D) | [P0-06-duplicate-shortcut.md](./P0-06-duplicate-shortcut.md) |
| 7 | Z-order shortcuts (⌘] / [ / ⌘⇧] / [) | [P0-07-zorder-shortcuts.md](./P0-07-zorder-shortcuts.md) |
| 8 | Shape-tool shortcuts (R / O / T / L / F) | [P0-08-shape-tool-shortcuts.md](./P0-08-shape-tool-shortcuts.md) |
| 9 | Inline Stop button below streaming response | [P0-09-inline-stop-button.md](./P0-09-inline-stop-button.md) |
| 10 | Canvas right-click on multi-selection | [P0-10-canvas-multiselect-right-click.md](./P0-10-canvas-multiselect-right-click.md) |
| 11 | Canvas right-click on frame/container | [P0-11-canvas-frame-right-click.md](./P0-11-canvas-frame-right-click.md) |
| 12 | Layers panel header (Expand-all / Search) | [P0-12-layers-header-search-expand.md](./P0-12-layers-header-search-expand.md) |

## P1 — High-Value (planning artifacts)

See [P1-planning.md](./P1-planning.md) for the 18 P1 items as a single planning document.

## P2 — Nice-to-Have (planning artifacts)

See [P2-planning.md](./P2-planning.md) for the 17 P2 items as a single planning document.

## Implementation status

| Sprint | Tier | Items | Status |
|---|---|---|---|
| 1 | P0 | 12 | ✅ Implemented in this work session |
| 2 | P1 | 18 | ⏳ Spec only — pick up next sprint |
| 3 | P2 | 17 | ⏳ Spec only — pick up later |
