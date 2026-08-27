#!/usr/bin/env bun
// run.ts — Playwright-based bench runner for the HTML/DOM renderer
// (spec docs/html-dom-renderer.md Phase 4 + Appendix F).
//
// Usage:
//   bun run scripts/dom-renderer-bench/run.ts                 # advisory run
//   bun run scripts/dom-renderer-bench/run.ts --ci            # enforce gates (exit 1 on failure)
//   bun run scripts/dom-renderer-bench/run.ts --corpus=large # single corpus
//   bun run scripts/dom-renderer-bench/run.ts --no-headless  # for local debugging
//
// The runner assumes a dev or standalone server is already running on
// http://localhost:3000 (override with BENCH_URL). It drives the canvas store
// via the window-level test hooks (__agentcanvas_test_*) when present (dev
// mode), falling back to __canvasStore (always exposed — store.ts:1920).
//
// Resilience:
//   - playwright-core not installed → friendly install hint, exit 0
//     (so missing browser deps never fail CI — only real gate violations do).
//   - Chromium binary not installed → same.
//   - Dev server unreachable → exit 1 only in --ci mode; exit 0 advisory.
//
// The pure helpers (computeStats, gateEnforced) live in stats.ts so the test
// suite can import them without loading Playwright.

import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateDocument } from './generate';
import {
  computeStats,
  gateEnforced,
  DEFAULT_GATES,
  type CorpusMetrics,
  type Stats,
} from './stats';

const __dirname = dirname(new URL(import.meta.url).pathname);
const RESULTS_PATH = join(__dirname, 'results.json');
const DEFAULT_URL = process.env.BENCH_URL || 'http://localhost:3000';

// ---- Args -----------------------------------------------------------------

interface Args {
  ci: boolean;
  corpus: 'small' | 'medium' | 'large' | 'all';
  headless: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ci: false, corpus: 'all', headless: true };
  for (const a of argv) {
    if (a === '--ci') args.ci = true;
    else if (a === '--no-headless') args.headless = false;
    else if (a.startsWith('--corpus=')) {
      const v = a.slice('--corpus='.length);
      if (['small', 'medium', 'large', 'all'].includes(v)) {
        args.corpus = v as Args['corpus'];
      } else {
        throw new Error(`Invalid --corpus value: ${v} (expected small|medium|large|all)`);
      }
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: bun run scripts/dom-renderer-bench/run.ts [--ci] [--corpus=small|medium|large|all] [--no-headless]`);
      process.exit(0);
    }
  }
  return args;
}

// ---- Corpora (Appendix F, with the task spec's 200-node tier added) --------

interface CorpusDef {
  name: string;
  nodes: number;
  screens: number;
  seed: number;
}

const CORPORA: CorpusDef[] = [
  { name: 'small',  nodes: 50,   screens: 1,  seed: 1 },
  { name: 'medium', nodes: 200,  screens: 2,  seed: 2 },
  { name: 'large',  nodes: 1000, screens: 4,  seed: 3 },
  { name: 'xl',     nodes: 5000, screens: 20, seed: 4 },
];

function selectCorpora(filter: Args['corpus']): CorpusDef[] {
  if (filter === 'all') return CORPORA;
  const found = CORPORA.filter((c) => c.name === filter);
  if (found.length === 0) throw new Error(`Unknown corpus: ${filter}`);
  return found;
}

// ---- Playwright (lazy/dynamic import — don't fail CI if not installed) ----

/// Launch Chromium. Returns null + prints a friendly install hint when:
///   - playwright-core isn't installed (dynamic import throws).
///   - the Chromium binary isn't installed (launch throws).
/// Never throws — the caller treats null as "skip bench, exit 0".
async function loadChromium(headless: boolean): Promise<any | null> {
  let chromium: any;
  try {
    const pw = await import('playwright-core');
    chromium = pw.chromium;
  } catch {
    console.error('\n⚠️  playwright-core not installed.');
    console.error('   Install browsers via: bunx playwright install chromium');
    return null;
  }
  // Prefer an explicit system-Chromium path; fall back to Playwright's bundled
  // Chromium (which `bunx playwright install chromium` installs).
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  try {
    return await chromium.launch({
      headless,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error('\n⚠️  Failed to launch Chromium.');
    if (msg.includes('executable') || msg.includes('playwright install') || msg.includes('does not exist')) {
      console.error('   Chromium binary not found. Install via: bunx playwright install chromium');
      console.error('   (or set CHROMIUM_PATH to point at a system Chromium binary)');
    } else {
      console.error('   Error:', msg);
    }
    return null;
  }
}

// ---- In-page measurements -------------------------------------------------

/// Inject a synthetic CanvasDocument into the running app. Uses the dev-only
/// test hook when present (src/app/page.tsx), falling back to driving
/// __canvasStore directly (always exposed in store.ts:1920) — production CI
/// builds don't ship the test hooks but still expose the store.
async function injectDocument(page: any, doc: any): Promise<boolean> {
  return await page.evaluate((d) => {
    const w = window as any;
    if (typeof w.__agentcanvas_test_inject_document === 'function') {
      w.__agentcanvas_test_inject_document(d);
      return true;
    }
    if (w.__canvasStore) {
      const store = w.__canvasStore;
      const cur = store.getState().document;
      // Swap in the new doc, preserving viewport so the user's pan doesn't
      // jump — but the bench drives its own viewport below anyway.
      store.setState({
        document: {
          ...cur,
          ...d,
          viewport: d.viewport ?? cur.viewport,
        },
      });
      return true;
    }
    return false;
  }, doc);
}

/// Pan/zoom frame-time samples — drive viewport changes via the store and
/// collect `performance.now()` deltas between successive `requestAnimationFrame`
/// callbacks. Each setState triggers a React re-render → DOM mutation → paint;
/// if the renderer keeps up at 60fps, deltas hover ~16.67ms. Dropped frames
/// show as ~33ms or longer.
async function measurePanZoom(page: any, samples: number): Promise<number[]> {
  return await page.evaluate(async (n: number) => {
    const w = window as any;
    const store = w.__canvasStore;
    if (!store) return [];
    const world = document.querySelector('[data-ac-world]');
    if (!world) return [];

    // Pre-warm: one viewport change so the first rAF sample isn't biased by
    // initial-render bookkeeping.
    const vp0 = store.getState().document.viewport ?? { zoom: 1, panX: 0, panY: 0 };
    store.setState({
      document: { ...store.getState().document, viewport: { ...vp0, panX: vp0.panX + 1 } },
    });

    const times: number[] = [];
    let last = performance.now();
    let count = 0;
    await new Promise<void>((resolve) => {
      const loop = () => {
        const now = performance.now();
        const dt = now - last;
        if (count > 0 && dt > 0) times.push(dt);
        last = now;
        count++;
        if (count > n) {
          resolve();
          return;
        }
        // Drive a viewport change — the DOM renderer's pan path.
        const doc = store.getState().document;
        const vp = doc.viewport ?? { zoom: 1, panX: 0, panY: 0 };
        store.setState({
          document: { ...doc, viewport: { ...vp, panX: vp.panX + 3 } },
        });
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    return times;
  }, samples);
}

/// Patch-to-paint latency — for N `update` patches, measure the time from
/// `sendPatch` to the first MutationObserver callback on `[data-ac-world]`.
/// Each callback ≈ one DOM mutation batch ≈ one React commit; we want the
/// FIRST paint per patch (the latency the user perceives).
async function measurePatchLatency(page: any, samples: number): Promise<number[]> {
  return await page.evaluate(async (n: number) => {
    const w = window as any;
    const store = w.__canvasStore;
    if (!store) return [];
    const world = document.querySelector('[data-ac-world]');
    if (!world) return [];

    const doc = store.getState().document;
    // Skip the per-screen root frames — they don't move on `update` patches.
    const shapes = (doc.shapes || []).filter((s: any) => s.parentId !== null);
    if (!shapes.length) return [];

    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const shape = shapes[i % shapes.length];
      let paintTime = 0;
      const obs = new MutationObserver(() => {
        if (paintTime === 0) paintTime = performance.now();
      });
      obs.observe(world, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'transform'],
      });

      const t0 = performance.now();
      store.sendPatch({
        op: 'update',
        shapeId: shape.id,
        shape: { x: (i * 11) % 500 },
      });

      // Patch coalescing flushes on next rAF + 4ms trailing. Wait 50ms so the
      // observer reliably fires for the slow path; the latency we measure is
      // `t0 → paintTime`, NOT the wait itself.
      await new Promise<void>((r) => setTimeout(r, 50));
      obs.disconnect();
      if (paintTime > 0) times.push(paintTime - t0);
    }
    return times;
  }, samples);
}

/// Bulk-add commit count — single `bulk_add` patch with N nodes; count
/// MutationObserver callbacks. React batches all DOM mutations in one rAF into
/// one commit, so observer callbacks ≈ React commits (Appendix F: ≤ 3).
async function measureBulkAddCommits(page: any, nodeCount: number): Promise<number> {
  return await page.evaluate(async (n: number) => {
    const w = window as any;
    const store = w.__canvasStore;
    if (!store) return 0;
    const world = document.querySelector('[data-ac-world]');
    if (!world) return 0;

    const newShapes = Array.from({ length: n }, (_, i) => ({
      id: `bench-bulk-${Date.now()}-${i}`,
      type: 'rectangle',
      name: `Bench Bulk ${i}`,
      x: (i * 11) % 1000,
      y: (i * 17) % 600,
      width: 80,
      height: 24,
      fill: '#e2e8f0',
      stroke: '#64748b',
      strokeWidth: 0,
      radius: 4,
    }));

    let callbacks = 0;
    const obs = new MutationObserver(() => { callbacks++; });
    obs.observe(world, { childList: true, subtree: true, attributes: true });

    store.sendPatch({ op: 'bulk_add', shapes: newShapes });

    // Patch coalescing flushes on next rAF + 4ms trailing. Wait 500ms to be
    // safe (the bench_add operation itself can take a moment at large N).
    await new Promise<void>((r) => setTimeout(r, 500));
    obs.disconnect();
    return callbacks;
  }, nodeCount);
}

// ---- Main -----------------------------------------------------------------

interface CorpusResult extends CorpusMetrics {
  screens: number;
  panSamples: number;
  patchSamples: number;
}

async function runCorpus(page: any, corpus: CorpusDef): Promise<CorpusResult> {
  const doc = generateDocument({
    nodes: corpus.nodes,
    screens: corpus.screens,
    seed: corpus.seed,
  });
  const injected = await injectDocument(page, doc);
  if (!injected) {
    console.error(`     ⚠️  could not inject document (no test hook + no __canvasStore)`);
    return {
      name: corpus.name,
      nodes: corpus.nodes,
      screens: corpus.screens,
      panFrame: { n: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 },
      patchLatency: { n: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 },
      bulkAddCommits: 0,
      panSamples: 0,
      patchSamples: 0,
    };
  }
  // Wait for the render to settle (mutation quiet for 100ms).
  await page.waitForTimeout(500);

  const panSamples = await measurePanZoom(page, 60);
  const patchSamples = await measurePatchLatency(page, 30);
  const bulkCommits = await measureBulkAddCommits(page, 500);

  const panFrame = computeStats(panSamples);
  const patchLatency = computeStats(patchSamples);
  return {
    name: corpus.name,
    nodes: corpus.nodes,
    screens: corpus.screens,
    panFrame,
    patchLatency,
    bulkAddCommits: bulkCommits,
    panSamples: panSamples.length,
    patchSamples: patchSamples.length,
  };
}

function fmtMs(v: number): string {
  return v === 0 ? '—' : `${v.toFixed(1)}ms`;
}

function printSummary(results: CorpusResult[]): void {
  console.log('\n   ┌─────────┬───────┬─────────────────────┬─────────────────────┬──────────┐');
  console.log('   │ corpus │ nodes │ pan p50/p95/p99     │ patch p50/p95/p99   │ bulk add │');
  console.log('   ├─────────┼───────┼─────────────────────┼─────────────────────┼──────────┤');
  for (const r of results) {
    const pan = `${fmtMs(r.panFrame.p50)}/${fmtMs(r.panFrame.p95)}/${fmtMs(r.panFrame.p99)}`;
    const patch = `${fmtMs(r.patchLatency.p50)}/${fmtMs(r.patchLatency.p95)}/${fmtMs(r.patchLatency.p99)}`;
    const bulk = r.bulkAddCommits > 0 ? `${r.bulkAddCommits} commits` : '—';
    console.log(
      `   │ ${r.name.padEnd(7)} │ ${String(r.nodes).padStart(5)} │ ${pan.padEnd(19)} │ ${patch.padEnd(19)} │ ${bulk.padEnd(8)} │`,
    );
  }
  console.log('   └─────────┴───────┴─────────────────────┴─────────────────────┴──────────┘');
  console.log(`   Gates: pan p95 ≤ ${DEFAULT_GATES.p95Frame}ms @ ≥${DEFAULT_GATES.panFrameGateMinNodes}n · patch p95 ≤ ${DEFAULT_GATES.p95Patch}ms · bulk_add ≤ ${DEFAULT_GATES.bulkAddCommits} commits`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n🧪  DOM renderer bench — corpus=${args.corpus}, ci=${args.ci}, headless=${args.headless}`);

  const browser = await loadChromium(args.headless);
  if (!browser) {
    // Resilience: don't fail CI on missing browser — only real gate violations fail.
    console.log('   (Skipping bench — see message above.)');
    return 0;
  }

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);

    console.log(`   Opening ${DEFAULT_URL} ...`);
    try {
      await page.goto(DEFAULT_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    } catch {
      console.error(`\n❌  Dev server not reachable at ${DEFAULT_URL}.`);
      console.error('   Start it with `bun run dev` (or `bun run build && bun run start`).');
      console.error('   Override with BENCH_URL=http://host:port if needed.');
      return args.ci ? 1 : 0;
    }

    try {
      await page.waitForSelector('[data-ac-world]', { timeout: 15_000 });
    } catch {
      console.error('\n❌  [data-ac-world] not found — is the DOM renderer active?');
      console.error('   (Settings → Appearance → Renderer → DOM, or check the canvas mounted.)');
      return args.ci ? 1 : 0;
    }
    console.log('   Canvas mounted. Starting measurements.\n');

    const results: CorpusResult[] = [];
    for (const corpus of selectCorpora(args.corpus)) {
      console.log(`   ─── ${corpus.name} (${corpus.nodes} nodes, ${corpus.screens} screens) ───`);
      try {
        const result = await runCorpus(page, corpus);
        results.push(result);
      } catch (e: any) {
        console.error(`     ⚠️  ${corpus.name} measurement failed: ${e?.message || e}`);
        results.push({
          name: corpus.name,
          nodes: corpus.nodes,
          screens: corpus.screens,
          panFrame: { n: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 },
          patchLatency: { n: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 },
          bulkAddCommits: 0,
          panSamples: 0,
          patchSamples: 0,
        });
      }
    }

    printSummary(results);

    // Write results.json (gitignored — see .gitignore).
    writeFileSync(
      RESULTS_PATH,
      JSON.stringify(
        {
          ci: args.ci,
          url: DEFAULT_URL,
          timestamp: new Date().toISOString(),
          gates: DEFAULT_GATES,
          results,
        },
        null,
        2,
      ),
    );
    console.log(`\n   Results written to ${RESULTS_PATH}`);

    // Gate evaluation.
    const gate = gateEnforced(results);
    if (args.ci) {
      if (!gate.pass) {
        console.error('\n❌  CI gate violations:');
        for (const v of gate.violations) console.error(`     - ${v}`);
        return 1;
      }
      console.log('\n✅  All CI gates passed.');
    } else {
      if (!gate.pass) {
        console.log('\n⚠️  Advisory (gates NOT enforced — re-run with --ci to fail):');
        for (const v of gate.violations) console.log(`     - ${v}`);
      } else {
        console.log('\n✅  All gates within thresholds.');
      }
    }
    return 0;
  } finally {
    await browser.close();
  }
}

// Run + exit with the proper code.
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('\n💥  Bench runner crashed:', err);
    process.exit(1);
 });

// Make sure file-existence check doesn't get tree-shaken (used by tests).
export const _resultsPath = RESULTS_PATH;
export const _exists = (): boolean => existsSync(RESULTS_PATH);
export type { Stats };
