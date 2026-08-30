# AgentCanvas Agent — Visual Stress Test Results
Date: 2026-08-30 · Gateway :81 (live sync) · viewport 1920×1080 · model kimi-k2-5

## Protocol
- Canvas cleared via `/clear` chat command before every scenario (multi-turn sequences keep canvas across their turns)
- Prompt sent through the real UI textarea; wait for agent idle (no spinners, 15s settle)
- Metrics: duration, layer count ([data-node-id] in DOM), console errors, full screenshot
- Evaluation criteria from Design Theater benchmark + v0/Figma best practices research:
  structure completeness · color discipline (≤5) · typography hierarchy (≤2 families) ·
  content realism (no lorem) · rendering integrity (no overlap/overflow) · instruction adherence ·
  ambiguity handling · cross-turn memory · robustness

---

## S1 — Single-turn: "Create a landing page for a sleep-tracking mobile app called Lumen" (v0-classic)
- Duration: ~6.5 min (04:34:57 → 04:41:20) · 36 tool calls · 0 tool failures · 75 layers · 2 critique iterations
- Agent's own VLM critic: **1/10** (real client screenshots ✓) · Independent VLM eval: **2/10**
- Final visual state: dark nav + hero rectangle + purple arc VISIBLE; **19 of 27 text nodes invisible**

### Findings
- **F1 (BUG, generator): zero-width frames from variant generator.** Model contains `FeatureContent1` frame with `width=0` (should hug ~200px). All 8 texts inside (feature titles/descriptions) exist in DOM with sizes but paint nothing. Root: variant generator's intrinsic-width resolution writes 0 for nested vertical stacks.
- **F2 (BUG, fix-turns): contrast inversion via bulk recolor.** Critique said "light text on light cards"; fix-turns ran `pen_bulk_update_by_filter` ×7 + `pen_update_node` ×25 recoloring text to `#0f172a`/`#475569` — INCLUDING stats sitting on the dark hero (`rgb(30,41,59)`) → dark-on-dark invisible. Bulk-by-filter has no per-node background awareness.
- **F3: VLM critic correctly diagnoses (1/10) but fix loop can't repair structural defects** — it only recolors; `w=0` frames stay broken. Critique→fix loop converges on color churn, not fixes.
- **F4 (BUG, UI): stale sub-agent spinners.** Text `design_critic` rows spin forever after turn end (no `subagent_result` event for text critics; only VLM critic rows resolve). "Sub-agents" header spinner persists ~15 min after completion.
- **F5 (UX): final message is a concatenation of fix-turn fragments**, ends mid-sentence ("Let me update the benefit items and stats to ensure proper contrast:") — no wrap-up summary of what was built.
- **F6 (perf): 6.5 min for one landing page** (2 critique iterations + fix turns). v0/Figma target <60s.
- **F7 (render): text width overflow** — FeaturesTitle text 225px wide inside 204px frame (resolver 0.62×fontSize estimate ignores wrapping).
- ✓ Works: brief-first, variant exploration, real client screenshots to VLM critic, `/clear`, no tool errors, no console errors.

---
## S2 — Single-turn: "Design an analytics dashboard for a SaaS product with KPI cards, a revenue chart, and a recent activity table"
- Duration: **13.5 min** (incl. recovery) · 119 layers · VLM eval 5/10 · agent VLM critic 1/10 ×2
- KPI cards + sidebar + table (Sarah Chen/Upgraded to Pro/+$89.00 — realistic data) GOOD; **revenue chart = empty box** (phantom)

### Findings
- **F8 (BUG, critical — FIXED live): `pen_create_chart` silently lost ALL its work.** Tool reported success ("18 child nodes created") but returned `details` WITHOUT `patch` — the session translator (the only fan-out path to clients+journal) got nothing. The reparent then "succeeded" against a phantom, placeholder deleted → empty chart section. Same bug in `pen_apply_design_system` (3 patches lost) + `pen_apply_typography`. **Fix**: all 3 now return patch/patches in details; chart children moved from `patch.nodes` (ignored by applier) into `shape.children`; root autoLayout removed (chart geometry is absolute).
- **F9 (BUG — FIXED): variant generation failed to parse** on the data-heavy prompt (3 min wasted), fallback stream errored, retry recovered. Tool returned success:true with "Variant generation failed" summary — misleading.
- **F13 (BUG — FIXED): critique fix-message's autoLayout recipe broke working charts.** Validator Rule 4 flagged "no autoLayout" on a lone chart; fix-turn dutifully added autoLayout:vertical to the chart frame → resolver restacked absolutely-positioned bars into a column. **Fix**: Rule 4 exempts chart/diagram/graph frames; fix-message now says NEVER add autoLayout to absolutely-positioned geometry.
- **F14 (BUG, critical render — FIXED): L4 culling made overflowing content invisible.** cv:auto's layout+style+**paint** containment is intrinsic (cannot be opted out via `contain` — browsers report it as `contain: content`). A variant-generated card (164px fixed height, 459px of children) clipped ALL its children → zero data pixels painted while DOM boxes existed. Verified live: 0 indigo pixels before fix → 7,986 after. **Fix**: overflowing non-clip frames skip cv:auto entirely (C10a reverted).
- **F15: nondeterministic routing**: same chart prompt classified as manual-create path (15 nodes, 2.5 min) then variant-generator path (42 nodes, 4.2 min). Different architecture/quality per run.
- **F16: text critic score DEGRADED across fix iterations** (5/10 → 3/10) — fix-turns made it worse; loop has no revert/checkpoint-rollback.
- ✓ Verified working after fixes: chart prompt → full bar chart card renders (VLM 7/10), text critic spinner resolves (S4 fix), 252s total.

---
## S5 — Vague: "make something cool" · **7/10** · 33 layers · 4 min
- Generic SaaS landing (hero/features/CTA), all content paints, good hierarchy.
- **F17**: no clarification on vague prompts (goal_interview never triggers); brief auto-picks a direction silently. Acceptable (v0-style) but suboptimal vs Figma's checkpoint-prompt pattern.

## S6 — Conflicting: minimalist+2 colors vs gradients+dense decoration · **6/10** · 66 layers · 5 min
- Silently resolved to the minimalist side (9 fills, slate+indigo) — coherent but ignored half the brief.
- **F18**: no acknowledgment of the contradiction, no question, no stated resolution. Best practice: ask or explicitly state the trade-off decision.

## S7 — Off-topic: "What is the capital of France?" · **PASS** · 24s · 0 layers
- Perfect: direct text answer, no tools, no canvas mutation, no critique loop.

## M1 — Multi-turn pricing page (4 turns + 1 fix-retry)
| Turn | Prompt | Result | Time | Score |
|------|--------|--------|------|-------|
| T1 | "Design a pricing page…3 tiers" | 91 layers, 3 cards + stats + CTA | 6.2 min | — |
| T2 | "Highlight the middle tier as most popular" | PopularBadge + "Most popular" text added precisely | 91s | — |
| T3 | "Switch to dark mode with purple accents" | **BROKEN: 33 dark-on-dark texts** | 40s | 2/10 |
| T3b | retry after fix | all 33 texts → #f8fafc | 111s | **9/10** |
| T4 | "Add an FAQ section below the pricing cards" | 15 FAQ nodes, 4 realistic Q&As, matching dark theme | 3.5 min | **9/10** |

- ✓ Cross-turn conversation memory works (T2–T4 correctly reference prior screens)
- ✓ Edit turns are 4-7× faster than creation turns (91s vs 373s)
- ✓ Precise additive edits (badge, FAQ placement)
- **F19 (BUG — FIXED live): `pen_apply_palette` set every textColor to the DARKEST palette swatch** — exactly wrong for dark-mode palettes (33 invisible labels). Fix: text swatch chosen by max lightness-contrast against the dominant post-mapping fill. Verified live: 2/10 → 9/10.

---
## Summary

### Scores (independent VLM evaluation of real screenshots)
| Scenario | Score | Notes |
|----------|-------|-------|
| S1 landing page | 2/10 | zero-width frames + contrast-inverting fix-turns |
| S2 dashboard | 5/10 | phantom chart (patch propagation bug) |
| S2c chart (after fixes) | **7/10** | full bar chart renders |
| S5 vague | 7/10 | clean generic landing |
| S6 conflicting | 6/10 | silent one-sided resolution |
| S7 off-topic | PASS | perfect routing |
| M1-T3 dark mode | 2/10 → **9/10** | palette tool contrast bug fixed |
| M1-T4 FAQ | **9/10** | precise additive edit |

### Bugs found & fixed this session (6 code fixes + 15 regression tests, all verified live)
1. **F8** composite tools lost all patches (pen_create_chart/design_system/typography) — details.patch added
2. **F1** zero-width frames from LLM subtrees — normalizeSubtree converts to fit_content
3. **F13** validator pushed autoLayout onto charts — chart exemption + fix-message warning
4. **F14** L4 culling made overflowing content invisible (cv:auto intrinsic paint containment) — overflow frames skip culling
5. **F19** palette tool dark-on-dark text — max-contrast text swatch
6. **F4** stale text-critic spinners — subagent_result emitted (verified live)

### Remaining findings (documented, not fixed — design-level)
- F3/F16: critique loop churns cosmetic fixes while scores degrade; no revert/checkpoint between iterations
- F5: final message = concatenated fix-turn fragments, cut mid-sentence
- F6: 2.5–13.5 min per design turn (variant parse failures add 3+ min)
- F7: resolver text-width estimate ignores wrapping (225px text in 204px frame)
- F9: variant-generation parse failures report success:true
- F15: nondeterministic routing (same prompt → manual vs variant path)
- F17/F18: no clarification on vague/conflicting prompts
