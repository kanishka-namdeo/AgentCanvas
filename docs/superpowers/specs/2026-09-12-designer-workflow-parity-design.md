# Designer Workflow Parity — Staged Design Flow, Explorations Parking, Component-First Construction

- **Status**: Proposed (spec approved 2026-09-12; research-grounded 2026-09-12, §9; implementation not started)
- **Spec source**: Brainstorming session 2026-09-12 ("match the canvas and agent's capabilities to a designer's Figma dashboard process"). Approach B approved: reuse the PLAN-mode gate pattern for the staged flow.
- **Code touchpoints**:
  - `src/lib/agent/runner-native.ts` (staged-flow detection + directive injection + approval flow), `src/lib/agent/modes.ts` / `src/lib/agent/prompt-intent.ts` (detection helper), `src/lib/agent/plan-tools.ts` + `plan-gate.ts` (`submit_layout_approval` gate tool), `src/lib/agent/runner-legacy.ts` (system prompt + PROMPT_VERSION bump)
  - `src/lib/agent/subagents/variant-generator.ts` (runner-up parking + thumbnails)
  - `src/lib/canvas/patch.ts` (`add_subtree` page target), `src/lib/canvas/journal-fold.ts` (`variant_promote` row kind), `src/lib/canvas/types.ts` (SyncEvent additions)
  - `src/lib/agent/validators.ts` (repeated-structure check)
  - `src/components/canvas/AgentPanel.tsx` (promote card) + new card component
  - `src/app/api/documents/[id]/variants/promote/route.ts` (new)
  - `src/app/api/agent/plans/route.ts` (accept `kind: 'layout'` approvals)
- **Test coverage** (planned): unit tests for detection helper, gate tool + post-approval hard stop, `add_subtree` page-target applier, `variant_promote` journal-fold row, validator signature scan, variant parking serialization; agent-eval staged-flow scenario. Details in §8.

---

## 1. Problem

The agent's default generation flow is prompt → design brief → one-shot hi-fi render. A working Figma designer's process is staged: brief → lo-fi layout exploration → direction approval → componentization → hi-fi fidelity pass → precision → review. The tool surface already covers every step individually (lo-fi wireframe generator, variant exploration, component tools, VLM critique), but the *process shape* is inverted: the user sees only the finished hi-fi artifact, exploration losers are discarded, and repeated structures are authored as bespoke subtrees.

Three gaps, approved to fix together:

1. **No staged lo-fi → approval → hi-fi flow** for screen-scale creation prompts.
2. **Variant runner-ups are discarded** instead of parked for the user to compare and swap.
3. **No component-first construction rule** — repeated structures (KPI cards, rows) are duplicated bespoke, so restyles don't propagate.

## 2. Non-goals

- No global setting for the staged flow (user decision: the agent asks per screen-scale prompt; no Settings toggle, no slash command in V1).
- Variant exploration and the staged flow remain mutually exclusive in V1: ambiguous-creation prompts (the variant-dispatch condition) skip the staged ask and run today's variant behavior (with §4 parking added). A combined "explore directions at lo-fi" option is a noted future extension.
- No changes to the design-critique mode default (stays manual/off-by-default per existing user preference).
- No componentization of `pen_generate_wireframe` / composite-template output.

## 3. Section 1 — Staged design flow

### 3.1 Detection

Pure helper `shouldOfferStagedFlow({ prompt, canvasEmpty, mode, repeatCount, ... })` in `prompt-intent.ts` (co-located with `looksLikeEditReference` — the pure-prompt-heuristics home). Fires only when ALL of:

- `mode === 'build'` and no repeat-prompt/abuse guard is active (`repeatCount < 2`);
- the prompt is creation-shaped — NOT an edit reference (`looksLikeEditReference(prompt) === false`);
- the canvas is empty, OR the prompt carries an explicit new-screen intent (page/screen/dashboard/landing vocabulary — classifier keyword pass is the reference implementation for vocabulary);
- the prompt itself does not opt out (contains a "don't ask / directly / no wireframe" style override phrase);
- the variant-dispatch condition is NOT met (mutual exclusion, §2).

False-positive cost is one `ask_user_question`; false-negative cost is today's one-shot behavior. Bias the helper toward firing on genuine full-screen asks only.

### 3.2 The ask

When detection fires, the runner injects a STAGED FLOW directive into the first user message (same injection channel as the design brief and the empty-canvas edit guard): the agent's FIRST action must be one `ask_user_question` with two options — "Lo-fi layout first (recommended)" and "Straight to hi-fi". If the user picks hi-fi, the ask times out, or the ask errors, the turn proceeds exactly as today (one-shot).

### 3.3 Lo-fi phase

The agent generates the layout skeleton: `pen_generate_wireframe(fidelity: 'lofi')` for template-shaped screens, or a gray-box `pen_create_subtree` for novel layouts — guided by the pre-generated design brief's IA list (the brief is still pre-generated; it informs structure, and its palette stays unused until hi-fi).

Enforcement is in the tool registry, not the prompt: the lo-fi session's LLM-visible toolset is the wireframe-skill set minus the hi-fi styling composites (`pen_apply_design_system`, `pen_apply_typography`, styling/variable/token tools). The session ends its generation phase by calling the new gate tool:

**`submit_layout_approval`** — PLAN-mode `submit_plan` analog. Payload: ordered layout summary (sections, their contents, notable placement decisions) rendered by the approval card. The tool is registered ONLY when the staged flow is active (same registration discipline as `submit_plan` in PLAN mode). On call it creates a pending approval in the gate map and blocks the session (`planCompletionBlocker`-style terminal errors for every subsequent tool in the lo-fi session).

### 3.4 The gate (reuse PLAN-mode machinery)

- Gate state: `plan-gate.ts` pending map gains a `kind: 'plan' | 'layout'` discriminator (additive; default `'plan'`).
- Event: `agent:plan_proposed` payload carries `kind: 'layout'` + the layout summary. **No new SyncEvent type** — the payload field is additive and `_onSync`/route forwarding need no new cases.
- Card: `PlanApprovalCard` renders the layout summary (steps list fits the layout-sections payload) with Approve / Revise; a small "Layout approval" label distinguishes it from plan approvals.
- **Revise**: feedback is delivered to the lo-fi session as a new user message (gate re-arms after the agent reworks the lo-fi and calls `submit_layout_approval` again). The post-approval hard stop does NOT engage on revise.
- **Approve** (`POST /api/agent/plans` with `'build'`): exactly PLAN mode's existing flow — dispose the lo-fi session, create a second session with the full build toolset (mode filter removed, gate tool absent), whose first user message carries:
  - the original prompt verbatim,
  - the approved layout summary,
  - the design brief,
  - the instruction: *"Apply the hi-fi pass to this approved structure. Do not change the information architecture, layout skeleton, or section ordering — upgrade fidelity only (palette, typography, spacing, shadows, real content, components)."*
- The execution session runs the normal validation gate (`validateCanvasBeforeComplete`) and the existing manual-default critique policy.

### 3.5 Canonical sequence

```
prompt (screen-scale, empty canvas)
  → runner: design brief pre-generated; STAGED FLOW directive injected
  → agent: ask_user_question("Lo-fi first?")
      ├─ "Straight to hi-fi" → today's one-shot turn (unchanged)
      └─ "Lo-fi first"
          → agent: lo-fi skeleton on canvas (lofi fidelity, styling tools absent)
          → agent: submit_layout_approval → PlanApprovalCard ("Layout approval")
              ├─ Revise + feedback → rework → gate re-arms
              └─ Approve → new build session: hi-fi pass on the approved skeleton
                  → validation gate → turn_end
```

## 4. Section 2 — Explorations page + promote card

### 4.1 Parking runner-ups

After `dispatchVariantGeneration` applies the winner to the main page:

- Each runner-up's node tree (already a `PenChild` tree post-`coerceNodeTree`) is wrapped in a labeled `section` node — `"Variant B — 7.2"` (name + judge score) — and written to a page named **Explorations**, created via the existing page ops if absent.
- Patch-layer extension: `add_subtree` (and `bulk_add`) payloads gain an optional `page` target (page name or index). The applier's pages write-back honors the target page instead of `pages[activePageIndex]`; a `page` name that matches nothing is a hard error in the patch applier (the tool creates the page first). Consumers that switch on CREATE ops (`store.ts` `agentAddedShapesThisTurn`, `turn-diff.ts` `CREATE_OPS`, `AgentPanel.tsx` diff-chip tone) treat off-page adds as creating but must NOT viewport-reveal to them — the chat card (§4.3) is the discovery surface.
- Pruning: parked sections are pruned FIFO at **5** per document (oldest removed when a new set is parked).

### 4.2 Thumbnails

The variant generator already renders each candidate off-canvas for judging. It additionally captures a small per-variant PNG via the existing resvg path (~480px wide) into the tool result (`alternatives: [{ id, name, score, thumbnail }…]`). Total thumbnail budget ≈ 3 × 100 KB; over-budget drops thumbnails, never the trees.

### 4.3 Promote card

- New chat result card (AgentPanel area) emitted when alternatives were parked, listing each: thumbnail, name, score, **"Use this"** button. Also shows the currently-applied design as "In use".
- Event: new SyncEvent `agent:alternatives_parked` `{ page, sections, alternatives, runId }` (new `_onSync` case + `/api/agent` route forwarding case — both enumerated-switch additions per the canvas/agent DOX contracts).
- **Promote**: `POST /api/documents/[id]/variants/promote` `{ sectionId | variantId }`:
  1. 409 if a run is active (run-registry atomic claim check).
  2. Server-side swap on the journal-fold-authoritative document: chosen variant tree → main page (replacing the current root design), previously-applied design → parked into a labeled Explorations section.
  3. Journal a new `variant_promote` row kind (payload: moved/removed/parked node ids + trees) with a journal-fold case so the swap replays across restarts; tombstone lane updated for removed ids.
  4. Broadcast `canvas:full` (reason `variant_promote`) to all subscribers; clients apply via the existing full-sync path. The client's `_onSync` full-sync handling treats the `variant_promote` reason like `restore` for queue-clearing (offline outbox dropped — restore re-orders intent) and synchronous application; this is a small condition addition to the existing reason switch, not a new event case. Client undo stacks do NOT cover the swap (same semantics as `document:restore`).
- Swapping back = promoting the parked previous design from the card. The card persists in the transcript.

## 5. Section 3 — Component-first construction

### 5.1 System-prompt rule

Added to DESIGN PRINCIPLES / COMPONENT RECIPES in `SYSTEM_PROMPT_TEMPLATE` (`PROMPT_VERSION` bump):

> When a screen contains ≥3 identical repeated structures (KPI cards, list rows, nav items, table rows), build ONE component (`figma_create_component` or `pen_convert_to_component`) and place instances (`pen_place_component_instance`) instead of duplicating bespoke subtrees. Style the main component; instances inherit.

### 5.2 Validator check

`validators.ts` gains `repeatedStructureWithoutComponents(shapes, opts)`:

- Depth-limited (≤4) structural-signature scan of sibling groups: signature = ordered node-type tree shape + child counts, ignoring text content, fills, and geometry values.
- Fires when ≥3 siblings share one signature AND none is a `ref`/component instance → validation failure reason "N repeated structures — build a component and place instances" (feeds the existing fix re-prompt loop).
- Engages ONLY when: (a) the turn's construction used create/subtree tools with ZERO generate-template calls (`pen_generate_wireframe`, composites) — template output legitimately repeats and is exempt; (b) component tools were in the LLM-visible toolset for that turn. The runner threads both flags into the validation call.
- Signature computation is O(n) over created nodes, depth-capped — no measurable cost to the 4k-node audit path.

## 6. Interactions & invariants

- **PLAN mode**: unaffected. `submit_layout_approval` registers only in the staged flow; `submit_plan` only in PLAN mode. The gate map discriminates by `kind`.
- **Critique**: the execution session's hi-fi pass runs the existing manual-default critique policy unchanged.
- **One-shot turns**: byte-identical behavior when detection doesn't fire or the user picks hi-fi.
- **Conversational-first identity**: preserved — the staged flow adds exactly one interrupt (the ask) and one approval card, only for screen-scale creation on empty canvases.
- **Tool-schema byte budget**: `submit_layout_approval` uses a compact schema (see `pen_create_node`-owns-full-schema convention); net budget impact must stay within the ~43k-char envelope (measure with `scripts/measure-tool-cost.ts`).
- **Breaking-change discipline**: no tool renames/removals; all event changes additive.

## 7. DOX pass (planned)

Implementation updates: `src/lib/agent/AGENTS.md` (runner staged flow, plan-tools/gate, validators, PROMPT_VERSION), `src/lib/agent/subagents/AGENTS.md` (variant parking + thumbnails), `src/lib/canvas/AGENTS.md` (patch page-target, journal-fold row, SyncEvent additions), `src/components/canvas/AGENTS.md` (promote card), `src/app/api/AGENTS.md` (promote route), and the `docs/` ownership row for this spec. Root Child DOX Index rows only if scope descriptions change.

## 8. Verification plan

Implementation sequencing (approved): **§5 component-first first** (isolated, smallest) → **§4 Explorations parking + promote card** (medium) → **§3 staged flow** (largest; reuses the gate/card §4 touches).

| Layer | Test |
|---|---|
| Detection | Unit: `shouldOfferStagedFlow` truth table (edit-ref, repeat-prompt, opt-out phrase, variant overlap, non-build mode) |
| Gate | Unit: `submit_layout_approval` registration scoping, pending map `kind` discrimination, post-approval hard stop, revise re-arm (mirror `tests/unit/modes-2026-08-30.test.ts` patterns) |
| Patch | Unit: `add_subtree` with `page` target — applier writes to target page, hard error on unknown name, off-page adds don't trip viewport reveal |
| Journal | Unit: `variant_promote` row fold (restart persistence), tombstone updates, 409 under active run |
| Validator | Unit: signature scan (≥3 identical → fires; refs exempt; template-call exemption flag; depth cap) |
| Variants | Unit: parking serialization (sections named + scored, FIFO prune at 5), thumbnail budget drop behavior |
| E2E | Agent-eval: staged-flow dashboard scenario asserting lo-fi → approval → hi-fi trajectory; existing `dashboard-hifi` scenario stays green (one-shot path) |
| Manual | Browser run-through: staged ask → lo-fi → revise → approve → hi-fi; variant run → card → promote → swap back |

## 9. Research grounding (2026-09-12)

Each design pillar was validated against current AI-design products and research literature on 2026-09-12. Citations inline; findings recorded as of that date.

### 9.1 Staged lo-fi → approval → hi-fi (§3) — VALIDATED

- **Academic precedent for the exact decoupling**: *"Towards Human-AI Synergy in UI Design"* (arXiv:2412.20071, ACM) describes high-fidelity prototype generation "through a decoupled generation process" — wireframes generated from high-level descriptions first, with editable, customizable prototypes produced **at each stage**. This is §3.3–3.4 almost verbatim: a lo-fi artifact the human can inspect/edit before the hi-fi pass runs. *GUIDE: LLM-Driven GUI Generation Decomposition for Automated Prototyping* (2025) independently decomposes GUI generation into staged LLM steps for the same reason — stage separation improves controllability and output quality.
- **Product precedent for the per-turn ask**: UX Pilot makes the designer explicitly choose fidelity (wireframe vs hi-fi) and screens-per-generation before each generation — staged control as a user decision, not a forced pipeline. Our §3.2 ask ("Lo-fi layout first, or straight to hi-fi?") is the same control surface. The human-in-the-loop "propose → review → approve/edit/reject" pattern (AI UX Playground; AI/TLDR) is the recognized AI-UX gate for consequential, hard-to-undo transitions — an approved layout skeleton qualifies.
- **Honest contrast (why the ask is per-turn, not a default)**: the mainstream AI code-gen tools — v0, Lovable, bolt.new — all generate a hi-fi first draft in one shot and iterate conversationally; none gates on a lo-fi stage. Their users value speed-of-first-draft. This is precisely why the spec keeps one-shot as the default path (§6: byte-identical when detection doesn't fire or the user picks hi-fi) and makes staging a per-prompt choice (§2 non-goals: no global setting). Figma's own First Draft framing ("editable wireframes or designs in a couple of minutes") also treats lo-fi as one of two equally-first-class entry points — not a mandatory stage.

### 9.2 Explorations parking + promote (§4) — VALIDATED

- **Figma**: the Figma agent's stated workflow is to "generate new design directions… **compare multiple directions side by side**" (figma.com/ai); First Draft exists to "explore a wider range of design possibilities" (Figma help). Side-by-side comparison of alternatives is the industry-standard purpose of exploration — our current discard-the-losers behavior is the outlier. Parking runner-ups as labeled, reviewable artifacts (§4.1) restores that comparison surface in a canvas-native way (page sections + thumbnails + chat card).
- **Google Stitch**: the AI-native canvas is explicitly built to "explore ideas and iterate… regenerate screens, tweak themes, explore multiple design directions." Stitch accepts sketches/wireframes as input and treats direction exploration as a first-class activity, exported onward to Figma.
- Variant-generator's existing K=3 + VLM-judge design already matches this pattern; §4 only changes what happens to the losers (park, don't discard) and adds the swap-back affordance.

### 9.3 Component-first construction (§5) — VALIDATED

- **Figma community consensus**: the canonical workflow is build the component with auto layout **first**, then place instances into screens; styling the main component propagates to all instances (Figma Learn auto-layout guide; component-construction walkthroughs across Design Systems Collective / UX Planet / DOOR3). Designing screens directly and extracting components afterward is the anti-pattern our §5.1 rule and §5.2 validator guard against — bespoke duplicated subtrees are exactly what instances exist to prevent.
- This also matches the repo's own design-systems doctrine ("no hardcoded values — everything through tokens"; components/instances/variants shipped in the component system) — §5 closes the gap between having the component tooling and the agent actually using it.

### 9.4 Research-driven design confirmations

No structural changes resulted. Research confirmed two decisions explicitly: (1) staging must be a **user-controlled choice** (per-turn ask), because the one-shot hi-fi draft is the dominant industry pattern for speed while staged control is the designer-grade pattern for quality — the ask reconciles both; (2) alternatives must remain **visible and comparable** after generation (parked sections + card), not collapsed into a single winner.
