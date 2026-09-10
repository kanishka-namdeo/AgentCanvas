# pi-agent speed benchmark

- Provider: `zai`
- Thinking: `low`
- Repeats per scenario: 3
- Ran at: 2026-09-10T10:11:07.771Z

## Per-tier results

| Tier | n | TTFT p50 (ms) | TTFT p95 | T2FP p50 | T2FP p95 | T2C p50 (ms) | T2C p95 | Calls p50 | Calls p95 | Patches p50 | Complete | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| trivial | 3 | 6795 | 6795 | 8704 | 8704 | 3784 | 9899 | 4 | 4 | 1 | 100% | 0% |
| multi | 3 | 23927 | 23927 | 23927 | 23927 | 55814 | 184073 | 10 | 34 | 5 | 100% | 0% |
| complex | 6 | 38008 | 38008 | 38009 | 38009 | 92629 | 360033 | 0 | 28 | 0 | 67% | 0% |

## Per-run details

| Scenario | Tier | Repeat | TTFT (ms) | T2FP (ms) | T2C (ms) | Calls | Patches | Status | Model |
|---|---|---|---|---|---|---|---|---|---|
| trivial-shape | trivial | 0 | 6795 | 8704 | 9899 | 4 | 1 | complete | - |
| trivial-shape | trivial | 1 | 903 | 2462 | 3784 | 4 | 1 | complete | - |
| trivial-shape | trivial | 2 | - | - | 1419 | 0 | 0 | complete | - |
| multi-dashboard | multi | 0 | 23927 | 23927 | 184073 | 34 | 14 | complete | - |
| multi-dashboard | multi | 1 | 18029 | 18029 | 55814 | 10 | 5 | complete | - |
| multi-dashboard | multi | 2 | - | - | 11130 | 0 | 0 | complete | - |
| complex-landing | complex | 0 | 37275 | 37275 | 360033 | 28 | 1 | timeout | - |
| complex-landing | complex | 1 | 38008 | 38009 | 360004 | 26 | 1 | timeout | - |
| complex-landing | complex | 2 | - | - | 92629 | 0 | 0 | complete | - |
| complex-ecommerce | complex | 0 | - | - | 90123 | 0 | 0 | complete | - |
| complex-ecommerce | complex | 1 | - | - | 83859 | 0 | 0 | complete | - |
| complex-ecommerce | complex | 2 | - | - | 74280 | 0 | 0 | complete | - |