# AgentCanvas Prompt-Tuning Exercise — Final Report
Date: 2026-08-31 | Prompt: v2026-08-30.1 → v2026-08-31.3 | Repo: kanishka-namdeo/AgentCanvas

## 1. Executive summary
A research-grounded prompt-tuning exercise was run end-to-end: web research → baseline single-shot evals (A/B, repeats) → multi-shot evals → visual/computed audits → 3 rounds of prompt changes → 6 app/harness bug fixes → full validation. Final state: the 8-scenario dev suite passes 8/8 scenarios; the multi-shot suite passes 3/3 scenarios (22/22 assertions, 9/9 turns, 0 failed tool calls, 0 regressions); valid-run assertion rate rose from 92.2% (baseline, clean app) to 100% on the final prompt+model combination; and five genuine product bugs were found and fixed along the way.

## 2. Methodology
- Grounded research first (Anthropic tool-writing guidance; arXiv 2505.13360 underspecification; "Curse of Instructions"; v0's leaked design constraints) → 6 testable hypotheses.
- A/B evals with repeats (n=2) on a 5-scenario core subset; 429-confounded runs (tools==0) excluded from conclusions; held-out scenarios reserved.
- Multi-shot evals: NEW harness (scripts/agent-eval/run-multishot.ts) — 3 scenarios × 3 turns measuring iterative refinement, edit precision, and no-regression.
- Providers: glm-5.3 (zai sandbox) for the A/B arms; kimi-k2-5 (custom endpoint, the app's production default) for final validation.
- Visual: rendered PNGs of final canvases + a computed visual audit (shadow coverage, saturation, hue clusters, type-scale, 4px grid) + a deferred VLM critique, completed 2026-08-31 on the kimi-k2-5 endpoint (z.ai vision stayed 429 quota-blocked).

## 3. Results
| Eval round | Provider | Valid runs | Valid-run assertions | Notes |
|---|---|---|---|---|
| baseline2 (critique-leak present) | glm-5.3 | 10/16 | 78/88 (88.6%) | confounded |
| baseline3 (app fixed, baseline prompt) | glm-5.3 | 6/10 | 47/51 (92.2%) | clean |
| round1b (app fixed, round-1 prompt) | glm-5.3 | 5/10 | 47/49 (95.9%) | +3.7pts |
| round2-kimi (round-2 prompt) | kimi-k2-5 | 10/10 | 88/90 (97.8%) | 0 empty runs |
| round3-cta (login only) | kimi-k2-5 | 3/3 | 36/36 (100%) | CTA fix validated |
| final-sweep (3 other scenarios) | kimi-k2-5 | 6/6 | 44/46* | *palette tool bug, fixed after |
| palette-fix revalidation | kimi-k2-5 | 2/2 | 14/14 (100%) | 8/8 dev suite |
| multishot-tuned (round-2 prompt) | kimi-k2-5 | 9/9 turns | 22/22 (100%) | 0 regressions |

## 4. Prompt changes (v2026-08-31.1 → .3)
- Round 1 (content & scope): SCOPE & CONTENT CONTRACT section (effort matching: single-element requests skip ceremony; content fidelity as #1 responsibility with a last-step re-check); COLOR VISIBILITY rule (grayscale = failed hi-fi; saturated hex for named colors); palette freedom wording; VERIFY-step content recheck.
- Round 2 (tool disambiguation, 8 descriptions): pen_set_variable vs pen_set_variables; pen_apply_variable vs pen_bind_variable; pen_set_background; pen_delete_nodes/pen_clear destructive warnings; pen_create_component cross-refs. (Anthropic: description refinement is the highest-leverage tool fix.)
- Round 3 (CTA labels): "Every button and CTA must carry its action text as a real text layer" — fixed the one remaining content-fidelity gap (missing "Sign In").

## 5. App bugs found & fixed (in-scope "fix whatever breaks")
1. /api/agent dropped maxDesignCritiqueIterations from its settings allowlist → critique loop ran despite settings=0 (burned LLM quota, failed no-agent-errors evals). Fixed: validated pass-through.
2. 429 resilience: runner had no same-provider backoff. Fixed: 20s/45s backoff ladder with watchdog-feeding heartbeats before provider fallback.
3. pen_bulk_update_by_filter rejected JSON-string shape inputs (the documented GLM stringify gotcha) and its validation errors were truncated to uselessness by the harness (slice(0,60)). Fixed: loose shape input + actionable empty-changes errors + 200-char failure details.
4. pen_generate_palette ramp lightness [..,90] made the lightest swatch near-white by construction (HSV S ≤ 0.20). Fixed: cap at 85.
5. Eval startup gate probed the sandbox endpoint instead of the configured provider (12-min stall per run). Fixed: skip when EVAL_PROVIDER is set.
Also: tool-count floor heuristic punished legitimate macro-tool one-shots (pen_generate_variants building a 60-layer dashboard in 1 call) — floor now 1 when macro tools are used.

## 6. Visual audit (computed, no LLM)
Rendered PNGs: ms-pricing-iterate.png, ms-login-refine.png, ms-dashboard-edit.png. Metrics: 3 hue clusters each (cohesive); type-scale adherence 50-92%; shadow coverage 2-13% (weakest metric — future prompt target); 4px-grid adherence ~55% (dragged by standard 375px mobile frames).

## 7. VLM critique — completed 2026-08-31 (kimi-k2-5 as VLM)
Task 12-a re-run: the z.ai sandbox vision endpoint was re-probed and remained HTTP-429 (hard throttle, 0.0s), so per operator directive the critique ran on the **kimi-k2-5 custom endpoint as the VLM** — vision capability verified first with a tiny-image probe (`scripts/vlm-inspect/probe-vlm-quota.ts`: correct dominant-color identification). 3 images × 2 repeats = **6/6 runs scored** (`scripts/agent-eval/vlm-critique-pt.ts`, rubric exactly as planned; per-run JSONs + `vlm-summary.{md,json}` in this directory).

| image | overall (r1/r2) | key findings (cross-checked where noted) |
|---|---|---|
| ms-pricing-iterate | 5 / 6 | billing toggle rendered **bottom-left & clipped** (pixel-verified: green block at x 2%, y 98%; doc shows it appended as the LAST flow child with a y=-320 absolute-position hack that autoLayout reflow defeated — the prompt said "top of the page"); root page frame carries a **FIXED h=100 dark fill while 6 children flow ~1400px** (the "dark bar through the cards") |
| ms-login-refine | 6 / 6 | "Forgot password?" drifted below the social buttons (VLM-reported); generic glyphs instead of Google/Apple brand marks (VLM-reported); scattered vertical spacing (VLM-reported) |
| ms-dashboard-edit | 7 / 7 | title "Growth Metrics" **clipped by FIXED w=120 at 38px** (doc-verified — the eval was right that the rename happened, the VLM was right that it renders truncated); requested "subtle shadow" on KPI cards reads as invisible (blur=2, computed-audit-confirmed — both VLM runs independently flagged it); KPI labels embellished ("TOTAL REVENUE" vs asked "Revenue") plus unrequested trend indicators and subtitle (content-verified) |

**Mean 6.17/10** · dimension means: typography 7.00, prompt_fidelity 6.83, layout_structure 6.33, color_cohesion 6.33, component_polish 6.00, overall_polish 6.17 · severity h/m/l 9/21/16 · repeat variance low (±0-1, vs ±1.5 in the earlier VLM exercise).

Reading: the assertion suite (22/22) and the VLM disagree **by design** — assertions verify presence, the VLM verifies placement and visual quality. Cross-checking the VLM's claims against the documents and pixels: five findings are real agent-output defects, one (near-invisible pricing headline) is contradicted by pixel sampling (ink clearly present in the hero rows). The verified gaps convert directly into prompt/resolver targets (§8).

## 8. Remaining recommendations
- Shadow coverage is the weakest computed metric (2-13%, and the VLM reads blur=2 shadows as absent) — the TURN FLOW's ELEVATE step could get a numeric floor ("shadows on ≥50% of card-class surfaces", blur ≥ 8).
- **POSITIONAL FIDELITY prompt rule + position-aware assertions** — "at the top of the page" / "below X" are layout constraints, not suggestions; the pricing toggle passed a presence check while sitting clipped in the bottom-left corner.
- **Auto-grow (or resolver warning) for FIXED-width text nodes whose content no longer fits** — this clipped the renamed "Growth Metrics" title at w=120/38px.
- **Page/root frames should size fit_content** — the h=100 FIXED root painted a dark bar across the pricing flow.
- **No-unrequested-content rule** — invented trend indicators/subtitles dilute prompt fidelity (dashboard KPI cards).
- zai/glm re-validation of round-2 prompt (this report's kimi numbers are the production default; glm A/B ended at round-1).
- Monochromatic palette ramp still tops at L=90 (untested by scenarios).
- Consider consolidating the 3 remaining instance-placer tools (pen_instantiate_component is deprecated but still reachable via 'multi').

## 9. Artifacts
- All eval reports: scripts/agent-eval/results/tuning-*.{json,md}, multishot-*, ms-*
- Logs: download/prompt-tuning/eval-*.log
- Research: download/prompt-tuning/research-summary.md, tool-descriptions.md
- Visual: download/prompt-tuning/*.png, visual-audit.md
- VLM critique: download/prompt-tuning/vlm-summary.{md,json} + vlm-critique-*-r*.json; harness scripts/agent-eval/vlm-critique-pt.ts (--provider=auto re-uses z.ai vision once its quota clears); endpoint probe scripts/vlm-inspect/probe-vlm-quota.ts
- Worklog: /home/z/my-project/worklog.md (session-local)
