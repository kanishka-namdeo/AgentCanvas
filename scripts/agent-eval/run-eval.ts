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
//
// Requires the dev server on :3000 (bash scripts/start-dev.sh).

import { applyPatchToCanvas } from '../../src/lib/canvas/patch';
import { normalizeCanvas } from '../../src/lib/agent/runner-legacy';
import { createEmptyCanvasDocument } from '../../src/lib/canvas/types';
import type { CanvasDocument, CanvasPatch, SyncEvent } from '../../src/lib/canvas/types';
import { DEFAULT_SETTINGS } from '../../src/lib/settings/types';
import { SCENARIOS, type Scenario, type Trajectory, type AssertionResult } from './scenarios';

const API = process.env.EVAL_API ?? 'http://localhost:3000/api/agent';

// ---- CLI args ---------------------------------------------------------------

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const outArg = args.find((a) => a.startsWith('--out='));
const delayArg = args.find((a) => a.startsWith('--delay='));
const ONLY = onlyArg ? onlyArg.split('=').slice(1).join('=').split(',') : null;
const OUT = outArg ? outArg.split('=')[1] : 'results/eval';
/// Cooldown between scenarios (seconds). The sandbox LLM endpoint rate-limits
/// (HTTP 429) when heavy agent turns run back-to-back; spacing them out keeps
/// the eval measuring AGENT quality, not quota exhaustion.
const DELAY_S = delayArg ? Number(delayArg.split('=')[1]) : 20;
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
  /// Diagnostic dump: every text layer's content (only recorded when the
  /// scenario FAILS, to keep reports small). Makes copy-fidelity failures
  /// debuggable without re-running.
  textLayers?: Array<{ name: string; text: string }>;
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
          thinkingLevel: DEFAULT_SETTINGS.thinkingLevel,
          defaultPalette: DEFAULT_SETTINGS.defaultPalette,
          skillSelectionMode: DEFAULT_SETTINGS.skillSelectionMode,
          llmProvider: DEFAULT_SETTINGS.llmProvider,
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

function renderMarkdown(results: ScenarioResult[]): string {
  const total = results.reduce((a, r) => a + r.assertions.length, 0);
  const passed = results.reduce((a, r) => a + r.passed, 0);
  const lines: string[] = [];
  lines.push(`# Agent Eval Report`, ``);
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Scenarios: ${results.length} (${results.filter((r) => r.status === 'pass').length} pass / ${results.filter((r) => r.status === 'fail').length} fail / ${results.filter((r) => r.status === 'error').length} error)`);
  lines.push(`- Assertions: ${passed}/${total} passed`);
  lines.push('');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '💥';
    lines.push(`## ${icon} ${r.id} — ${r.status.toUpperCase()}`);
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
  return lines.join('\n');
}

// ---- main -------------------------------------------------------------------

async function main() {
  const list = ONLY ? SCENARIOS.filter((s) => ONLY.includes(s.id)) : SCENARIOS;
  if (list.length === 0) {
    console.error(`No scenarios matched --only=${ONLY}. Available: ${SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exit(2);
  }
  console.log(`Running ${list.length} scenario(s) against ${API} (delay ${DELAY_S}s) …\n`);
  // Gate the whole suite on endpoint availability — avoids burning the first
  // scenario against a still-locked endpoint.
  await waitForLLM();
  const results: ScenarioResult[] = [];
  for (let i = 0; i < list.length; i++) {
    const sc = list[i];
    if (i > 0 && DELAY_S > 0) {
      console.log(`  … cooldown ${DELAY_S}s (rate-limit guard)`);
      await new Promise((r) => setTimeout(r, DELAY_S * 1000));
    }
    console.log(`▶ ${sc.id} — "${sc.prompt.slice(0, 70)}…"`);
    let r = await runScenario(sc);
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

  const outJson = join(__dirname, OUT.endsWith('.json') ? OUT : `${OUT}.json`);
  const outMd = join(__dirname, OUT.endsWith('.json') ? OUT.replace(/\.json$/, '.md') : `${OUT}.md`);
  mkdirSync(dirname(outJson), { recursive: true });
  writeFileSync(outJson, JSON.stringify(results, null, 2));
  writeFileSync(outMd, renderMarkdown(results));

  const failedScenarios = results.filter((r) => r.status !== 'pass').length;
  console.log('──────────────────────────────────────────────');
  console.log(`RESULT: ${results.length - failedScenarios}/${results.length} scenarios fully passed`);
  console.log(`Reports: ${outMd}`);
  console.log(`         ${outJson}`);
  process.exit(failedScenarios > 0 ? 1 : 0);
}

main();
