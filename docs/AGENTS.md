# AGENTS.md — `docs/`

## Purpose

Durable written documentation: the z.ai sandbox runbook, phase design docs, and the menu-specs implementation trackers. Design docs are historical records of decisions; the runbook and menu-specs trackers are living documents.

## Ownership

- `zai-sandbox-setup.md` — the one-shot z.ai sandbox runbook: sandbox model, setup sequence, process-survival rules, verification checklist, troubleshooting. Referenced by the root `AGENTS.md` "z.ai Sandbox Operations" section — keep the two in sync.
- `design-systems.md` — Phase 2 design doc (Figma components/instances/variants/overrides → AgentCanvas component system). Status: Implemented; touchpoints in `src/lib/pen`, `src/lib/canvas`, `src/lib/agent/tools.ts`; tested by `tests/unit/component-system.test.ts`.
- `html-dom-renderer.md` — HTML/DOM canvas renderer design doc + implementation spec, Rev 2 with Figma-ontology alignment. Two tracks, Phases 0–7: renderer track (parity harness → DOM parity mode → native CSS layout → Figma-MCP-aligned agent tools → scale hardening → default flip) + Figma-alignment track (.pen v3 vocabulary unification behind alias compat; Figma UI3 workflows, shortcuts, marquee/deep-select/scale, version-history checkpoints). Status: Proposed — not started; includes the current-state rendering audit (four parallel shape-painters, zero virtualization), the frozen-seam contract (patch ops, tool surface, sync events), Figma REST/MCP/UI research grounding (`scripts/research/r1–r3`), node→DOM/CSS mapping appendices, Figma ontology alignment matrix + UI/shortcut matrix + MCP tool mapping (Appendices G–I), defect inventory D1–D14, test strategy (§10), risk register, and perf gates. Implementing agents must read it end-to-end before touching `src/components/canvas/` or renaming any `pen_*` tool.
- `agentic-workflows.md` — Phase 3 design doc (design-critic reflection sub-agent, pattern-memory RAG, plan-then-execute). Status: Implemented; tested by `tests/unit/agentic-workflows.test.ts`. §8 addendum (2026-08-28) tracks which future-work items have since shipped.
- `agent-performance.md` — Agent Performance Package + todo-batch noise fix + multi-variant parallel generation design doc (round-trip tax, bookkeeping noise, go-wide exploration; wall-clock budgets; final 14-turn matrix measurements). Status: Implemented (2026-08-27/28); tested by `tests/unit/agent-performance-package.test.ts` + `tests/unit/todo-batch-variants.test.ts`.
- `menu-specs/README.md` — P0–P2 menu-item status tracker (P0 12/12 done; P1/P2 partially implemented/stubbed).
- `menu-specs/P0-01…P0-12` — per-item implementation specs (goal / files-to-touch / steps / tests).
- `menu-specs/P1-planning.md`, `menu-specs/P2-planning.md` — per-item implemented/stubbed/deferred status.

## Local Contracts

- Design docs carry a front-matter block: Status / Spec source / Code touchpoints / Test coverage — new design docs MUST include it.
- Design docs are historical: append superseded notes, never rewrite decisions.
- `menu-specs/README.md` + P1/P2 planning files are live trackers — update status lines when implementing or stubbing an item.
- `zai-sandbox-setup.md` changes MUST be mirrored in the root `AGENTS.md` "z.ai Sandbox Operations" section (and vice versa).
- Every doc links to its code touchpoints + tests.

## Work Guidance

- New phase design docs land here with the front-matter block and a row in the root Child DOX Index scope description.
- When a spec item ships: update its menu-specs status line in the same commit.

## Verification

- Doc links resolve (relative paths from `docs/`).
- Menu-specs status counts match shipped features.
- `zai-sandbox-setup.md` commands match `scripts/setup-zai-sandbox.sh` subcommands.

## Child DOX Index

No child `AGENTS.md` files. `menu-specs/` is spec content, not a contract boundary.
