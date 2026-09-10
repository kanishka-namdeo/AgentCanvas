# pi-agent speed benchmark

- Provider: `zai`
- Thinking: `low`
- Repeats per scenario: 1
- Ran at: 2026-09-10T08:02:43.160Z

## Per-tier results

| Tier | n | TTFT p50 (ms) | TTFT p95 | T2FP p50 | T2FP p95 | T2C p50 (ms) | T2C p95 | Calls p50 | Calls p95 | Patches p50 | Complete | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| trivial | 2 | 10617 | 10617 | 10617 | 10617 | 12084 | 12084 | 4 | 4 | 1 | 100% | 0% |
| simple | 3 | 29498 | 30317 | 29498 | 30317 | 65591 | 75398 | 4 | 4 | 1 | 100% | 0% |
| multi | 3 | 25076 | 33478 | 25076 | 33479 | 113653 | 126828 | 4 | 4 | 2 | 100% | 0% |
| complex | 2 | 54060 | 54060 | 54060 | 54060 | 180017 | 180017 | 2 | 2 | 1 | 100% | 0% |
| flow | 1 | 24174 | 24174 | 24174 | 24174 | 88107 | 88107 | 4 | 4 | 1 | 100% | 0% |

## Per-run details

| Scenario | Tier | Repeat | TTFT (ms) | T2FP (ms) | T2C (ms) | Calls | Patches | Status | Model |
|---|---|---|---|---|---|---|---|---|---|
| trivial-shape | trivial | 0 | 10617 | 10617 | 12084 | 2 | 1 | complete | - |
| trivial-heading | trivial | 0 | 4754 | 8445 | 10016 | 4 | 1 | complete | - |
| simple-login | simple | 0 | 21452 | 21453 | 65591 | 4 | 1 | complete | - |
| simple-pricing | simple | 0 | 29498 | 29498 | 75398 | 4 | 2 | complete | - |
| simple-settings | simple | 0 | 30317 | 30317 | 54211 | 4 | 1 | complete | - |
| multi-dashboard | multi | 0 | 33478 | 33479 | 113653 | 4 | 4 | complete | - |
| multi-kanban | multi | 0 | 15057 | 15057 | 87731 | 4 | 2 | complete | - |
| multi-chart | multi | 0 | 25076 | 25076 | 126828 | 4 | 2 | complete | - |
| complex-landing | complex | 0 | 39512 | 39512 | 165017 | 2 | 1 | complete | - |
| complex-ecommerce | complex | 0 | 54060 | 54060 | 180017 | 2 | 1 | complete | - |
| flow-onboarding | flow | 0 | 24174 | 24174 | 88107 | 4 | 1 | complete | - |