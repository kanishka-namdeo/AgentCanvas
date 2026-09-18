# Agent Eval Report

- Date: 2026-09-18T16:12:23.872Z
- Scenarios: 1 (0 pass / 1 fail / 0 error)
- Assertions: 3/12 passed

## ❌ login-hifi — FAIL

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

1 tool calls · 301s · 0 layers · top tools: ask_user_questionx1

- ❌ **canvas has layers** — only 0 layers — too few for a login screen
- ❌ **uses a container/frame** — no frame/group — flat layer soup
- ❌ **email + password copy present** — email=false password=false
- ❌ **brand "Vaultly" present** — no "Vaultly" text anywhere
- ❌ **colorful design (hi-fi)** — fewer than 3 saturated-color layers — looks grayscale
- ❌ **shadows on elevated surfaces** — no shadow anywhere — flat/wireframe look
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ❌ **Sign In action present** — no "Sign In" text
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 1 tool calls (expected 4..90)
- ❌ **no agent errors** — errors: Agent stream stalled — no output for 240s. The run was closed to avoid hanging; resend the prompt to retry.

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| login-hifi | 0% (0/1) | 1.0/1/1 | 301/301/301 | 3/12 | canvas has layers 0%; uses a container/frame 0%; email + password copy present 0%; brand "Vaultly" present 0% |
