# dom-renderer-bench — synthetic benchmark corpus generator

Deterministic `CanvasDocument` generator for the HTML/DOM renderer
performance track (spec `docs/html-dom-renderer.md` Appendix F, Phase 0).
No browser runner is implemented yet (that is Phase 4 — see "Plan" below).

## Usage

```ts
import { generateDocument } from './generate';

// 5k nodes across 20 screens, reproducible:
const doc = generateDocument({ nodes: 5000, screens: 20, seed: 42 });
```

Run the smoke test:

```bash
bunx vitest run tests/unit/bench-generator.test.ts
```

## Document shape

- Node mix mirrors real agent output (Appendix F): **40% text, 30%
  rect/frame** (split half/half), **15% instances** (pointing at one of three
  component masters: `bench-button`, `bench-card`, `bench-input`),
  **10% images** (example.com URLs), **5% paths** (3-point polylines, ~half
  closed).
- `screens` root frames of 1440×900 laid out horizontally with a 120px gap;
  every generated node is parented to a screen frame (real nesting), with
  `clip: true` on the frames.
- Determinism: mulberry32 PRNG keyed by `seed` — the same `{nodes, screens,
  seed}` triple produces a byte-identical document (asserted by the smoke
  test). No `Math.random`, no `Date.now`.
- `zIndex` follows generation order (screen frames first, then nodes) so
  z-order is stable and parity-checkable.

## Standard corpora (Appendix F)

| Name   | Nodes | Screens | Seed |
|--------|-------|---------|------|
| small  | 50    | 1       | 1    |
| medium | 1000  | 4       | 2    |
| large  | 5000  | 20      | 3    |
| xl     | 20000 | 80      | 4    |

## Plan (Phase 4 — NOT implemented here)

The browser perf runner lands in Phase 4 of the spec:

1. Mount the app (or a bare harness) with a generated document at each corpus
   size, driving the renderer setting through the settings store.
2. Scripted gesture replay (10s continuous pan + pinch) sampling
   `requestAnimationFrame` frame times → p10/p50/p95.
3. `update`-patch dispatch → next-rAF timestamp distribution (patch-to-paint
   latency), and a recorded `bulk_add` (500 nodes) commit count via the React
   Profiler API.
4. Heap snapshots via CDP after a 5-minute soak (leak detection).
5. Gates (reference machine class): `large` pan/zoom p95 ≤ 16.7ms with ≤ 1.8k
   mounted nodes; `medium` patch-to-paint p95 ≤ 16ms; bulk 500-node build
   ≤ 3 commits / ≤ 1.5s to interactive; heap < 1.5GB at `xl`; no regression
   vs the SVG baseline at `small`.

Baseline protocol: Phase 0 records the same metrics on the SVG renderer;
every later phase's run includes the baseline columns.
