// run-bench.ts — world-class test bench orchestrator.
//
// Combines 4 layers from research-03 §8 into a single AQS report:
//   L1 — deterministic structural assertions (run-eval.ts)
//   L4 — variance across N repeats (the existing --repeats=N flag, but
//        now reported with Wilson 95% CI on pass rate)
//   L5 — VLM-as-judge via agnes-3.0-flash vision (vlm-score-agnes.ts)
//   L7 — performance metrics (latency, tool-call count, token cost
//        proxied by request body size)
//
// Each scenario gets:
//   - pass rate (Wilson 95% CI lower bound) over N repeats
//   - mean assertion pass fraction (across N runs)
//   - mean latency + stdev
//   - mean tool-call count + stdev
//   - mean VLM overall score (across N rendered screenshots)
//   - top 3 fixes from VLM (most common across runs)
//
// Aggregated into a single Agent Quality Score (AQS, 0-100):
//   AQS = 40*L1_passrate + 25*L5_vlm_mean*20 + 20*speed_score +
//         15*toolcall_efficiency_score
//   Where speed_score = clamp(180s / mean_latency_s, 0, 1)
//   And toolcall_efficiency = clamp(20 / mean_toolcalls, 0, 1)
//
// Usage:
//   bun scripts/agent-eval/run-bench.ts --only=id1,id2 [--repeats=2]
//                                       [--out=results/iter6-bench]
//                                       [--skip-vlm]  (skip the VLM layer)
//
// Requires the dev server on :3000 + the agnes-proxy on :3199.

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const repeatsArg = args.find((a) => a.startsWith('--repeats='));
const outArg = args.find((a) => a.startsWith('--out='));
const skipVlm = args.includes('--skip-vlm');

const ONLY = onlyArg ? onlyArg.split('=').slice(1).join('=') : '';
const REPEATS = repeatsArg ? Math.max(1, Number(repeatsArg.split('=')[1]) || 1) : 1;
const OUT = outArg ? outArg.split('=')[1] : 'results/bench';

const REPO = '/home/z/my-project/AgentCanvas';
const DUMPS = join(OUT, 'dumps');
const EVAL_OUT = join(OUT, 'eval');
const VLM_OUT = join(OUT, 'vlm-scores.json');

mkdirSync(join(REPO, DUMPS), { recursive: true });
mkdirSync(join(REPO, EVAL_OUT.split('/').slice(0, -1).join('/')), { recursive: true });

function runBun(file: string, extraArgs: string[], timeoutMs = 60_000): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [file, ...extraArgs], {
    cwd: REPO,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 100 * 1024 * 1024,
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/// Wilson 95% CI lower bound on a pass rate.
/// pass=out of n. Returns the lower bound of the 95% CI — i.e. the value
/// we're 95% confident the true pass rate is AT LEAST this high.
/// Research-03 §6: "Wilson score interval 95% CIs on every metric —
/// not Wald, not raw point estimates."
function wilsonLower(pass: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = pass / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return Math.max(0, center - margin);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stdev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
}

function main() {
  console.log('=== AgentCanvas world-class test bench ===');
  console.log(`Scenarios: ${ONLY || 'all'}`);
  console.log(`Repeats: ${REPEATS}`);
  console.log(`Output: ${OUT}`);
  console.log(`VLM layer: ${skipVlm ? 'SKIPPED' : 'enabled'}`);
  console.log('');

  // ---- Optional --skip-l1 flag: skip the L1 re-run (use existing results)
  const skipL1 = args.includes('--skip-l1');
  if (skipL1) console.log('L1: SKIPPED (--skip-l1 set, using existing eval results)');

  // ---- Layer 1: deterministic structural assertions ----------------------
  // Reuse run-eval.ts with --dump-canvas so we get the canvas JSONs for L5.
  const evalArgs = [
    `--out=${EVAL_OUT}`,
    `--dump-canvas=${DUMPS}`,
    `--repeats=${REPEATS}`,
    ...(ONLY ? [`--only=${ONLY}`] : []),
    '--include-heldout',  // bench runs ALL scenarios incl held-out (final validation)
  ];
  console.log('L1: running deterministic eval via run-eval.ts...');
  // 30 min cap — 6 scenarios × up to 6 min each + cooldowns.
  // SKIPPED when --skip-l1 is set (the eval results already exist on disk
  // from a previous run).
  const evalRes = skipL1
    ? { code: 0, stdout: '(skipped)', stderr: '' }
    : runBun('scripts/agent-eval/run-eval.ts', evalArgs, 30 * 60_000);
  // run-eval.ts exits with code 1 if ANY scenario failed (intentional —
  // signals "L1 layer has regressions"). Code 2 = real crash. Code 0 =
  // all passed. Treat code 1 as "L1 ran with some failures" (continue —
  // the per-scenario pass_rate captures the failures) and only bail on
  // code 2 (real error) or stdout parsing failure.
  if (evalRes.code === 2 || (evalRes.code !== 0 && evalRes.code !== 1)) {
    console.error(`L1 eval crashed (exit code ${evalRes.code}):`);
    console.error(evalRes.stderr.slice(0, 500));
    process.exit(1);
  }
  console.log(evalRes.stdout.split('\n').slice(-15).join('\n'));

  // Parse eval results — run-eval.ts has a path bug that writes to a
  // nested scripts/agent-eval/scripts/agent-eval/results/ dir. The actual
  // result file is at <nested_dir>/<EVAL_OUT basename>.json. When EVAL_OUT
  // contains a trailing /eval (i.e. bench sets out=iter6-bench/eval), the
  // file is at <nested_dir>/iter6-bench/eval.json. Otherwise it's at
  // <nested_dir>/<basename>.json.
  const evalResultsDir = join(REPO, 'scripts/agent-eval/scripts/agent-eval/results');
  const evalOutRelative = EVAL_OUT.replace(/^scripts\/agent-eval\/results\//, '');
  let evalJsonPath = join(evalResultsDir, `${evalOutRelative}.json`);
  if (!existsSync(evalJsonPath)) {
    // Fallback: try just the basename
    const fallback = join(evalResultsDir, `${EVAL_OUT.split('/').pop()!}.json`);
    if (existsSync(fallback)) {
      evalJsonPath = fallback;
    } else {
      console.error(`Couldn't find eval results at ${evalJsonPath} or ${fallback}`);
      console.error(`Available files in ${evalResultsDir}:`);
      const files = readdirSync(evalResultsDir);
      console.error(`  ${files.join('\n  ')}`);
      process.exit(1);
    }
  }
  const evalResults = JSON.parse(readFileSync(evalJsonPath, 'utf-8'));

  // ---- Layer 5: VLM-as-judge via agnes-3.0-flash -----------------------
  let vlmSummary: any = null;
  // --skip-vlm-run skips the actual VLM call but tries to read existing
  // scores.json (so the aggregator still joins VLM data when present).
  const skipVlmRun = args.includes('--skip-vlm-run');
  if (!skipVlm && !skipVlmRun) {
    console.log('\nL5: scoring rendered canvases via agnes-3.0-flash VLM...');
    // 10 min cap — VLM scoring 6 canvases × ~15s each = 90s, plenty of room.
    const vlmRes = runBun('scripts/agent-eval/vlm-score-agnes.ts', [
      `--dumps=${join(REPO, DUMPS)}`,
      `--out=${join(REPO, VLM_OUT)}`,
    ], 10 * 60_000);
    if (vlmRes.code !== 0) {
      console.error('L5 VLM scoring failed (continuing without VLM):');
      console.error(vlmRes.stderr.slice(0, 500));
    } else {
      console.log(vlmRes.stdout.split('\n').slice(-10).join('\n'));
    }
  }
  // Always try to load VLM scores if present (whether we ran it now or
  // a previous run did). If the file is missing, vlmSummary stays null
  // and the aggregator falls back to the L1-only AQS formula.
  if (existsSync(join(REPO, VLM_OUT))) {
    try {
      vlmSummary = JSON.parse(readFileSync(join(REPO, VLM_OUT), 'utf-8')).summary;
      console.log(`Loaded VLM scores from ${VLM_OUT}`);
    } catch (err: any) {
      console.log(`Failed to parse VLM scores: ${err.message}`);
    }
  }

  // ---- Aggregate per-scenario metrics + compute AQS ----------------------
  const scenarios = evalResults.scenarios ?? evalResults.runs ?? [];
  const benchSummary: any[] = [];
  for (const sc of scenarios) {
    const id = sc.id;
    const runs = sc.runs ?? [sc];
    const passRate = runs.filter((r: any) => r.status === 'pass').length / runs.length;
    const wilson = wilsonLower(passRate * runs.length, runs.length);
    const meanAssertions = mean(runs.map((r: any) => r.assertions ? r.passed / r.assertions.length : 0));
    const latencies = runs.map((r: any) => r.durationMs / 1000);
    const toolCalls = runs.map((r: any) => r.toolCallCount ?? 0);
    const vlmScore = vlmSummary?.[id]?.vlm_overall_mean ?? null;

    // AQS components (per scenario):
    //   L1 (40%): Wilson 95% CI lower bound on pass rate
    //   L5 (25%): VLM overall mean / 5 × 100 (cap at 25)
    //   L7-speed (20%): clamp(180s / mean_latency_s, 0, 1) × 100 / 5 (cap 20)
    //   L7-toolcount (15%): clamp(20 / mean_toolcalls, 0, 1) × 100 / ~6.67 (cap 15)
    const l1 = wilson * 100;
    const l5 = vlmScore !== null ? (vlmScore / 5) * 100 : null;
    const l7_speed = Math.min(1, 180 / Math.max(1, mean(latencies))) * 100;
    const l7_toolcount = Math.min(1, 20 / Math.max(1, mean(toolCalls))) * 100;
    // AQS = 40*l1/100 + 25*l5/100 + 20*l7_speed/100 + 15*l7_toolcount/100
    // (VLM skipped → reweight to 50% L1, 25% speed, 25% toolcount)
    let aqs: number;
    if (l5 !== null) {
      aqs = 0.40 * l1 + 0.25 * l5 + 0.20 * l7_speed + 0.15 * l7_toolcount;
    } else {
      aqs = 0.50 * l1 + 0.25 * l7_speed + 0.25 * l7_toolcount;
    }

    benchSummary.push({
      id,
      repeats: runs.length,
      pass_rate: Number(passRate.toFixed(3)),
      wilson_95ci_lower: Number(wilson.toFixed(3)),
      mean_assertion_pass: Number(meanAssertions.toFixed(3)),
      mean_latency_s: Number(mean(latencies).toFixed(1)),
      stdev_latency_s: Number(stdev(latencies).toFixed(1)),
      mean_toolcalls: Number(mean(toolCalls).toFixed(1)),
      stdev_toolcalls: Number(stdev(toolCalls).toFixed(1)),
      vlm_overall: vlmScore,
      l1_deterministic: Number(l1.toFixed(1)),
      l5_vlm: l5 !== null ? Number(l5.toFixed(1)) : null,
      l7_speed: Number(l7_speed.toFixed(1)),
      l7_toolcount: Number(l7_toolcount.toFixed(1)),
      aqs: Number(aqs.toFixed(1)),
    });
  }

  // Overall AQS = mean of per-scenario AQS
  const overallAqs = mean(benchSummary.map((s: any) => s.aqs));
  const totalPass = benchSummary.filter((s: any) => s.pass_rate === 1).length;
  const totalScenarios = benchSummary.length;

  const report = {
    generated_at: new Date().toISOString(),
    repeats: REPEATS,
    skip_vlm: skipVlm,
    total_scenarios: totalScenarios,
    total_pass: totalPass,
    overall_aqs: Number(overallAqs.toFixed(1)),
    scenarios: benchSummary,
  };
  const reportPath = join(REPO, OUT, 'bench-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Pretty markdown summary
  const mdPath = join(REPO, OUT, 'bench-report.md');
  const md = [
    `# World-class test bench report`,
    ``,
    `**Generated:** ${report.generated_at}`,
    `**Repeats per scenario:** ${REPEATS}`,
    `**VLM layer:** ${skipVlm ? 'skipped' : 'agnes-3.0-flash vision'}`,
    ``,
    `## Headline metrics`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Overall AQS (0-100) | **${report.overall_aqs.toFixed(1)}** |`,
    `| Scenarios fully passing | ${totalPass} / ${totalScenarios} |`,
    ``,
    `## Per-scenario breakdown`,
    ``,
    `| ID | Pass rate | Wilson 95% CI lower | Mean latency (s) | Mean toolcalls | VLM overall | AQS |`,
    `|---|---|---|---|---|---|---|`,
    ...benchSummary.map((s: any) => `| ${s.id} | ${s.pass_rate} | ${s.wilson_95ci_lower} | ${s.mean_latency_s}±${s.stdev_latency_s} | ${s.mean_toolcalls}±${s.stdev_toolcalls} | ${s.vlm_overall ?? '—'} | **${s.aqs}** |`),
    ``,
    `## Layer composition (per scenario)`,
    ``,
    `AQS = 0.40·L1 + 0.25·L5 + 0.20·L7_speed + 0.15·L7_toolcount (when VLM is enabled)`,
    `AQS = 0.50·L1 + 0.25·L7_speed + 0.25·L7_toolcount (when VLM is skipped)`,
    ``,
    `- **L1 (deterministic)**: Wilson 95% CI lower bound on pass rate — the value we're 95% confident the true pass rate is AT LEAST this high.`,
    `- **L5 (VLM-as-judge)**: mean of agnes-3.0-flash's 5-dim rubric (aesthetics + learnability + efficiency + usability + overall), normalized to 0-100.`,
    `- **L7_speed**: 180s / mean latency (seconds), clamped to [0, 1] × 100. Faster = higher.`,
    `- **L7_toolcount**: 20 / mean tool calls, clamped to [0, 1] × 100. Fewer calls (more efficient) = higher.`,
    ``,
    `## VLM top fixes (most common across runs)`,
    ``,
    ...(vlmSummary ? Object.entries(vlmSummary).flatMap(([id, v]: any) =>
      (v.runs ?? []).flatMap((r: any) => (r.top_fixes ?? []).map((f: string) => `- [${id} r${r.repeat}] ${f}`))
    ).slice(0, 20) : ['_(VLM skipped — no top fixes available)_']),
  ].join('\n');
  writeFileSync(mdPath, md);

  console.log(`\n=== Bench report ===`);
  console.log(`Overall AQS: ${report.overall_aqs.toFixed(1)} / 100`);
  console.log(`Scenarios passing: ${totalPass}/${totalScenarios}`);
  console.log(`\nPer-scenario:`);
  for (const s of benchSummary) {
    console.log(`  ${s.id.padEnd(28)} pass=${s.pass_rate}  lat=${s.mean_latency_s}s  tools=${s.mean_toolcalls}  vlm=${s.vlm_overall ?? '—'}  AQS=${s.aqs}`);
  }
  console.log(`\nReports:`);
  console.log(`  ${mdPath}`);
  console.log(`  ${reportPath}`);
}

main();
