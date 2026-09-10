// speed-bench/run.ts — Design generation speed benchmark for pi-agent.
//
// Measures for each scenario:
//   - TTFT              (time to first tool_call_start event, ms)
//   - T2FP              (time to first canvas patch, ms)
//   - T2C               (time to turn_end / completion, ms)
//   - toolCallCount
//   - toolNames histogram
//   - patchCount
//   - errorEvents
//   - modelUsed
//   - usedFallback
//
// Runs scenarios across complexity tiers and emits a structured report.
//
// Usage:
//   bun scripts/speed-bench/run.ts [--only=id1,id2] [--out=results/baseline]
//                                    [--repeats=N] [--provider=zai|custom]
//                                    [--thinking=low|medium|high]
//
// Requires the dev server on :3000 (bash scripts/start-dev.sh).

import { applyPatchToCanvas } from '../../src/lib/canvas/patch';
import { normalizeCanvas } from '../../src/lib/agent/runner-legacy';
import { createEmptyCanvasDocument } from '../../src/lib/canvas/types';
import type { CanvasDocument, CanvasPatch, SyncEvent } from '../../src/lib/canvas/types';
import { DEFAULT_SETTINGS } from '../../src/lib/settings/types';

// ---- Scenario matrix --------------------------------------------------------

interface BenchScenario {
  id: string;
  prompt: string;
  tier: 'trivial' | 'simple' | 'multi' | 'complex' | 'flow';
  seed?: CanvasDocument;
}

const SCENARIOS: BenchScenario[] = [
  {
    id: 'trivial-shape',
    tier: 'trivial',
    prompt: 'Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.',
  },
  {
    id: 'trivial-heading',
    tier: 'trivial',
    prompt: "Add a bold heading that says 'Quarterly Report' at 32px, centered near the top of the canvas.",
  },
  {
    id: 'simple-login',
    tier: 'simple',
    prompt: "Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.",
  },
  {
    id: 'simple-pricing',
    tier: 'simple',
    prompt: "Design a pricing section with 3 plan cards side by side: Starter at $9/mo, Pro at $29/mo highlighted as 'Most Popular', and Enterprise at $99/mo. Each card lists at least 3 features.",
  },
  {
    id: 'simple-settings',
    tier: 'simple',
    prompt: "Design an account settings panel: a round avatar, the name 'Ada Lovelace', an email field showing ada@example.org, a timezone selector, and Save and Cancel buttons.",
  },
  {
    id: 'multi-dashboard',
    tier: 'multi',
    prompt: "Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.",
  },
  {
    id: 'multi-kanban',
    tier: 'multi',
    prompt: 'Create a kanban board with three columns — To Do, In Progress, Done — each column with a header and two task cards with realistic task titles.',
  },
  {
    id: 'multi-chart',
    tier: 'multi',
    prompt: 'Design a polished analytics chart panel: a header, a legend with 3 series (Revenue, Costs, Profit), a bar+line combo chart with 8 months on the x-axis, and a stat strip below.',
  },
  {
    id: 'complex-landing',
    tier: 'complex',
    prompt: "Design a marketing landing page for an AI design tool called 'Prism': sticky nav with logo + 4 links + Sign Up CTA, a hero with headline + subhead + 2 CTAs + product mockup, a 3-feature grid, a testimonials carousel (2 cards visible), a pricing teaser (2 plans), and a footer with 4 link columns.",
  },
  {
    id: 'complex-ecommerce',
    tier: 'complex',
    prompt: 'Design an e-commerce category page: filter sidebar (8 facets), a 4x2 product grid with image / title / price / rating / add-to-cart, a sticky header with search + cart, and a pagination footer.',
  },
  {
    id: 'flow-onboarding',
    tier: 'flow',
    prompt: 'Design a 3-screen mobile onboarding flow side-by-side on the canvas: Screen 1 = hero image + headline + Skip; Screen 2 = icon + 3 bullet features + Next; Screen 3 = email/password form + Sign Up CTA + "Already have an account? Sign in".',
  },
];

// ---- CLI args ---------------------------------------------------------------

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const outArg = args.find((a) => a.startsWith('--out='));
const repeatsArg = args.find((a) => a.startsWith('--repeats='));
const providerArg = args.find((a) => a.startsWith('--provider='));
const thinkingArg = args.find((a) => a.startsWith('--thinking='));

const ONLY = onlyArg ? onlyArg.split('=').slice(1).join('=').split(',') : null;
const OUT = outArg ? outArg.split('=')[1] : 'results/speed-bench';
const REPEATS = repeatsArg ? Math.max(1, Number(repeatsArg.split('=')[1]) || 1) : 1;
const PROVIDER = providerArg ? providerArg.split('=')[1] : DEFAULT_SETTINGS.llmProvider;
const THINKING = thinkingArg ? thinkingArg.split('=')[1] : DEFAULT_SETTINGS.thinkingLevel;

const SCENARIO_TIMEOUT_MS = 6 * 60 * 1000; // 6 min cap per scenario (multi-chart hit 4min in after-P0)
const COOLDOWN_S = 30; // z.ai sandbox rate-limit window needs ~30s between scenarios
                       // (was 10s — too short, caused rate-limit ladder to fire on
                       // simple-pricing + multi-chart in the after-P0 bench)

// ---- single scenario run ----------------------------------------------------

interface ScenarioMetrics {
  id: string;
  tier: string;
  prompt: string;
  startedAt: string;
  repeatIndex: number;
  ttftMs: number | null;           // time to first tool_call_start
  t2fpMs: number | null;          // time to first patch
  t2cMs: number | null;           // time to turn_end / completion
  toolCallCount: number;
  patchCount: number;
  errorEvents: string[];
  modelUsed: string | null;
  usedFallback: boolean;
  finalLayerCount: number;
  status: 'complete' | 'error' | 'timeout';
  toolNames: Array<[string, number]>;  // tool-name histogram (for diagnosing read-back loops)
}

async function runScenario(
  scenario: BenchScenario,
  repeatIndex: number,
): Promise<ScenarioMetrics> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const metrics: ScenarioMetrics = {
    id: scenario.id,
    tier: scenario.tier,
    prompt: scenario.prompt,
    startedAt,
    repeatIndex,
    ttftMs: null,
    t2fpMs: null,
    t2cMs: null,
    toolCallCount: 0,
    patchCount: 0,
    errorEvents: [],
    modelUsed: null,
    usedFallback: false,
    finalLayerCount: 0,
    status: 'error',
    toolNames: [],
  };

  // Tool-name histogram (for diagnosing read-back loops). Populated from
  // agent:tool_call_start events.
  const toolNameMap = new Map<string, number>();

  const seed = scenario.seed ?? createEmptyCanvasDocument(`bench-${scenario.id}`);
  const canvas = normalizeCanvas(seed);

  const body = {
    prompt: scenario.prompt,
    canvas,
    settings: {
      ...DEFAULT_SETTINGS,
      llmProvider: PROVIDER,
      thinkingLevel: THINKING,
      maxIterations: 30,
      designCritiqueMode: 'manual', // production default — critics stay silent unless /critique
    },
    images: [],
    selection: { nodeIds: [], mode: 'replace' },
    sessionId: `bench-${scenario.id}-${repeatIndex}-${Date.now()}`,
    runId: `bench-run-${scenario.id}-${repeatIndex}`,
    userMessageId: `bench-um-${scenario.id}-${repeatIndex}-${Date.now()}`,
    assistantMessageId: `bench-am-${scenario.id}-${repeatIndex}-${Date.now()}`,
    canvasDelta: null,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCENARIO_TIMEOUT_MS);

  try {
    const res = await fetch('http://localhost:3000/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      metrics.errorEvents.push(`HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200));
      metrics.t2cMs = Date.now() - t0;
      return metrics;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // NDJSON: split on \n, keep partial last
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: SyncEvent;
        try {
          ev = JSON.parse(line) as SyncEvent;
        } catch {
          continue;
        }

        // Use any-cast because SyncEvent union is large; we only need type + a few fields
        const evType = (ev as { type?: string }).type ?? '';
        const now = Date.now();

        // First patch (canvas mutation applied)
        if (evType === 'patch' && metrics.t2fpMs === null) {
          metrics.t2fpMs = now - t0;
          try {
            applyPatchToCanvas(canvas, (ev as { patch: CanvasPatch }).patch);
          } catch {
            /* ignore */
          }
        }
        if (evType === 'patch') {
          metrics.patchCount++;
          try {
            applyPatchToCanvas(canvas, (ev as { patch: CanvasPatch }).patch);
          } catch {
            /* ignore */
          }
        }

        // Agent events — first tool_call_start is our TTFT signal.
        // The translator emits types with the `agent:` prefix (e.g. `agent:tool_call_start`).
        if (evType === 'agent_event') {
          const inner = (ev as { event?: { type?: string; toolName?: string; model?: string; usedFallback?: boolean } }).event ?? {};
          const innerType = inner.type ?? '';

          if ((innerType === 'agent:tool_call_start' || innerType === 'tool_call_start') && metrics.ttftMs === null) {
            metrics.ttftMs = now - t0;
          }
          if (innerType === 'agent:tool_call_start' || innerType === 'tool_call_start') {
            // Track tool-name histogram for diagnosing read-back loops.
            const name = inner.toolName ?? '(unknown)';
            toolNameMap.set(name, (toolNameMap.get(name) ?? 0) + 1);
          }
          if (innerType === 'agent:tool_call_start' || innerType === 'agent:tool_call_end' || innerType === 'tool_call_start' || innerType === 'tool_call_end') {
            metrics.toolCallCount++;
          }
          if (innerType === 'agent:model_info' || innerType === 'model_info') {
            metrics.modelUsed = inner.model ?? metrics.modelUsed;
            metrics.usedFallback = metrics.usedFallback || Boolean(inner.usedFallback);
          }
          if (innerType === 'agent:error' || innerType === 'agent:turn_cancelled' || innerType === 'agent:stuck' || innerType === 'error' || innerType === 'turn_cancelled' || innerType === 'stuck') {
            metrics.errorEvents.push(`${innerType}:${inner.toolName ?? ''}`.slice(0, 120));
          }
          if (innerType === 'agent:turn_end' || innerType === 'turn_end') {
            metrics.t2cMs = now - t0;
            metrics.status = 'complete';
          }
        }
      }
    }

    // If the stream closed without an explicit turn_end (e.g. demo / closed by upstream),
    // still record the wall-clock and infer success if we got patches.
    if (metrics.t2cMs === null) {
      metrics.t2cMs = Date.now() - t0;
      metrics.status = metrics.patchCount > 0 && metrics.errorEvents.length === 0 ? 'complete' : 'timeout';
    }

    metrics.finalLayerCount = canvas.shapes?.length ?? 0;
  } catch (err) {
    metrics.t2cMs = Date.now() - t0;
    metrics.errorEvents.push(
      controller.signal.aborted ? 'TIMEOUT' : (err as Error).message.slice(0, 200),
    );
    metrics.status = controller.signal.aborted ? 'timeout' : 'error';
  } finally {
    clearTimeout(timeout);
  }

  // Finalize the tool-name histogram (sorted by count descending).
  metrics.toolNames = [...toolNameMap.entries()].sort((a, b) => b[1] - a[1]);

  return metrics;
}

// ---- runner ----------------------------------------------------------------

async function main() {
  const scenarios = ONLY ? SCENARIOS.filter((s) => ONLY.includes(s.id)) : SCENARIOS;
  const outDir = OUT.startsWith('/') ? OUT : `${process.cwd()}/${OUT}`;
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  AgentCanvas pi-agent SPEED BENCHMARK');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  provider : ${PROVIDER}`);
  console.log(`  thinking : ${THINKING}`);
  console.log(`  scenarios: ${scenarios.length}    repeats: ${REPEATS}`);
  console.log(`  outDir   : ${outDir}`);
  console.log('──────────────────────────────────────────────────────────────');

  const allRuns: ScenarioMetrics[] = [];

  for (const sc of scenarios) {
    for (let r = 0; r < REPEATS; r++) {
      process.stdout.write(
        `\n▶ ${sc.id.padEnd(20)} [tier=${sc.tier.padEnd(8)}] r${r + 1}/${REPEATS}  …`,
      );
      const m = await runScenario(sc, r);
      allRuns.push(m);
      const summary = `ttft=${m.ttftMs ?? '-'}ms t2fp=${m.t2fpMs ?? '-'}ms t2c=${m.t2cMs ?? '-'}ms calls=${m.toolCallCount} patches=${m.patchCount} status=${m.status}`.padEnd(8);
      process.stdout.write('\r' + ' '.repeat(120) + '\r');
      console.log(`▶ ${sc.id.padEnd(20)} [tier=${sc.tier.padEnd(8)}] r${r + 1}/${REPEATS}  ${summary}`);
      if (m.errorEvents.length > 0) {
        console.log(`    errors: ${m.errorEvents.slice(0, 3).join(' | ')}`);
      }
      // Tool-name histogram (for diagnosing read-back loops).
      if (m.toolNames.length > 0) {
        const top3 = m.toolNames.slice(0, 3).map(([n, c]) => `${n}×${c}`).join(' ');
        console.log(`    tools: ${top3}${m.toolNames.length > 3 ? ` (+${m.toolNames.length - 3} more)` : ''}`);
      }
      // cooldown between runs to dodge rate limits
      if (!(sc === scenarios[scenarios.length - 1] && r === REPEATS - 1)) {
        await new Promise((res) => setTimeout(res, COOLDOWN_S * 1000));
      }
    }
  }

  // ---- aggregate per scenario + tier --------------------------------------

  interface TierAgg {
    tier: string;
    n: number;
    ttftP50: number | null;
    ttftP95: number | null;
    t2fpP50: number | null;
    t2fpP95: number | null;
    t2cP50: number | null;
    t2cP95: number | null;
    toolCallsP50: number | null;
    toolCallsP95: number | null;
    patchesP50: number | null;
    completeRate: number;
    fallbackRate: number;
  }

  function pct(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
  }

  const tierAgg: Record<string, TierAgg> = {};
  for (const tier of ['trivial', 'simple', 'multi', 'complex', 'flow']) {
    const runs = allRuns.filter((r) => r.tier === tier);
    if (runs.length === 0) continue;
    const ttfts = runs.filter((r) => r.ttftMs !== null).map((r) => r.ttftMs!) as number[];
    const t2fps = runs.filter((r) => r.t2fpMs !== null).map((r) => r.t2fpMs!) as number[];
    const t2cs = runs.filter((r) => r.t2cMs !== null).map((r) => r.t2cMs!) as number[];
    const tcs = runs.map((r) => r.toolCallCount);
    const ps = runs.map((r) => r.patchCount);
    tierAgg[tier] = {
      tier,
      n: runs.length,
      ttftP50: ttfts.length ? pct(ttfts, 50) : null,
      ttftP95: ttfts.length ? pct(ttfts, 95) : null,
      t2fpP50: t2fps.length ? pct(t2fps, 50) : null,
      t2fpP95: t2fps.length ? pct(t2fps, 95) : null,
      t2cP50: t2cs.length ? pct(t2cs, 50) : null,
      t2cP95: t2cs.length ? pct(t2cs, 95) : null,
      toolCallsP50: tcs.length ? pct(tcs, 50) : null,
      toolCallsP95: tcs.length ? pct(tcs, 95) : null,
      patchesP50: ps.length ? pct(ps, 50) : null,
      completeRate: runs.filter((r) => r.status === 'complete').length / runs.length,
      fallbackRate: runs.filter((r) => r.usedFallback).length / runs.length,
    };
  }

  // ---- print summary -------------------------------------------------------

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS — by tier');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('tier       n   ttftP50  ttftP95  t2fpP50  t2fpP95  t2cP50    t2cP95    callsP50 callsP95 patches  complete fallback');
  console.log('─'.repeat(150));
  for (const t of Object.values(tierAgg)) {
    console.log(
      [
        t.tier.padEnd(10),
        String(t.n).padStart(2),
        String(t.ttftP50 ?? '-').padStart(8),
        String(t.ttftP95 ?? '-').padStart(8),
        String(t.t2fpP50 ?? '-').padStart(8),
        String(t.t2fpP95 ?? '-').padStart(8),
        String(t.t2cP50 ?? '-').padStart(9),
        String(t.t2cP95 ?? '-').padStart(9),
        String(t.toolCallsP50 ?? '-').padStart(8),
        String(t.toolCallsP95 ?? '-').padStart(8),
        String(t.patchesP50 ?? '-').padStart(8),
        `${(t.completeRate * 100).toFixed(0)}%`.padStart(8),
        `${(t.fallbackRate * 100).toFixed(0)}%`.padStart(8),
      ].join(' '),
    );
  }

  // ---- write JSON ---------------------------------------------------------

  const reportPath = `${outDir}/speed-bench-${Date.now()}.json`;
  writeFileSync(reportPath, JSON.stringify({
    startedAt: allRuns[0]?.startedAt,
    finishedAt: new Date().toISOString(),
    provider: PROVIDER,
    thinking: THINKING,
    repeats: REPEATS,
    runs: allRuns,
    tierAgg,
  }, null, 2));
  console.log(`\nWrote: ${reportPath}`);

  // ---- also write markdown summary ---------------------------------------

  const mdPath = `${outDir}/speed-bench-${Date.now()}.md`;
  const md: string[] = [];
  md.push('# pi-agent speed benchmark\n');
  md.push(`- Provider: \`${PROVIDER}\``);
  md.push(`- Thinking: \`${THINKING}\``);
  md.push(`- Repeats per scenario: ${REPEATS}`);
  md.push(`- Ran at: ${new Date().toISOString()}\n`);
  md.push('## Per-tier results\n');
  md.push('| Tier | n | TTFT p50 (ms) | TTFT p95 | T2FP p50 | T2FP p95 | T2C p50 (ms) | T2C p95 | Calls p50 | Calls p95 | Patches p50 | Complete | Fallback |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of Object.values(tierAgg)) {
    md.push(`| ${t.tier} | ${t.n} | ${t.ttftP50 ?? '-'} | ${t.ttftP95 ?? '-'} | ${t.t2fpP50 ?? '-'} | ${t.t2fpP95 ?? '-'} | ${t.t2cP50 ?? '-'} | ${t.t2cP95 ?? '-'} | ${t.toolCallsP50 ?? '-'} | ${t.toolCallsP95 ?? '-'} | ${t.patchesP50 ?? '-'} | ${(t.completeRate * 100).toFixed(0)}% | ${(t.fallbackRate * 100).toFixed(0)}% |`);
  }
  md.push('\n## Per-run details\n');
  md.push('| Scenario | Tier | Repeat | TTFT (ms) | T2FP (ms) | T2C (ms) | Calls | Patches | Status | Model |');
  md.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of allRuns) {
    md.push(`| ${r.id} | ${r.tier} | ${r.repeatIndex} | ${r.ttftMs ?? '-'} | ${r.t2fpMs ?? '-'} | ${r.t2cMs ?? '-'} | ${r.toolCallCount} | ${r.patchCount} | ${r.status} | ${r.modelUsed ?? '-'} |`);
  }
  // Tool-name histogram (for diagnosing read-back loops).
  md.push('\n## Tool-name histogram (per run)\n');
  md.push('> Helps diagnose read-back loops (e.g. pen_get_metadata called 10× = the agent is stuck reading instead of building).\n');
  for (const r of allRuns) {
    if (r.toolNames.length === 0) continue;
    md.push(`\n### ${r.id} r${r.repeatIndex} (${r.toolCallCount} calls, ${r.patchCount} patches)\n`);
    md.push('| Tool | Count |');
    md.push('|---|---|');
    for (const [name, count] of r.toolNames) {
      md.push(`| ${name} | ${count} |`);
    }
  }
  writeFileSync(mdPath, md.join('\n'));
  console.log(`Wrote: ${mdPath}`);
}

main().catch((err) => {
  console.error('BENCH FAILED:', err);
  process.exit(1);
});
