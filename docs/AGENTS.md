# AGENTS.md — `docs/`

## Purpose

Durable written documentation: the z.ai sandbox runbook, phase design docs (including the agent parity tracks, chat parity, and lucide-icon integration docs), the speed-parity spec suite, the menu-specs implementation trackers, and the superpowers plans/specs. Design docs are historical records of decisions; the runbook, menu-specs trackers, speed-parity spec, and superpowers plans are living documents.

## Ownership

- `zai-sandbox-setup.md` — the one-shot z.ai sandbox runbook: sandbox model, setup sequence, process-survival rules, verification checklist, troubleshooting. Referenced by the root `AGENTS.md` "z.ai Sandbox Operations" section — keep the two in sync.
- `design-systems.md` — Phase 2 design doc (Figma components/instances/variants/overrides → AgentCanvas component system). Status: Implemented; touchpoints in `src/lib/pen`, `src/lib/canvas`, `src/lib/agent/tools.ts`; tested by `tests/unit/component-system.test.ts`.
- `html-dom-renderer.md` — HTML/DOM canvas renderer design doc + implementation spec, Rev 2 with Figma-ontology alignment. Two tracks, Phases 0–7: renderer track (parity harness → DOM parity mode → native CSS layout → Figma-MCP-aligned agent tools → scale hardening → default flip) + Figma-alignment track (.pen v3 vocabulary unification behind alias compat; Figma UI3 workflows, shortcuts, marquee/deep-select/scale, version-history checkpoints). Status: Proposed — not started; includes the current-state rendering audit (four parallel shape-painters, zero virtualization), the frozen-seam contract (patch ops, tool surface, sync events), Figma REST/MCP/UI research grounding (`scripts/research/r1–r3`), node→DOM/CSS mapping appendices, Figma ontology alignment matrix + UI/shortcut matrix + MCP tool mapping (Appendices G–I), defect inventory D1–D14, test strategy (§10), risk register, and perf gates. Implementing agents must read it end-to-end before touching `src/components/canvas/` or renaming any `pen_*` tool.
- `agentic-workflows.md` — Phase 3 design doc (design-critic reflection sub-agent, pattern-memory RAG, plan-then-execute). Status: Implemented; tested by `tests/unit/agentic-workflows.test.ts`. §8 addendum (2026-08-28) tracks which future-work items have since shipped.
- `agent-performance.md` — Agent Performance Package + todo-batch noise fix + multi-variant parallel generation design doc (round-trip tax, bookkeeping noise, go-wide exploration; wall-clock budgets; final 14-turn matrix measurements). Status: Implemented (2026-08-27/28); tested by `tests/unit/agent-performance-package.test.ts` + `tests/unit/todo-batch-variants.test.ts`.
- `chat-parity.md` — Cursor-class chat/message interface parity plan (2026-09-06): queued messages, live activity timer, inline edit & resend, 👍/👎 feedback, streaming caret, @-mentions (canvas layers), per-document draft persistence, compact empty state, input affordances, a11y. Touchpoints: `src/lib/agent/chat-mentions.ts`, `src/lib/agent/draft-store.ts`, `src/lib/sessions/types.ts` (`Message.feedback`), `src/lib/canvas/store.ts` (`queuedPrompts`); tested by `tests/unit/chat-parity.test.ts`.
- `lucide-icons.md` — Lucide icon integration spec (2026-09-06): real Lucide `icon` nodes replacing hand-drawn `path` polylines. Status: Implemented (2026-09-06); tested by `tests/unit/lucide-icons.test.ts`.
- `superpowers/specs/2026-09-12-designer-workflow-parity-design.md` — Designer Workflow Parity spec: staged lo-fi → approval → hi-fi flow, variant runner-up parking + promotion, component-first construction. Status: Implemented (2026-09-12); Tasks 1–10 merged; tested by `tests/unit/staged-flow-runner.test.ts`, `tests/unit/layout-gate.test.ts`, `tests/unit/layout-approval-card.test.ts`, `tests/unit/alternatives-parked-event.test.ts`, `scripts/agent-eval/scenarios.ts` `staged-dashboard` scenario.
- `superpowers/specs/2026-09-13-landing-page-design.md` — Landing page design spec: cinematic scroll-landing at `/` (6 sections, motion v12 + lenis + Magic UI), workspace moved verbatim to `src/app/app/page.tsx`. Status: Implemented (2026-09-13); plan `superpowers/plans/2026-09-13-landing-page.md`, tested by `tests/unit/landing-*.test.ts(x)` + `scripts/screenshot-landing.ts` visual pass. NOTE: the spec's `number-flow-react` dep name is a typo — the real package is `@number-flow/react`.
- `speed-parity-spec/` — Agent speed parity spec suite (2026-09-10): 10-doc RFC bringing pi-agent generation to industry parity (TTFT + T2C) across complexity tiers. `00-README.md` is the index; the 09 docs cover baseline benchmarks, industry parity targets, bottleneck analysis, canvas simplification, agent-tools simplification, agent behaviors/flows, implementation roadmap (P0–P3), and the permanent benchmark suite. Benchmarks live in `download/speed-bench/`; the `research/` subdirectory carries three measurement runs (before/after P0, P1 repeats, and zai-low baseline). Status: Spec / RFC — milestone-driven; no test coverage yet (the 09 doc defines the benchmark harness).
- `menu-specs/README.md` — P0–P2 menu-item status tracker (P0 12/12 done; P1/P2 partially implemented/stubbed).
- `menu-specs/P0-01…P0-12` — per-item implementation specs (goal / files-to-touch / steps / tests).
- `menu-specs/P1-planning.md`, `menu-specs/P2-planning.md` — per-item implemented/stubbed/deferred status.
- `superpowers/plans/` — implementation plans generated by the superpowers writing-plans skill (5 plans: agent-benchmark-and-behavior-upgrade, comprehensive-testing, designer-workflow-parity, reusable-elements-ui, landing-page). Living documents — updated as tasks are completed.
- `superpowers/specs/` — design specs produced by the superpowers brainstorming skill before their corresponding plans (5 specs: agent-benchmark-and-behavior-upgrade, comprehensive-testing, designer-workflow-parity, reusable-elements-ui, landing-page). Historical design records — keep in sync with the corresponding `superpowers/plans/` entry.

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

## Mistakes & Lessons

### Failure Modes

- Check that a new design doc carries the front-matter block (Status / Spec source / Code touchpoints / Test coverage) before merging it, because docs without it lose traceability to the code that implements them.
- Check menu-specs status counts against shipped features after implementing an item, because stale `stubbed`/`deferred` rows mislead triage.
- Check `zai-sandbox-setup.md` subcommands against `scripts/setup-zai-sandbox.sh` subcommands when either file changes, because the two have drifted before and produced conflicting runbooks.

### Lessons Learned

- Mirror `zai-sandbox-setup.md` changes into the root AGENTS.md "z.ai Sandbox Operations" section (and vice versa) in the same commit, because the two files describe the same runbook and have drifted apart silently.
- Update a spec's menu-specs status line in the same commit that ships the feature, because stale status rows have leaked into triage before.
- Treat `superpowers/specs/` entries as historical design records and `superpowers/plans/` entries as living documents — keep them in sync but do not rewrite the spec when the plan adjusts, because the spec is the decision-of-record.

## Child DOX Index

No child `AGENTS.md` files. `menu-specs/` is spec content, not a contract boundary.
