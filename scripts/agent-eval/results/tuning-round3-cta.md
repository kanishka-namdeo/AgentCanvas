# Agent Eval Report

- Date: 2026-08-31T03:22:02.643Z
- Scenarios: 3 (3 pass / 0 fail / 0 error)
- Repeats per scenario: 3 (results below are per-run; see the Variance table)
- Assertions: 36/36 passed

## ✅ login-hifi (run 1/3) — PASS

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

1 tool calls · 91s · 34 layers · top tools: pen_generate_variantsx1

- ✅ **canvas has layers** — 34 layers
- ✅ **uses a container/frame** — 15 container(s)
- ✅ **email + password copy present** — email=true password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls (macro-tool exception applied: pen_generate_variants)
- ✅ **no agent errors** — clean turn

## ✅ login-hifi (run 2/3) — PASS

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

7 tool calls · 124s · 30 layers · top tools: pen_create_subtreex2, pen_search_iconsx1, pen_set_variablesx1, pen_apply_palettex1, pen_set_gradient_fillx1, pen_get_metadatax1

- ✅ **canvas has layers** — 30 layers
- ✅ **uses a container/frame** — 5 container(s)
- ✅ **email + password copy present** — email=true password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 7 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 7 tool calls
- ✅ **no agent errors** — clean turn

## ✅ login-hifi (run 3/3) — PASS

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

9 tool calls · 90s · 32 layers · top tools: pen_set_gradient_fillx2, pen_set_variablex2, pen_generate_design_briefx1, pen_set_variablesx1, pen_create_subtreex1, pen_apply_palettex1

- ✅ **canvas has layers** — 32 layers
- ✅ **uses a container/frame** — 13 container(s)
- ✅ **email + password copy present** — email=true password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 9 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 9 tool calls
- ✅ **no agent errors** — clean turn

## Variance (3 runs per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| login-hifi | 100% (3/3) | 5.7/1/9 | 102/90/124 | 36/36 | — |
