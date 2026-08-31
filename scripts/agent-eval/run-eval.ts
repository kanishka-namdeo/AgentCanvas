// run-eval.ts — Prompt-vs-output evaluator for the AgentCanvas agent.
//
// For each scenario in scenarios.ts:
//   1. POST the prompt to the REAL /api/agent route (same path production uses)
//   2. Consume the NDJSON stream, applying every canvas patch via the app's
//      own applyPatchToCanvas (so the final state == what the browser would show)
//   3. Run the scenario's assertions over (finalCanvas, trajectory)
//   4. Emit a per-scenario + summary report (JSON + markdown) and dump the
//      final canvas doc for post-mortem debugging
//
// Usage:
//   bun scripts/agent-eval/run-eval.ts [--only=id1,id2] [--out=results/baseline]
//                                      [--repeats=N] [--include-heldout] [--delay=S]
//
// --repeats=N        run every scenario N times and report variance (pass rate,
//                    tool-call/duration mean+min+max, per-assertion flakiness).
//                    Single-run pass/fail is nearly meaningless at this agent's
//                    non-determinism level (the same scenario passed and failed
//                    7 minutes apart in the 2026-08-23 history) — repeats make
//                    the signal visible.
// --include-heldout  also run held-out scenarios (default: EXCLUDED so dev
//                    iteration cannot teach to them; final validation only).
//
// Requires the dev server on :3000 (bash scripts/start-dev.sh).

import { applyPatchToCanvas } from '../../src/lib/canvas/patch';
import { normalizeCanvas } from '../../src/lib/agent/runner-legacy';
import { createEmptyCanvasDocument } from '../../src/lib/canvas/types';
import type { CanvasDocument, CanvasPatch, SyncEvent } from '../../src/lib/canvas/types';
import { DEFAULT_SETTINGS } from '../../src/lib/settings/types';
import { SCENARIOS, type Scenario, type Trajectory, type AssertionResult } from './scenarios';

const API = process.env.EVAL_API ?? 'http://localhost:3000/api/agent';

// Prompt-tuning exercise: provider/model/thinking overrides for reproducible A/B runs
// (see download/prompt-tuning/). Defaults keep the production behavior.
const EVAL_PROVIDER = process.env.EVAL_PROVIDER ?? DEFAULT_SETTINGS.llmProvider;
const EVAL_MODEL = process.env.EVAL_MODEL ?? DEFAULT_SETTINGS.modelName;
const EVAL_THINKING = process.env.EVAL_THINKING ?? DEFAULT_SETTINGS.thinkingLevel;
const EVAL_CRITIQUES = process.env.EVAL_CRITIQUES !== undefined ? Number(process.env.EVAL_CRITIQUES) : undefined;

// ---- CLI args ---------------------------------------------------------------

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const outArg = args.find((a) => a.startsWith('--out='));
const delayArg = args.find((a) => a.startsWith('--delay='));
const repeatsArg = args.find((a) => a.startsWith('--repeats='));
const INCLUDE_HELDOUT = args.includes('--include-heldout');
const ONLY = onlyArg ? onlyArg.split('=').slice(1).join('=').split(',') : null;
const OUT = outArg ? outArg.split('=')[1] : 'results/eval';
/// Cooldown between scenarios AND between repeats (seconds). The sandbox LLM
/// endpoint rate-limits (HTTP 429) when heavy agent turns run back-to-back;
/// spacing them out keeps the eval measuring AGENT quality, not quota
/// exhaustion.
const DELAY_S = delayArg ? Number(delayArg.split('=')[1]) : 20;
/// How many times each scenario runs (variance measurement). Default 1.
const REPEATS = repeatsArg ? Math.max(1, Number(repeatsArg.split('=')[1]) || 1) : 1;
const SCENARIO_TIMEOUT_MS = 6 * 60 * 1000; // 6 min per scenario (LLM + tools)
const EMPTY_TURN_BACKOFF_MS = 90 * 1000; // wait before retrying an empty turn

// ---- run one scenario -------------------------------------------------------

interface ScenarioResult {
  id: string;
  prompt: string;
  startedAt: string;
  durationMs: number;
  toolCallCount: number;
  toolNames: Array<[string, number]>;
  assertions: AssertionResult[];
  passed: number;
  failed: number;
  status: 'pass' | 'fail' | 'error';
  errorMessage?: string;
  finalLayerCount: number;
  /// 1-based repeat index (1 when running without --repeats).
  repeat?: number;
  /// Diagnostic dump: every text layer's content (only recorded when the
  /// scenario FAILS, to keep reports small). Makes copy-fidelity failures
  /// debuggable without re-running.
  textLayers?: Array<{ name: string; text: string }>;
}

/// Per-scenario variance roll-up across repeats (REPEATS > 1).
interface ScenarioAggregate {
  id: string;
  prompt: string;
  heldOut: boolean;
  runs: number;
  /// Fraction of runs with status === 'pass'.
  passRate: number;
  statusSpread: { pass: number; fail: number; error: number };
  toolCalls: { mean: number; min: number; max: number };
  durationS: { mean: number; min: number; max: number };
  assertionsPassed: number;
  assertionsTotal: number;
  /// Assertions that failed in at least one run (pass rate < 1.0), sorted
  /// worst-first — the flakiness hotspots single-run reports hide.
  flakyAssertions: Array<{ name: string; passRate: number }>;
  emptyTurns: number;
}

function aggregateByScenario(results: ScenarioResult[], heldOutIds: Set<string>): ScenarioAggregate[] {
  const byId = new Map<string, ScenarioResult[]>();
  for (const r of results) {
    const list = byId.get(r.id) ?? [];
    list.push(r);
    byId.set(r.id, list);
  }
  const agg: ScenarioAggregate[] = [];
  for (const [id, runs] of byId) {
    const pass = runs.filter((r) => r.status === 'pass').length;
    const fail = runs.filter((r) => r.status === 'fail').length;
    const error = runs.filter((r) => r.status === 'error').length;
    const tools = runs.map((r) => r.toolCallCount);
    const durs = runs.map((r) => r.durationMs / 1000);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    // Per-assertion-name pass rate across runs (names are stable strings).
    const assertStats = new Map<string, { pass: number; total: number }>();
    for (const r of runs) {
      for (const a of r.assertions) {
        const s = assertStats.get(a.name) ?? { pass: 0, total: 0 };
        s.total++;
        if (a.pass) s.pass++;
        assertStats.set(a.name, s);
      }
    }
    const flakyAssertions = [...assertStats.entries()]
      .filter(([, s]) => s.pass < s.total)
      .map(([name, s]) => ({ name, passRate: s.pass / s.total }))
      .sort((a, b) => a.passRate - b.passRate);
    agg.push({
      id,
      prompt: runs[0].prompt,
      heldOut: heldOutIds.has(id),
      runs: runs.length,
      passRate: pass / runs.length,
      statusSpread: { pass, fail, error },
      toolCalls: { mean: mean(tools), min: Math.min(...tools), max: Math.max(...tools) },
      durationS: { mean: mean(durs), min: Math.min(...durs), max: Math.max(...durs) },
      assertionsPassed: runs.reduce((a, r) => a + r.passed, 0),
      assertionsTotal: runs.reduce((a, r) => a + r.assertions.length, 0),
      flakyAssertions,
      emptyTurns: runs.filter((r) => (r as ScenarioResult & { emptyTurn?: boolean }).emptyTurn).length,
    });
  }
  return agg;
}

async function runScenario(sc: Scenario): Promise<ScenarioResult> {
  let canvas: CanvasDocument = sc.seed
    ? normalizeCanvas(sc.seed)
    : createEmptyCanvasDocument(`eval-${sc.id}`, `Eval ${sc.id}`);

  const traj: Trajectory = {
    toolCalls: [],
    errors: [],
    messageText: '',
    durationMs: 0,
  };
  // FIFO of started-but-not-yet-ended tool calls (tools run sequentially).
  const openCalls: number[] = [];

  const t0 = Date.now();
  let status: ScenarioResult['status'] = 'pass';
  let errorMessage: string | undefined;

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: canvas.id,
        prompt: sc.prompt,
        canvasState: canvas,
        settings: {
          temperature: DEFAULT_SETTINGS.temperature,
          maxIterations: DEFAULT_SETTINGS.maxIterations,
          planFirst: DEFAULT_SETTINGS.planFirst,
          thinkingLevel: EVAL_THINKING,
          defaultPalette: DEFAULT_SETTINGS.defaultPalette,
          skillSelectionMode: DEFAULT_SETTINGS.skillSelectionMode,
          llmProvider: EVAL_PROVIDER,
          modelName: EVAL_MODEL,
          ...(EVAL_CRITIQUES !== undefined ? { maxDesignCritiqueIterations: EVAL_CRITIQUES } : {}),
        },
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`API responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    // NDJSON parse loop with an overall timeout.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
    let streamDone = false;

    while (!streamDone) {
      if (Date.now() > deadline) throw new Error(`scenario timed out after ${SCENARIO_TIMEOUT_MS / 60000} min`);
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: { type: string; patch?: CanvasPatch; event?: SyncEvent };
        try {
          ev = JSON.parse(line);
        } catch {
          continue; // partial/corrupt line — skip
        }
        if (ev.type === 'patch' && ev.patch) {
          // Apply through the SAME code path the browser store uses.
          // applyPatchToCanvas is IMMUTABLE — keep the returned document.
          try {
            canvas = applyPatchToCanvas(canvas, ev.patch);
          } catch (e) {
            traj.errors.push(`patch apply failed: ${(e as Error).message}`);
          }
        } else if (ev.type === 'agent_event' && ev.event) {
          const e = ev.event;
          switch (e.type) {
            case 'agent:message_delta':
              traj.messageText += e.text;
              break;
            case 'agent:tool_call_start':
              openCalls.push(traj.toolCalls.length);
              traj.toolCalls.push({ name: e.toolName, success: true, summary: '', argsPreview: e.argsPreview });
              break;
            case 'agent:tool_call_end': {
              const idx = openCalls.shift();
              if (idx !== undefined) {
                traj.toolCalls[idx].success = e.success;
                traj.toolCalls[idx].summary = e.summary;
              }
              break;
            }
            case 'agent:error':
              traj.errors.push(e.message);
              break;
            case 'agent:turn_end':
              streamDone = true;
              break;
            default:
              break;
          }
        }
      }
    }
  } catch (e) {
    status = 'error';
    errorMessage = (e as Error).message;
  }

  traj.durationMs = Date.now() - t0;

  // Normalize the canvas so derived caches (shapes[]) reflect the .pen tree,
  // THEN run assertions against the normalized doc.
  canvas = normalizeCanvas(canvas);
  const finalCanvas = canvas;
  const assertions: AssertionResult[] =
    status === 'error'
      ? []
      : sc.assertions.map((fn) => {
          try {
            return fn(canvas, traj);
          } catch (err) {
            return { name: 'assertion crashed', pass: false, detail: (err as Error).message };
          }
        });
  const passed = assertions.filter((a) => a.pass).length;
  const failed = assertions.length - passed;
  if (status !== 'error' && failed > 0) status = 'fail';

  const counts = new Map<string, number>();
  for (const tc of traj.toolCalls) counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);

  // Empty-turn detection (rate-limit signature): zero tool calls AND zero
  // message text AND finished suspiciously fast. The runner now emits an
  // agent:error for this (surfaced in traj.errors); treat as retryable.
  const emptyTurn = traj.toolCalls.length === 0 && !traj.messageText.trim() && traj.durationMs < 10_000;

  const result: ScenarioResult = {
    id: sc.id,
    prompt: sc.prompt,
    startedAt: new Date(t0).toISOString(),
    durationMs: traj.durationMs,
    toolCallCount: traj.toolCalls.length,
    toolNames: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    assertions,
    passed,
    failed,
    status,
    errorMessage,
    finalLayerCount: finalCanvas.shapes.length,
  };
  (result as ScenarioResult & { emptyTurn?: boolean }).emptyTurn = emptyTurn;
  // Diagnostic: dump text layers for failed scenarios (copy-fidelity debugging).
  if (result.status !== 'pass') {
    result.textLayers = finalCanvas.shapes
      .filter((s) => s.type === 'text')
      .map((s) => ({ name: s.name, text: (s.text ?? '').slice(0, 80) }));
  }
  return result;
}

// ---- report -----------------------------------------------------------------

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---- rate-limit probe ---------------------------------------------------------
//
// The z.ai sandbox LLM endpoint locks for minutes once tripped (HTTP 429).
// Instead of burning scenarios against a locked endpoint, probe it with a
// 1-token completion (using the sandbox config at /etc/.z-ai-config when
// present) and only re-run when the probe succeeds.

interface ProbeConfig {
  baseUrl: string; apiKey: string; token?: string; userId?: string; chatId?: string;
}

function loadProbeConfig(): ProbeConfig | null {
  for (const p of ['/etc/.z-ai-config', `${process.env.HOME ?? ''}/.z-ai-config`]) {
    try {
      if (existsSync(p)) {
        const cfg = JSON.parse(readFileSync(p, 'utf8'));
        if (cfg.baseUrl) return cfg as ProbeConfig;
      }
    } catch { /* ignore */ }
  }
  return null;
}

async function probeLLM(cfg: ProbeConfig | null): Promise<boolean> {
  if (!cfg) return true; // can't probe outside sandbox — assume OK
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey ?? 'Z.ai'}`,
        ...(cfg.token ? { 'X-Token': cfg.token, 'X-User-Id': cfg.userId ?? '', 'X-Chat-Id': cfg.chatId ?? '', 'X-Z-AI-From': 'Z' } : {}),
      },
      body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'OK' }], max_tokens: 4, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/// Wait until the LLM endpoint answers a probe (or `maxWaitMs` elapses).
async function waitForLLM(maxWaitMs = 12 * 60 * 1000): Promise<boolean> {
  const cfg = loadProbeConfig();
  if (!cfg) return true;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await probeLLM(cfg)) {
      // small settle delay: the bucket may refill gradually
      await new Promise((r) => setTimeout(r, 3000));
      return true;
    }
    console.log('  … LLM endpoint still rate-limited, waiting 45s');
    await new Promise((r) => setTimeout(r, 45_000));
  }
  return false;
}

function renderMarkdown(results: ScenarioResult[], aggregate?: ScenarioAggregate[]): string {
  const total = results.reduce((a, r) => a + r.assertions.length, 0);
  const passed = results.reduce((a, r) => a + r.passed, 0);
  const lines: string[] = [];
  const aggById = new Map((aggregate ?? []).map((a) => [a.id, a] as const));
  lines.push(`# Agent Eval Report`, ``);
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Scenarios: ${results.length} (${results.filter((r) => r.status === 'pass').length} pass / ${results.filter((r) => r.status === 'fail').length} fail / ${results.filter((r) => r.status === 'error').length} error)`);
  if (REPEATS > 1) lines.push(`- Repeats per scenario: ${REPEATS} (results below are per-run; see the Variance table)`);
  lines.push(`- Assertions: ${passed}/${total} passed`);
  lines.push('');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '💥';
    const runLabel = REPEATS > 1 ? ` (run ${r.repeat ?? 1}/${REPEATS})` : '';
    const heldOutLabel = aggById.get(r.id)?.heldOut ? ' · [HELD-OUT]' : '';
    lines.push(`## ${icon} ${r.id}${runLabel} — ${r.status.toUpperCase()}${heldOutLabel}`);
    lines.push('');
    lines.push(`> **Prompt:** ${r.prompt}`);
    lines.push('');
    const topTools = r.toolNames.slice(0, 6).map(([n, c]) => `${n}x${c}`).join(', ') || '—';
    lines.push(`${r.toolCallCount} tool calls · ${(r.durationMs / 1000).toFixed(0)}s · ${r.finalLayerCount} layers · top tools: ${topTools}`);
    lines.push('');
    if (r.errorMessage) lines.push(`**ERROR:** ${r.errorMessage}`, '');
    for (const a of r.assertions) {
      lines.push(`- ${a.pass ? '✅' : '❌'} **${a.name}** — ${a.detail}`);
    }
    lines.push('');
  }
  // Variance roll-up — the point of --repeats. Single-run pass/fail hides
  // non-determinism; this table makes it the headline.
  if (aggregate && aggregate.length > 0) {
    lines.push(`## Variance (${REPEATS} run${REPEATS === 1 ? '' : 's'} per scenario)`, '');
    lines.push(`| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const a of aggregate) {
      const flaky = a.flakyAssertions.length === 0
        ? '—'
        : a.flakyAssertions.slice(0, 4).map((f) => `${f.name} ${(f.passRate * 100).toFixed(0)}%`).join('; ');
      lines.push(
        `| ${a.id}${a.heldOut ? ' *(held-out)*' : ''} | ${(a.passRate * 100).toFixed(0)}% (${a.statusSpread.pass}/${a.runs}) ` +
        `| ${a.toolCalls.mean.toFixed(1)}/${a.toolCalls.min}/${a.toolCalls.max} ` +
        `| ${a.durationS.mean.toFixed(0)}/${a.durationS.min.toFixed(0)}/${a.durationS.max.toFixed(0)} ` +
        `| ${a.assertionsPassed}/${a.assertionsTotal} | ${flaky} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---- main -------------------------------------------------------------------

async function main() {
  // Scenario selection. --only wins over the held-out gate (explicit ids are
  // deliberate). Without --only: held-out scenarios are EXCLUDED unless
  // --include-heldout — the teaching-to-the-test firewall (dev iteration
  // must never converge on the generalization set).
  const devCount = SCENARIOS.filter((s) => !s.heldOut).length;
  const heldOutCount = SCENARIOS.length - devCount;
  let list: Scenario[];
  if (ONLY) {
    list = SCENARIOS.filter((s) => ONLY.includes(s.id));
  } else {
    list = INCLUDE_HELDOUT ? SCENARIOS : SCENARIOS.filter((s) => !s.heldOut);
  }
  if (list.length === 0) {
    console.error(`No scenarios matched. Available: dev (${devCount}) — ${SCENARIOS.filter((s) => !s.heldOut).map((s) => s.id).join(', ')}; held-out (${heldOutCount}, need --include-heldout) — ${SCENARIOS.filter((s) => s.heldOut).map((s) => s.id).join(', ')}`);
    process.exit(2);
  }
  const heldOutIds = new Set(SCENARIOS.filter((s) => s.heldOut).map((s) => s.id));
  const heldOutRunning = list.filter((s) => s.heldOut).length;
  console.log(`Running ${list.length} scenario(s) × ${REPEATS} run(s) against ${API} (delay ${DELAY_S}s)${heldOutRunning > 0 ? ` — INCLUDING ${heldOutRunning} held-out (final-validation mode)` : ' — dev set only (held-out excluded)'} …\n`);
  // Gate the whole suite on endpoint availability — avoids burning the first
  // scenario against a still-locked endpoint.
  await waitForLLM();
  const results: ScenarioResult[] = [];
  for (let i = 0; i < list.length; i++) {
    const sc = list[i];
    for (let rep = 1; rep <= REPEATS; rep++) {
      if (!(i === 0 && rep === 1) && DELAY_S > 0) {
        console.log(`  … cooldown ${DELAY_S}s (rate-limit guard)`);
        await new Promise((r) => setTimeout(r, DELAY_S * 1000));
      }
      console.log(`▶ ${sc.id}${REPEATS > 1 ? ` [run ${rep}/${REPEATS}]` : ''}${sc.heldOut ? ' [held-out]' : ''} — "${sc.prompt.slice(0, 70)}…"`);
      let r = await runScenario(sc);
      r.repeat = rep;
      // Retry when the turn came back empty (429 rate-limit signature): wait
      // for the endpoint to actually answer a probe, then re-run (max 2 retries).
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!(r as ScenarioResult & { emptyTurn?: boolean }).emptyTurn) break;
        console.log(`  ⚠ empty turn (likely 429 rate limit) — waiting for endpoint recovery, retry ${attempt + 1}/2 …`);
        if (!(await waitForLLM())) {
          console.log('  ✗ endpoint did not recover within wait window — giving up on retry');
          break;
        }
        r = await runScenario(sc);
        r.repeat = rep;
        if (!(r as ScenarioResult & { emptyTurn?: boolean }).emptyTurn) {
          console.log('  ✓ retry produced output');
        }
      }
      results.push(r);
      const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '💥';
      console.log(`  ${icon} ${r.passed}/${r.assertions.length} assertions · ${r.toolCallCount} tools · ${(r.durationMs / 1000).toFixed(0)}s`);
      for (const a of r.assertions.filter((a) => !a.pass)) console.log(`     FAIL ${a.name}: ${a.detail.slice(0, 140)}`);
      console.log('');
    }
  }

  const aggregate = aggregateByScenario(results, heldOutIds);
  const outJson = join(__dirname, OUT.endsWith('.json') ? OUT : `${OUT}.json`);
  const outMd = join(__dirname, OUT.endsWith('.json') ? OUT.replace(/\.json$/, '.md') : `${OUT}.md`);
  mkdirSync(dirname(outJson), { recursive: true });
  // JSON shape: { runs, aggregate } — the flat per-run array (formerly the
  // whole file) stays available at .runs; .aggregate carries the variance
  // roll-up (present even with REPEATS=1 so consumers can rely on one shape).
  writeFileSync(outJson, JSON.stringify({ runs: results, aggregate }, null, 2));
  writeFileSync(outMd, renderMarkdown(results, aggregate));

  // Exit semantics under repeats: a scenario "passes" only when EVERY run
  // passed. Strict on purpose — flaky is not green.
  const failedScenarios = aggregate.filter((a) => a.passRate < 1).length;
  console.log('──────────────────────────────────────────────');
  console.log(`RESULT: ${aggregate.length - failedScenarios}/${aggregate.length} scenarios fully passed (${results.length} total runs)`);
  if (REPEATS > 1 || heldOutRunning > 0) {
    for (const a of aggregate) {
      const flag = a.passRate === 1 ? '✅' : a.passRate > 0 ? '⚠️ ' : '❌';
      console.log(`  ${flag} ${a.id}${a.heldOut ? ' [held-out]' : ''}: ${(a.passRate * 100).toFixed(0)}% pass (${a.toolCalls.min}-${a.toolCalls.max} tools, ${a.durationS.min.toFixed(0)}-${a.durationS.max.toFixed(0)}s)`);
    }
  }
  console.log(`Reports: ${outMd}`);
  console.log(`         ${outJson}`);
  process.exit(failedScenarios > 0 ? 1 : 0);
}

main();
