# One-Shot Design Generation Optimization -- Research Findings & Implementation

## Goal
One-shot (empty-canvas) design generation at industry-par visual quality (v0.dev / Lovable / bolt.new / Google Stitch class) with reasonable latency, running inference on the BETA endpoint (qwen3.7-plus behind a pinggy tunnel). Multi-shot (follow-up turn) logic was frozen and remains untouched.

## Industry research summary (2026-09, live web research)
- v0.dev: design brief FIRST (GenerateDesignInspiration tool, parallel with analysis); design-token-only colors; anti-blandness meta-rule "interesting rather than boring, but never ugly".
- Google Stitch: two-tier model routing (Flash fast tier / Pro quality tier).
- Deterministic post-passes beat extra LLM refinement rounds: grid snapping, contrast recoloring, duplicate-node dedupe cost zero latency.
- Constrained/structured output: schema complexity is a real latency cost (outlines 5-60% overhead; xgrammar near-zero with flat schemas). Flat node lists + enums > deep recursive JSON.
- Qwen3 serving guidance: non-thinking mode temp 0.6-0.7 (never greedy), top_p 0.8; thinking tokens are pure latency for one-shot generation; strong few-shot adherence; Hermes-style tool calling works.
- Latency levers ranked: (1) output-token reduction, (2) streaming + progressive render, (3) prefix caching, (4) model routing, (5) schema flatness.
- Encodable design rules: 3-5 colors, 60-30-10 distribution, 50-950 ramps with WCAG AA text from 600+, 2 font families, 1.25 type ratio, 8pt grid, negative heading tracking, 6-10px radius, one primary CTA per view.

## What was implemented (all gated to one-shot/empty-canvas turns unless noted)
1. Inference: DEFAULT_SETTINGS + BETA preset -> custom/qwen3.7-plus; z.ai sandbox auto-fallback on tunnel failure (inference transport, affects all turns equally).
2. Qwen transport: samplingParams top_p 0.8 + enable_thinking:false + chat_template_kwargs.enable_thinking:false (DashScope + vLLM coverage) on the main loop model; same thinking-off for qwen sub-agents in openai-compatible.ts.
3. One-shot tool slimming: 11 default plugin tools (ask_user_question, todo_*, memory_*) dropped only when mode=build AND empty canvas -- saves ~11 tool schemas of prefix tokens and removes the ask-question latency trap.
4. Deterministic patch polish (src/lib/canvas/oneshot-polish.ts): 4px grid snap + identical-duplicate dedupe, wired into /api/agent only for empty-canvas turns.
5. ONE-SHOT QUALITY BAR prompt block (inside TURN FLOW, first-creation-only): anti-blandness, single primary CTA, real terse copy, compact tool output (2-4 large subtree calls), no questions this turn, CARD ROWS ARE STRUCTURE (4 KPI cards = 4 equal frame containers, never merged text), VERIFY DISCIPLINE (one pen_get_metadata, batched fixes).
6. Brief pre-generation timeout 40s -> 25s (one-shot-only branch).
7. scripts/verify-default-llm.ts updated for the BETA default (soft-pass on tunnel fallback).

## Measured results (qwen3.7-plus via BETA tunnel, dev server :3000)
- E2E smoke (verify-beta-endpoint.ts): FULL PASS, no fallback, 0 errors, ~2min10s one-shot badge turn.
- Eval round 1 (login/dashboard/wireframe): 2/3 pass; dashboard-hifi failed card-row structure (content present, no 4 card frames).
- After CARD ROWS + VERIFY DISCIPLINE rules, round 2 (2 repeats): 4/4 runs, 42/42 assertions. dashboard-hifi FAIL -> 100% (4 same-height 144px card frames). login-hifi 347.6s -> 172.9s mean (-50%), tools 30 -> 13.5 mean (-55%), pen_get_metadata 8 -> 2, pen_update_node 14 -> 5. wireframe-lofi 59s (template path).
- Visual UI test (agent-browser): 2/2 clean, no console errors, screenshots in download/agent-eval/.

## Multi-shot safety
All behavioral changes are gated on empty-canvas first turns (turnStartShapeIds.size === 0 and/or mode=build). EDIT TURNS, conversation history, delta snapshots, prior-content guard, turn-diff, journal fold/catchup, and prompt queueing are untouched. The only shared changes are inference transport config (endpoint/model/sampling) and the verify-default-llm script.

## VLM visual-quality scores (single-run renders, glm-5v-turbo judge)
- login-hifi: overall 8/10 (fidelity 9, layout 8, typography 7, color 9, component 7, polish 8). Genuine defects: generic password-eye icon, unrequested social-login buttons, visible placeholder text.
- dashboard-hifi: overall 7/10 (fidelity 9, layout 7, typography 6, color 8, component 7, polish 6). Genuine run-1 defects: overlapping translucent header rects, cut-off user name, flat KPI hierarchy.
- Scoring method: single-run canvas recovery (journal fold through first turn_final), server-side render via render-ms-canvas.ts, judged by scripts/agent-eval/vlm-score-oneshot.ts.
- Eval-harness note: run-eval repeats reuse the same documentId, so journal folds merge N runs into one doc (stacked variants) - per-run canvases must be folded to the first turn boundary for single-design renders. App behavior is unaffected (each run posts a fresh canvasState).
- Render-fidelity note: renderCanvasToPng resolves fill_container children to full parent width, while the browser DOM uses real flex (flex: 1 1 0) - browser screenshots remain ground truth for auto-layout.