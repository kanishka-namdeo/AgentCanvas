// run-multishot.ts — Multi-shot (multi-turn) eval harness for the AgentCanvas agent.
//
// The single-shot harness (run-eval.ts) measures one prompt → one canvas. Real
// design work is ITERATIVE: the user inspects, then asks for refinements that
// must apply to the CURRENT canvas state. This harness exercises exactly that:
//
// For each scenario (a sequence of turns):
//   1. Start from an empty canvas with a STABLE documentId
//   2. For each turn i: POST the prompt to the REAL /api/agent route with
//      canvasState = the canvas as it stands after turn i-1 (patches chain)
//   3. Consume the NDJSON stream, applying every canvas patch via the app's
//      own applyPatchToCanvas (same path the browser store uses)
//   4. Snapshot the canvas after each turn (deep copy) + keep the trajectory
//   5. Run the scenario's assertions over MultiShotCtx { final, perTurn }
//   6. Emit a per-scenario + summary report (JSON + markdown, with a PER-TURN
//      table) and dump the final canvas doc per scenario for post-mortems
//
// Usage:
//   bun scripts/agent-eval/run-multishot.ts [--only=id1,id2] [--out=results/multishot]
//                                           [--delay=S]
//
// --only=id1,id2   run only the listed scenarios
// --out=DIR|PREFIX where reports go (default results/multishot-eval). Writes
//                  <out>.json + <out>.md (combined) plus per-scenario
//                  <id>.json, <id>.md and <id>-final-canvas.json next to them.
// --delay=S        cooldown (seconds) that OVERRIDES both the between-turn
//                  delay (default 15s) and the between-scenario delay
//                  (default 20s). Rate-limit guard — the sandbox LLM endpoint
//                  locks for minutes once tripped.
//
// Requires the dev server on :3000 (bash scripts/start-dev.sh).
// Exits 1 when any scenario fails.

import { applyPatchToCanvas } from '../../src/lib/canvas/patch';
import { normalizeCanvas } from '../../src/lib/agent/runner-legacy';
import { createEmptyCanvasDocument } from '../../src/lib/canvas/types';
import type { CanvasDocument, CanvasPatch, SyncEvent, Layer } from '../../src/lib/canvas/types';
import { DEFAULT_SETTINGS } from '../../src/lib/settings/types';
import type { Trajectory, AssertionResult } from './scenarios';

const API = process.env.EVAL_API ?? 'http://localhost:3000/api/agent';

// Provider/model/thinking overrides for reproducible A/B runs (same env vars
// as run-eval.ts — see download/prompt-tuning/). Defaults keep production.
const EVAL_PROVIDER = process.env.EVAL_PROVIDER ?? DEFAULT_SETTINGS.llmProvider;
const EVAL_MODEL = process.env.EVAL_MODEL ?? DEFAULT_SETTINGS.modelName;
const EVAL_THINKING = process.env.EVAL_THINKING ?? DEFAULT_SETTINGS.thinkingLevel;
const EVAL_CRITIQUES = process.env.EVAL_CRITIQUES !== undefined ? Number(process.env.EVAL_CRITIQUES) : undefined;

// ---- CLI args ---------------------------------------------------------------

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const outArg = args.find((a) => a.startsWith('--out='));
const delayArg = args.find((a) => a.startsWith('--delay='));

const ONLY = onlyArg ? onlyArg.split('=').slice(1).join('=').split(',') : null;
const OUT = outArg ? outArg.split('=')[1] : 'results/multishot-eval';

/// 8 minutes per TURN (LLM + tools + retries). Multi-turn scenarios are long;
/// a single turn that legitimately redesigns a page can take several minutes.
const TURN_TIMEOUT_MS = 8 * 60 * 1000;
/// Cooldown between turns / between scenarios (seconds→ms). --delay=S
/// overrides BOTH. Spacing turns out keeps the eval measuring AGENT quality,
/// not quota exhaustion (the sandbox endpoint rate-limits on back-to-back
/// heavy turns).
const DEFAULT_TURN_DELAY_MS = 15 * 1000;
const DEFAULT_SCENARIO_DELAY_MS = 20 * 1000;
const DELAY_S = delayArg ? Number(delayArg.split('=')[1]) : null;
const TURN_DELAY_MS =
  DELAY_S !== null && Number.isFinite(DELAY_S) ? DELAY_S * 1000 : DEFAULT_TURN_DELAY_MS;
const SCENARIO_DELAY_MS =
  DELAY_S !== null && Number.isFinite(DELAY_S) ? DELAY_S * 1000 : DEFAULT_SCENARIO_DELAY_MS;

// ---- types ------------------------------------------------------------------

export interface Turn {
  prompt: string;
}

/// Everything a multi-shot assertion sees: the final canvas plus, per turn,
/// the agent's trajectory and a deep-copied snapshot of the canvas AFTER that
/// turn's patches were applied.
export interface MultiShotCtx {
  final: CanvasDocument;
  perTurn: Array<{ trajectory: Trajectory; canvasAfter: CanvasDocument }>;
}

export interface MultiShotScenario {
  id: string;
  /// What this scenario exercises (shown in reports).
  description: string;
  /// Sequential prompts — turn i+1 sees the canvas left by turn i.
  turns: Turn[];
  /// Assertions receive the final canvas, per-turn trajectories and per-turn
  /// canvas snapshots.
  assertions: Array<(ctx: MultiShotCtx) => AssertionResult>;
}

interface TurnResult {
  index: number; // 1-based
  prompt: string;
  durationMs: number;
  toolCallCount: number;
  toolNames: Array<[string, number]>;
  errors: string[];
  patches: number;
  retries: number;
  emptyTurn: boolean;
}

interface MultiShotScenarioResult {
  id: string;
  description: string;
  startedAt: string;
  durationMs: number;
  turns: TurnResult[];
  toolCallCount: number;
  assertions: AssertionResult[];
  passed: number;
  failed: number;
  status: 'pass' | 'fail' | 'error';
  errorMessage?: string;
  finalLayerCount: number;
  /// Diagnostic dump of every text layer (failed scenarios only) — makes
  /// copy-fidelity failures debuggable without re-running.
  textLayers?: Array<{ name: string; text: string }>;
}

// ---- assertion helpers (mirroring scenarios.ts) ------------------------------
//
// Copied locally rather than imported: scenarios.ts keeps these private, and
// the multi-shot file must stay self-contained for copy-paste iteration.

const layers = (c: CanvasDocument) => c.shapes ?? [];
const visible = (c: CanvasDocument) => layers(c).filter((l) => l.visible !== false);
const ofTypes = (c: CanvasDocument, types: string[]) => visible(c).filter((l) => types.includes(l.type));
const texts = (c: CanvasDocument) => ofTypes(c, ['text']);
const textContent = (c: CanvasDocument) => texts(c).map((t) => t.text ?? '').join(' \n ');

const ok = (name: string, detail: string): AssertionResult => ({ name, pass: true, detail });
const fail = (name: string, detail: string): AssertionResult => ({ name, pass: false, detail });

function assert(name: string, cond: boolean, passDetail: string, failDetail: string): AssertionResult {
  return cond ? ok(name, passDetail) : fail(name, failDetail);
}

/// Normalize whitespace so "Growth  Metrics" == "Growth Metrics".
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/// True when some text layer contains `value` as a standalone number (not a
/// substring of a longer number) or as a $-prefixed price. "9" matches "$9"
/// and "9/month" but NOT "29" or "99".
function hasStandaloneNumber(c: CanvasDocument, value: string): boolean {
  const v = escapeRe(value);
  const standalone = new RegExp(`(?:^|[^0-9])${v}(?:[^0-9]|$)`);
  const dollar = new RegExp(`\\$\\s*${v}(?:[^0-9]|$)`);
  return texts(c).some((t) => {
    const s = t.text ?? '';
    return standalone.test(s) || dollar.test(s);
  });
}

const hasTextContaining = (c: CanvasDocument, sub: string) =>
  texts(c).some((t) => (t.text ?? '').toLowerCase().includes(sub.toLowerCase()));

/// Saturated (non-gray) fill — used to detect accent-colored cards/badges.
/// Parses #rgb / #rrggbb / #rrggbbaa; anything unparseable is conservatively
/// treated as NOT an accent.
function isColorful(fill: string | null | undefined): boolean {
  if (!fill || fill === 'none' || fill === 'transparent') return false;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(fill.trim());
  if (!m) return false;
  let hex = m[1];
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  return sat >= 24 && Math.max(r, g, b) >= 90;
}

/// Card-like containers: frames/rects/components in plausible card proportions.
function cardLike(c: CanvasDocument, minH = 60): Layer[] {
  return ofTypes(c, ['frame', 'rectangle', 'component']).filter(
    (l) => l.width >= 100 && l.width <= 800 && l.height >= minH && l.height <= 1200,
  );
}

/// A shadow that actually renders something (defensive — JSON data may carry
/// zeroed effects).
function hasActiveShadow(l: Layer): boolean {
  const s = l.shadow;
  if (!s) return false;
  const blur = typeof s.blur === 'number' ? s.blur : 0;
  const spread = typeof s.spread === 'number' ? s.spread : 0;
  const x = typeof s.x === 'number' ? s.x : 0;
  const y = typeof s.y === 'number' ? s.y : 0;
  return blur > 0 || spread > 0 || x !== 0 || y !== 0;
}

function centerDist(l: Layer, x: number, y: number): number {
  const dx = l.x + l.width / 2 - x;
  const dy = l.y + l.height / 2 - y;
  return Math.sqrt(dx * dx + dy * dy);
}

/// Regression check between two canvas snapshots: every text layer present in
/// `before` (by trimmed text content, or by trimmed layer name with
/// { byName: true }) must still exist in `after`. Returns the missing keys —
/// callers decide how strict to be (full preservation vs. filtered subsets).
function noRegression(
  before: CanvasDocument,
  after: CanvasDocument,
  opts: { byName?: boolean } = {},
): { missing: string[] } {
  const key = (l: Layer) => (opts.byName ? (l.name ?? '').trim() : (l.text ?? '').trim());
  const src = opts.byName ? layers(before) : texts(before);
  const dst = opts.byName ? layers(after) : texts(after);
  const afterKeys = dst.map(key);
  const missing: string[] = [];
  const seen: string[] = [];
  for (const l of src) {
    const k = key(l);
    if (!k || seen.indexOf(k) >= 0) continue; // skip empties + dedupe
    seen.push(k);
    if (afterKeys.indexOf(k) < 0) missing.push(k);
  }
  return { missing };
}

// ---- shared trajectory checks (run per TURN, reported per scenario) ----------

/// No failed tool calls in ANY turn.
function noFailedToolCallsAllTurns(): (ctx: MultiShotCtx) => AssertionResult {
  return (ctx) => {
    const failed: string[] = [];
    for (let i = 0; i < ctx.perTurn.length; i++) {
      for (const tc of ctx.perTurn[i].trajectory.toolCalls) {
        // Task 7-b: 200 chars — 60 cut validation errors right after the bullet
        // dash, making the message look empty in reports.
        if (!tc.success) failed.push(`T${i + 1} ${tc.name} (${(tc.summary || '').slice(0, 200)})`);
      }
    }
    const total = ctx.perTurn.reduce((a, p) => a + p.trajectory.toolCalls.length, 0);
    return assert(
      'no failed tool calls (all turns)',
      failed.length === 0,
      `all ${total} tool call(s) across ${ctx.perTurn.length} turn(s) succeeded`,
      `${failed.length} failed: ${failed.slice(0, 6).join('; ')}`,
    );
  };
}

/// No agent-level errors (LLM request failures, patch apply failures, …) in
/// any turn.
function noAgentErrorsAllTurns(): (ctx: MultiShotCtx) => AssertionResult {
  return (ctx) => {
    const errs: string[] = [];
    for (let i = 0; i < ctx.perTurn.length; i++) {
      for (const e of ctx.perTurn[i].trajectory.errors) errs.push(`T${i + 1}: ${e.slice(0, 90)}`);
    }
    return assert(
      'no agent errors (all turns)',
      errs.length === 0,
      `${ctx.perTurn.length} turn(s), no errors`,
      errs.length ? errs.slice(0, 5).join(' | ') : '',
    );
  };
}

/// No duplicate back-to-back tool calls within a turn (name AND argsPreview
/// identical) — the classic stuck-in-a-loop signature.
function noDuplicateConsecutiveCallsPerTurn(): (ctx: MultiShotCtx) => AssertionResult {
  return (ctx) => {
    const dupes: string[] = [];
    for (let i = 0; i < ctx.perTurn.length; i++) {
      const calls = ctx.perTurn[i].trajectory.toolCalls;
      for (let j = 1; j < calls.length; j++) {
        if (calls[j].name === calls[j - 1].name && calls[j].argsPreview === calls[j - 1].argsPreview) {
          dupes.push(`T${i + 1}: ${calls[j].name} x2 (args: ${(calls[j].argsPreview || '').slice(0, 40)})`);
        }
      }
    }
    const total = ctx.perTurn.reduce((a, p) => a + p.trajectory.toolCalls.length, 0);
    return assert(
      'no duplicate consecutive tool calls (per turn)',
      dupes.length === 0,
      `${total} call(s), no back-to-back repeats`,
      dupes.slice(0, 5).join('; '),
    );
  };
}

// ---- rate-limit probe (copied from run-eval.ts) -------------------------------
//
// The z.ai sandbox LLM endpoint locks for minutes once tripped (HTTP 429).
// Probe it with a 1-token completion (sandbox config at /etc/.z-ai-config when
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

// ---- run one turn -------------------------------------------------------------

interface TurnRun {
  canvas: CanvasDocument; // normalized canvas AFTER the turn
  traj: Trajectory;
  patches: number; // canvas patches successfully applied
  emptyTurn: boolean; // 429 signature: no tools, no text, finished fast
  error?: string; // transport/timeout error — the turn did NOT complete
}

async function runTurn(documentId: string, prompt: string, canvasIn: CanvasDocument): Promise<TurnRun> {
  let canvas = canvasIn;
  const traj: Trajectory = { toolCalls: [], errors: [], messageText: '', durationMs: 0 };
  // FIFO of started-but-not-yet-ended tool calls (tools run sequentially).
  const openCalls: number[] = [];
  let patches = 0;
  const t0 = Date.now();
  let error: string | undefined;

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Hard abort past the deadline + slack so a hung stream can never stall
      // the whole suite (run-eval.ts only checks the deadline between reads).
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS + 60_000),
      body: JSON.stringify({
        documentId,
        prompt,
        canvasState: canvasIn,
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

    // NDJSON parse loop with an overall per-turn timeout (same shape as
    // run-eval.ts).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let streamDone = false;

    while (!streamDone) {
      if (Date.now() > deadline) throw new Error(`turn timed out after ${TURN_TIMEOUT_MS / 60000} min`);
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
            patches++;
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
    error = (e as Error).message;
  }

  traj.durationMs = Date.now() - t0;

  // Normalize so the derived shapes[] cache reflects the .pen tree — the
  // assertions must see the resolved render layers (same as run-eval.ts).
  canvas = normalizeCanvas(canvas);

  // Empty-turn detection (rate-limit signature): zero tool calls AND zero
  // message text AND finished suspiciously fast. Retryable.
  const emptyTurn =
    traj.toolCalls.length === 0 && !traj.messageText.trim() && traj.durationMs < 10_000 && !error;

  return { canvas, traj, patches, emptyTurn, error };
}

// ---- run one multi-shot scenario ------------------------------------------------

function tally(names: string[]): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const n of names) {
    const hit = out.find((p) => p[0] === n);
    if (hit) hit[1]++;
    else out.push([n, 1]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}

async function runMultiShotScenario(
  sc: MultiShotScenario,
): Promise<{ result: MultiShotScenarioResult; finalCanvas: CanvasDocument }> {
  const t0 = Date.now();
  // Empty canvas with a STABLE documentId — every turn of the scenario hits
  // the same doc; the canvas STATE is what chains (we resend the live canvas,
  // the server-side doc is only the persistence target).
  const seed = createEmptyCanvasDocument(`ms-eval-${sc.id}`, `MultiShot Eval ${sc.id}`);
  const documentId = seed.id;
  let canvas: CanvasDocument = seed;

  const perTurn: Array<{ trajectory: Trajectory; canvasAfter: CanvasDocument }> = [];
  const turnResults: TurnResult[] = [];
  let errorMessage: string | undefined;

  for (let i = 0; i < sc.turns.length; i++) {
    if (i > 0 && TURN_DELAY_MS > 0) {
      console.log(`  … turn cooldown ${TURN_DELAY_MS / 1000}s (rate-limit guard)`);
      await new Promise((r) => setTimeout(r, TURN_DELAY_MS));
    }
    console.log(`  ▶ turn ${i + 1}/${sc.turns.length} — "${sc.turns[i].prompt.slice(0, 70)}…"`);

    let run = await runTurn(documentId, sc.turns[i].prompt, canvas);
    let retries = 0;
    // Retry when the turn came back empty (429 rate-limit signature): wait for
    // the endpoint to answer a probe, then re-run (max 2 retries). The canvas
    // state is unchanged by an empty turn, so we resend the same state.
    for (let attempt = 0; attempt < 2 && run.emptyTurn; attempt++) {
      console.log(`  ⚠ empty turn (likely 429 rate limit) — waiting for endpoint recovery, retry ${attempt + 1}/2 …`);
      if (!(await waitForLLM())) {
        console.log('  ✗ endpoint did not recover within wait window — giving up on retry');
        break;
      }
      run = await runTurn(documentId, sc.turns[i].prompt, canvas);
      retries++;
      if (!run.emptyTurn) console.log('  ✓ retry produced output');
    }

    if (!run.error) {
      canvas = run.canvas;
      // Deep copy the snapshot so later turns can't mutate turn i's evidence.
      perTurn.push({ trajectory: run.traj, canvasAfter: structuredClone(run.canvas) });
    } else {
      errorMessage = `turn ${i + 1} failed: ${run.error}`;
    }
    turnResults.push({
      index: i + 1,
      prompt: sc.turns[i].prompt,
      durationMs: run.traj.durationMs,
      toolCallCount: run.traj.toolCalls.length,
      toolNames: tally(run.traj.toolCalls.map((tc) => tc.name)),
      errors: run.error ? run.traj.errors.slice().concat([run.error]) : run.traj.errors.slice(),
      patches: run.patches,
      retries,
      emptyTurn: run.emptyTurn,
    });
    console.log(
      `    ${run.traj.toolCalls.length} tools · ${run.patches} patches · ${(run.traj.durationMs / 1000).toFixed(0)}s` +
        `${run.traj.errors.length ? ` · ${run.traj.errors.length} error(s)` : ''}${run.error ? ' · TURN FAILED' : ''}`,
    );
    if (errorMessage) break; // a broken turn invalidates everything after it
  }

  const finalCanvas = canvas;
  let status: MultiShotScenarioResult['status'] = errorMessage ? 'error' : 'pass';
  const ctx: MultiShotCtx = { final: finalCanvas, perTurn };
  const assertions: AssertionResult[] = errorMessage
    ? []
    : sc.assertions.map((fn) => {
        try {
          return fn(ctx);
        } catch (err) {
          return { name: 'assertion crashed', pass: false, detail: (err as Error).message };
        }
      });
  const passed = assertions.filter((a) => a.pass).length;
  const failed = assertions.length - passed;
  if (status !== 'error' && failed > 0) status = 'fail';

  const result: MultiShotScenarioResult = {
    id: sc.id,
    description: sc.description,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    turns: turnResults,
    toolCallCount: turnResults.reduce((a, t) => a + t.toolCallCount, 0),
    assertions,
    passed,
    failed,
    status,
    errorMessage,
    finalLayerCount: finalCanvas.shapes?.length ?? 0,
  };
  if (result.status !== 'pass') {
    result.textLayers = (finalCanvas.shapes ?? [])
      .filter((s) => s.type === 'text')
      .map((s) => ({ name: s.name, text: (s.text ?? '').slice(0, 80) }));
  }
  return { result, finalCanvas };
}

// ---- report -------------------------------------------------------------------

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function renderScenarioSection(r: MultiShotScenarioResult): string[] {
  const lines: string[] = [];
  const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '💥';
  lines.push(`## ${icon} ${r.id} — ${r.status.toUpperCase()}`);
  lines.push('');
  lines.push(`> ${r.description}`);
  lines.push('');
  lines.push(
    `${r.turns.length} turn(s) · ${r.toolCallCount} tool calls · ${(r.durationMs / 1000).toFixed(0)}s · ` +
      `${r.finalLayerCount} layers · assertions ${r.passed}/${r.assertions.length}`,
  );
  lines.push('');
  lines.push(`| turn | prompt | tools | duration | errors |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const t of r.turns) {
    const excerpt = t.prompt.replace(/\|/g, '\\|').slice(0, 60) + (t.prompt.length > 60 ? '…' : '');
    lines.push(`| ${t.index} | ${excerpt} | ${t.toolCallCount} | ${(t.durationMs / 1000).toFixed(0)}s | ${t.errors.length} |`);
  }
  lines.push('');
  const patches = r.turns.reduce((a, t) => a + t.patches, 0);
  const retries = r.turns.reduce((a, t) => a + t.retries, 0);
  const topTools = r.turns
    .reduce<Array<[string, number]>>((acc, t) => {
      for (const [n, c] of t.toolNames) {
        const hit = acc.find((p) => p[0] === n);
        if (hit) hit[1] += c;
        else acc.push([n, c]);
      }
      return acc;
    }, [])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([n, c]) => `${n}x${c}`)
    .join(', ');
  lines.push(`${patches} canvas patch(es) applied${retries > 0 ? ` · ${retries} empty-turn retry/retries` : ''}${topTools ? ` · top tools: ${topTools}` : ''}`);
  lines.push('');
  if (r.errorMessage) lines.push(`**ERROR:** ${r.errorMessage}`, '');
  for (const a of r.assertions) {
    lines.push(`- ${a.pass ? '✅' : '❌'} **${a.name}** — ${a.detail}`);
  }
  lines.push('');
  return lines;
}

function renderMarkdown(results: MultiShotScenarioResult[]): string {
  const total = results.reduce((a, r) => a + r.assertions.length, 0);
  const passed = results.reduce((a, r) => a + r.passed, 0);
  const turns = results.reduce((a, r) => a + r.turns.length, 0);
  const lines: string[] = [];
  lines.push(`# Multi-Shot Agent Eval Report`, ``);
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Provider/model: ${EVAL_PROVIDER} / ${EVAL_MODEL} (thinking: ${EVAL_THINKING})`);
  lines.push(`- API: ${API}`);
  lines.push(
    `- Scenarios: ${results.length} (${results.filter((r) => r.status === 'pass').length} pass / ` +
      `${results.filter((r) => r.status === 'fail').length} fail / ${results.filter((r) => r.status === 'error').length} error) · turns: ${turns}`,
  );
  lines.push(`- Assertions: ${passed}/${total} passed`);
  lines.push('');
  for (const r of results) lines.push(...renderScenarioSection(r));
  return lines.join('\n');
}

// ---- scenarios ------------------------------------------------------------------

export const MULTISHOT_SCENARIOS: MultiShotScenario[] = [
  // 1. Iterative refinement + visual emphasis editing.
  {
    id: 'ms-pricing-iterate',
    description:
      'Iterative refinement: build a 3-tier pricing page, visually emphasize the Pro tier, then add a billing ' +
      'toggle. Exercises multi-turn canvas chaining, emphasis editing of an existing region, and additive edits ' +
      'without regressing earlier content.',
    turns: [
      {
        prompt:
          "Design a pricing page for a SaaS called 'Flowly' with 3 tiers: Starter $9/month, Pro $29/month, Enterprise $99/month. Include feature lists and CTA buttons for each tier.",
      },
      { prompt: 'Make the Pro tier visually highlighted as the most popular option.' },
      { prompt: 'Add a monthly/yearly billing toggle at the top of the page.' },
    ],
    assertions: [
      // (a) T1 created 3 card-like containers + 3 distinct price texts.
      (ctx) => {
        const after1 = ctx.perTurn[0]?.canvasAfter;
        if (!after1) return fail('T1: 3 pricing cards with 9/29/99', 'turn 1 snapshot missing');
        const cards = cardLike(after1, 120);
        const p9 = hasStandaloneNumber(after1, '9');
        const p29 = hasStandaloneNumber(after1, '29');
        const p99 = hasStandaloneNumber(after1, '99');
        return assert(
          'T1: 3 card containers with $9/$29/$99 price texts',
          cards.length >= 3 && p9 && p29 && p99,
          `${cards.length} card-like containers; prices 9:${p9}, 29:${p29}, 99:${p99}`,
          `cards=${cards.length}; price texts — 9:${p9}, 29:${p29}, 99:${p99}`,
        );
      },
      // (b) T2 made the Pro tier visually distinct from its siblings.
      (ctx) => {
        const after2 = ctx.perTurn[1]?.canvasAfter;
        if (!after2) return fail('T2: Pro tier visually distinguished', 'turn 2 snapshot missing');
        const evidence: string[] = [];
        const content = textContent(after2).toLowerCase();
        if (content.includes('popular')) evidence.push('"popular" badge text');
        const t29 = texts(after2).find((t) => /(?:^|[^0-9])29(?:[^0-9]|$)/.test(t.text ?? ''));
        const t9 = texts(after2).find((t) => /(?:^|[^0-9])9(?:[^0-9]|$)/.test(t.text ?? ''));
        const t99 = texts(after2).find((t) => /(?:^|[^0-9])99(?:[^0-9]|$)/.test(t.text ?? ''));
        if (
          t29 && t9 && t99 && t29.textColor &&
          t29.textColor !== t9.textColor && t29.textColor !== t99.textColor
        ) {
          evidence.push(`Pro price text color ${t29.textColor} differs from sibling prices`);
        }
        if (t29) {
          const cx = t29.x + t29.width / 2;
          const cy = t29.y + t29.height / 2;
          const cards = cardLike(after2, 100);
          const inside = cards.filter(
            (l) => cx >= l.x && cx <= l.x + l.width && cy >= l.y && cy <= l.y + l.height,
          );
          // Prefer the smallest card CONTAINING the price text (a nested badge
          // frame would also contain it — tightest box wins); fall back to the
          // nearest card by center distance.
          const byArea = inside.slice().sort((a, b) => a.width * a.height - b.width * b.height);
          const byDist = cards.slice().sort((a, b) => centerDist(a, cx, cy) - centerDist(b, cx, cy));
          const pc: Layer | undefined = (byArea.length ? byArea : byDist)[0];
          if (pc) {
            if (hasActiveShadow(pc)) evidence.push('Pro card has a shadow');
            if ((pc.strokeWidth ?? 0) > 0 && pc.stroke && pc.stroke !== 'none') {
              evidence.push(`Pro card has a border (${pc.stroke}, ${pc.strokeWidth}px)`);
            }
            if (isColorful(pc.fill)) evidence.push(`Pro card fill is an accent color (${pc.fill})`);
            const siblings = cards.filter((l) => l.id !== pc.id);
            if (siblings.length >= 2 && !siblings.some((s) => s.fill === pc.fill)) {
              evidence.push('Pro card fill differs from every sibling card');
            }
            // Layers added inside the Pro card region during T2 (badge etc.).
            const after1 = ctx.perTurn[0]?.canvasAfter;
            if (after1) {
              const rect = pc;
              const inRegion = (doc: CanvasDocument) =>
                visible(doc).filter(
                  (l) =>
                    l.x < rect.x + rect.width && l.x + l.width > rect.x &&
                    l.y < rect.y + rect.height && l.y + l.height > rect.y,
                ).length;
              if (inRegion(after2) > inRegion(after1)) {
                evidence.push('layers added inside the Pro card region during T2');
              }
            }
          }
        }
        return assert(
          'T2: Pro tier visually distinguished',
          evidence.length > 0,
          evidence.join('; '),
          t29
            ? 'no visual distinction found (no badge, accent fill, border, shadow, or price-color change on the Pro tier)'
            : 'no "$29" price text found to locate the Pro tier',
        );
      },
      // (c) T3 added a monthly/yearly billing toggle.
      (ctx) => {
        const after3 = ctx.perTurn[2]?.canvasAfter ?? ctx.final;
        const content = textContent(after3).toLowerCase();
        const toggleText = content.includes('monthly') || content.includes('yearly') || content.includes('annual');
        const namedToggle = visible(after3).some((l) => /toggle|switch|billing/i.test(l.name ?? ''));
        const pill = ofTypes(after3, ['rectangle', 'frame', 'component']).some(
          (l) =>
            l.height >= 12 && l.height <= 64 && l.width >= 28 && l.width <= 260 &&
            (l.radius ?? 0) >= l.height / 2 - 2,
        );
        return assert(
          'T3: monthly/yearly billing toggle exists',
          toggleText || namedToggle || pill,
          `monthly/yearly text:${toggleText}, toggle-named layer:${namedToggle}, pill-shaped switch:${pill}`,
          'no Monthly/Yearly text, no toggle-named layer, and no pill-shaped switch found',
        );
      },
      // (d) No-regression: Starter $9 and Enterprise $99 survive every later turn.
      (ctx) => {
        const f = ctx.final;
        const p9 = hasStandaloneNumber(f, '9');
        const p99 = hasStandaloneNumber(f, '99');
        const before = ctx.perTurn[1]?.canvasAfter;
        let lost: string[] = [];
        if (before) {
          const { missing } = noRegression(before, f);
          lost = missing.filter((t) => /\$\s*[0-9]/.test(t) || /^(?:\$?\s*)?(?:9|29|99)$/.test(t));
        }
        return assert(
          'no-regression: $9 and $99 prices survive all turns',
          p9 && p99 && lost.length === 0,
          `Starter $9 present:${p9}; Enterprise $99 present:${p99}`,
          `9:${p9}, 99:${p99}${lost.length ? `; lost price text(s): ${lost.slice(0, 4).join(' | ')}` : ''}`,
        );
      },
      noFailedToolCallsAllTurns(),
      noAgentErrorsAllTurns(),
      noDuplicateConsecutiveCallsPerTurn(),
    ],
  },

  // 2. Additive edits + layout tweaks.
  {
    id: 'ms-login-refine',
    description:
      'Additive edits + layout tweaks: mobile banking login → social sign-in row → tighter spacing with a ' +
      'full-width sign-in button. Exercises growing an existing layout and restructuring it without losing ' +
      'earlier content.',
    turns: [
      {
        prompt:
          "Create a mobile login screen for a banking app called 'Vaultly' with email and password fields, a sign-in button, and a 'Forgot password?' link.",
      },
      { prompt: 'Add social sign-in buttons for Google and Apple below the sign-in button.' },
      { prompt: 'Tighten the spacing and make the sign-in button full-width.' },
    ],
    assertions: [
      // (a) T1 has the login screen essentials.
      (ctx) => {
        const after1 = ctx.perTurn[0]?.canvasAfter;
        if (!after1) return fail('T1: login screen fields present', 'turn 1 snapshot missing');
        const content = textContent(after1).toLowerCase();
        const checks = {
          vaultly: content.includes('vaultly'),
          email: content.includes('email'),
          password: content.includes('password'),
          signIn: content.includes('sign in') || content.includes('sign-in') || content.includes('signin') || content.includes('log in'),
          forgot: content.includes('forgot'),
        };
        const pass = checks.email && checks.password && checks.signIn && checks.forgot;
        return assert(
          'T1: email/password/sign-in/forgot-password texts present',
          pass,
          Object.keys(checks).map((k) => `${k}:${(checks as Record<string, boolean>)[k] ? '✓' : '✗'}`).join(' '),
          `missing: ${Object.keys(checks).filter((k) => !(checks as Record<string, boolean>)[k]).join(', ')}`,
        );
      },
      // (b) T2 added Google AND Apple social sign-in.
      (ctx) => {
        const after2 = ctx.perTurn[1]?.canvasAfter;
        if (!after2) return fail('T2: Google + Apple social sign-in', 'turn 2 snapshot missing');
        const content = textContent(after2).toLowerCase();
        const google = content.includes('google') || visible(after2).some((l) => /google/i.test(l.name ?? ''));
        const apple = content.includes('apple') || visible(after2).some((l) => /apple/i.test(l.name ?? ''));
        return assert(
          'T2: Google AND Apple sign-in present',
          google && apple,
          `google:${google}, apple:${apple} (text or layer name)`,
          `google:${google}, apple:${apple} — need BOTH as text or layer name`,
        );
      },
      // (c) T3 made the sign-in button ~full-width.
      (ctx) => {
        const after3 = ctx.perTurn[2]?.canvasAfter ?? ctx.final;
        const vis = visible(after3);
        const frames = vis.filter((l) => ['frame', 'section', 'component', 'group'].includes(l.type));
        const reference = (frames.length ? frames : vis).reduce<Layer | undefined>(
          (m, l) => (!m || l.width > m.width ? l : m),
          undefined,
        );
        const refW = reference?.width ?? 0;
        // Button = smallest non-text layer containing the center of a
        // "sign in" text label (the outer phone frame also contains it, the
        // button is the tightest box). Fallbacks: name match, then the widest
        // button-sized rectangle in the lower half of the reference frame.
        const label = texts(after3).find((t) => /sign[- ]?in|log ?in/i.test(t.text ?? ''));
        let button: Layer | undefined;
        if (label) {
          const cx = label.x + label.width / 2;
          const cy = label.y + label.height / 2;
          const containers = vis.filter(
            (l) => l.type !== 'text' && cx >= l.x && cx <= l.x + l.width && cy >= l.y && cy <= l.y + l.height,
          );
          button = containers.sort((a, b) => a.width * a.height - b.width * b.height)[0];
        }
        if (!button) {
          button = vis.find((l) => l.type !== 'text' && /sign[- ]?in|login/i.test(l.name ?? ''));
        }
        if (!button && reference) {
          const midY = reference.y + reference.height / 2;
          button = vis
            .filter((l) => l.type !== 'text' && l.y + l.height / 2 > midY && l.height >= 24 && l.height <= 120)
            .sort((a, b) => b.width - a.width)[0];
        }
        if (button && refW > 0) {
          const ratio = button.width / refW;
          return assert(
            'T3: sign-in button ≈ full-width (≥80% of frame)',
            ratio >= 0.8,
            `button "${button.name}" ${Math.round(button.width)}px / frame ${Math.round(refW)}px = ${(ratio * 100).toFixed(0)}%`,
            `button "${button.name}" ${Math.round(button.width)}px / frame ${Math.round(refW)}px = ${(ratio * 100).toFixed(0)}% (below 80%)`,
          );
        }
        // Button ambiguous — pragmatic fallback: at least one wide layer.
        const widest = vis
          .filter((l) => l.type !== 'text')
          .reduce<Layer | undefined>((m, l) => (!m || l.width > m.width ? l : m), undefined);
        return assert(
          'T3: full-width sign-in button (fallback: wide layer ≥250px)',
          (widest?.width ?? 0) >= 250,
          `button ambiguous; widest non-text layer "${widest?.name}" is ${Math.round(widest?.width ?? 0)}px`,
          `no button identifiable and no non-text layer ≥250px wide (widest: ${Math.round(widest?.width ?? 0)}px)`,
        );
      },
      // (d) No-regression: core login content survives to the final canvas.
      (ctx) => {
        const f = ctx.final;
        const content = textContent(f).toLowerCase();
        const vaultly = content.includes('vaultly');
        const email = content.includes('email');
        const password = content.includes('password');
        const before = ctx.perTurn[1]?.canvasAfter;
        let lost: string[] = [];
        if (before) {
          const { missing } = noRegression(before, f);
          lost = missing.filter((t) => /vaultly|email|password|forgot|sign/i.test(t));
        }
        return assert(
          'no-regression: Vaultly/email/password survive all turns',
          vaultly && email && password && lost.length === 0,
          `vaultly:${vaultly}, email:${email}, password:${password}`,
          `vaultly:${vaultly}, email:${email}, password:${password}${lost.length ? `; lost: ${lost.slice(0, 4).join(' | ')}` : ''}`,
        );
      },
      noFailedToolCallsAllTurns(),
      noAgentErrorsAllTurns(),
      noDuplicateConsecutiveCallsPerTurn(),
    ],
  },

  // 3. Copy edits + style application.
  {
    id: 'ms-dashboard-edit',
    description:
      "Copy edits + style application: dashboard header → 4 KPI cards → retitle to 'Growth Metrics' + shadows " +
      'on the KPI cards. Exercises text replacement (the OLD title must disappear) and applying visual effects ' +
      'to existing components without disturbing KPI values.',
    turns: [
      {
        prompt: "Design a simple analytics dashboard header with the title 'Metrics' and a date-range selector.",
      },
      {
        prompt: 'Add a row of 4 KPI cards below the header: Revenue $128.4K, Active Users 12,840, Churn 2.1%, NPS 62.',
      },
      {
        prompt: "Change the dashboard title to 'Growth Metrics' and give the KPI cards a subtle shadow.",
      },
    ],
    assertions: [
      // (a) T1: "Metrics" title + a date-range selector.
      (ctx) => {
        const after1 = ctx.perTurn[0]?.canvasAfter;
        if (!after1) return fail('T1: header title + date-range selector', 'turn 1 snapshot missing');
        const hasTitle = hasTextContaining(after1, 'metrics');
        const content = textContent(after1).toLowerCase();
        const hasDateText =
          content.includes('date') || content.includes('range') || content.includes('period');
        const dropdown = ofTypes(after1, ['rectangle', 'frame', 'component']).some(
          (l) => l.width >= 90 && l.width <= 340 && l.height >= 20 && l.height <= 64,
        );
        return assert(
          'T1: "Metrics" title + date-range selector',
          hasTitle && (hasDateText || dropdown),
          `title:${hasTitle}, date/range text:${hasDateText}, dropdown-shaped rect:${dropdown}`,
          `title:${hasTitle}; date-range — text:${hasDateText}, dropdown rect:${dropdown}`,
        );
      },
      // (b) T2: 4 KPI cards with the exact values.
      (ctx) => {
        const after2 = ctx.perTurn[1]?.canvasAfter;
        if (!after2) return fail('T2: 4 KPI cards with values', 'turn 2 snapshot missing');
        const cards = cardLike(after2, 60);
        const rev = hasStandaloneNumber(after2, '128.4');
        const users = hasStandaloneNumber(after2, '12,840') || hasStandaloneNumber(after2, '12840');
        const churn = hasStandaloneNumber(after2, '2.1');
        const nps = hasStandaloneNumber(after2, '62');
        return assert(
          'T2: 4 KPI cards with values 128.4K / 12,840 / 2.1% / 62',
          cards.length >= 4 && rev && users && churn && nps,
          `${cards.length} card-like containers; revenue:${rev}, users:${users}, churn:${churn}, nps:${nps}`,
          `cards=${cards.length}; revenue:${rev}, users:${users}, churn:${churn}, nps:${nps}`,
        );
      },
      // (c1) T3 renamed the title — and the OLD "Metrics" title is gone.
      (ctx) => {
        const after3 = ctx.perTurn[2]?.canvasAfter ?? ctx.final;
        const growth = texts(after3).some((t) => norm(t.text ?? '') === 'Growth Metrics');
        const metricsOnly = texts(after3).some((t) => norm(t.text ?? '') === 'Metrics');
        return assert(
          'T3: title renamed to "Growth Metrics" (old "Metrics" title gone)',
          growth && !metricsOnly,
          `"Growth Metrics" present:${growth}; "Metrics"-only layer present:${metricsOnly}`,
          `"Growth Metrics" present:${growth}; old "Metrics"-only title still present:${metricsOnly}`,
        );
      },
      // (c2) T3 applied shadows to the KPI cards (≥3 layers with a shadow).
      (ctx) => {
        const after3 = ctx.perTurn[2]?.canvasAfter ?? ctx.final;
        const shadowed = visible(after3).filter((l) => hasActiveShadow(l));
        return assert(
          'T3: ≥3 layers carry a shadow effect',
          shadowed.length >= 3,
          `${shadowed.length} shadowed layer(s): ${shadowed
            .slice(0, 5)
            .map((l) => `${l.name}(blur=${l.shadow?.blur})`)
            .join(', ')}`,
          `only ${shadowed.length} layer(s) have a shadow (Layer.shadow) — expected ≥3 (the KPI cards)`,
        );
      },
      // (d) No-regression: all 4 KPI values survive the T3 restyle.
      (ctx) => {
        const f = ctx.final;
        const rev = hasStandaloneNumber(f, '128.4');
        const users = hasStandaloneNumber(f, '12,840') || hasStandaloneNumber(f, '12840');
        const churn = hasStandaloneNumber(f, '2.1');
        const nps = hasStandaloneNumber(f, '62');
        const before = ctx.perTurn[1]?.canvasAfter;
        let lost: string[] = [];
        if (before) {
          const { missing } = noRegression(before, f);
          lost = missing.filter((t) => /128\.4|12[,.]?840|2\.1/.test(t));
        }
        return assert(
          'no-regression: all 4 KPI values survive T3',
          rev && users && churn && nps && lost.length === 0,
          `revenue:${rev}, users:${users}, churn:${churn}, nps:${nps}`,
          `revenue:${rev}, users:${users}, churn:${churn}, nps:${nps}${lost.length ? `; lost: ${lost.slice(0, 4).join(' | ')}` : ''}`,
        );
      },
      noFailedToolCallsAllTurns(),
      noAgentErrorsAllTurns(),
      noDuplicateConsecutiveCallsPerTurn(),
    ],
  },
];

// ---- main -----------------------------------------------------------------------

async function main() {
  const list = ONLY
    ? MULTISHOT_SCENARIOS.filter((s) => ONLY.includes(s.id))
    : MULTISHOT_SCENARIOS;
  if (list.length === 0) {
    console.error(
      `No scenarios matched. Available: ${MULTISHOT_SCENARIOS.map((s) => s.id).join(', ')}`,
    );
    process.exit(2);
  }
  console.log(
    `Running ${list.length} multi-shot scenario(s) (${list.reduce((a, s) => a + s.turns.length, 0)} turns total) against ${API}\n` +
      `  provider/model: ${EVAL_PROVIDER} / ${EVAL_MODEL} (thinking: ${EVAL_THINKING}) · ` +
      `turn timeout ${TURN_TIMEOUT_MS / 60000}min · delays: ${TURN_DELAY_MS / 1000}s turns / ${SCENARIO_DELAY_MS / 1000}s scenarios\n`,
  );
  // Gate the suite on endpoint availability — avoids burning turn 1 against a
  // still-locked endpoint.
  await waitForLLM();

  const results: MultiShotScenarioResult[] = [];
  const canvases: Array<{ id: string; canvas: CanvasDocument }> = [];
  for (let i = 0; i < list.length; i++) {
    const sc = list[i];
    if (i > 0 && SCENARIO_DELAY_MS > 0) {
      console.log(`… scenario cooldown ${SCENARIO_DELAY_MS / 1000}s (rate-limit guard)`);
      await new Promise((r) => setTimeout(r, SCENARIO_DELAY_MS));
    }
    console.log(`▶ ${sc.id} — ${sc.turns.length} turns — ${sc.description.slice(0, 80)}…`);
    const { result, finalCanvas } = await runMultiShotScenario(sc);
    results.push(result);
    canvases.push({ id: sc.id, canvas: finalCanvas });
    const icon = result.status === 'pass' ? '✅' : result.status === 'fail' ? '❌' : '💥';
    console.log(
      `  ${icon} ${result.passed}/${result.assertions.length} assertions · ${result.toolCallCount} tools · ` +
        `${(result.durationMs / 1000).toFixed(0)}s · status=${result.status}`,
    );
    for (const a of result.assertions) {
      if (!a.pass) console.log(`     FAIL ${a.name}: ${a.detail.slice(0, 140)}`);
    }
    if (result.errorMessage) console.log(`     ERROR ${result.errorMessage.slice(0, 140)}`);
    console.log('');
  }

  // ---- reports -------------------------------------------------------------
  const outJson = join(__dirname, OUT.endsWith('.json') ? OUT : `${OUT}.json`);
  const outMd = join(__dirname, OUT.endsWith('.json') ? OUT.replace(/\.json$/, '.md') : `${OUT}.md`);
  const dir = dirname(outJson);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    outJson,
    JSON.stringify(
      {
        meta: {
          startedAt: new Date().toISOString(),
          api: API,
          provider: EVAL_PROVIDER,
          model: EVAL_MODEL,
          thinkingLevel: EVAL_THINKING,
          turnTimeoutMs: TURN_TIMEOUT_MS,
          turnDelayMs: TURN_DELAY_MS,
          scenarioDelayMs: SCENARIO_DELAY_MS,
        },
        scenarios: results,
      },
      null,
      2,
    ),
  );
  writeFileSync(outMd, renderMarkdown(results));

  // Per-scenario artifacts: JSON + markdown + final canvas dump.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    writeFileSync(join(dir, `${r.id}.json`), JSON.stringify(r, null, 2));
    writeFileSync(join(dir, `${r.id}.md`), renderScenarioSection(r).join('\n'));
    writeFileSync(join(dir, `${r.id}-final-canvas.json`), JSON.stringify(canvases[i].canvas, null, 2));
  }

  const failedScenarios = results.filter((r) => r.status !== 'pass').length;
  console.log('──────────────────────────────────────────────');
  console.log(`RESULT: ${results.length - failedScenarios}/${results.length} multi-shot scenarios passed`);
  for (const r of results) {
    const flag = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '💥';
    console.log(
      `  ${flag} ${r.id}: ${r.passed}/${r.assertions.length} assertions · ${r.turns.length} turns · ` +
        `${r.toolCallCount} tools · ${(r.durationMs / 1000).toFixed(0)}s`,
    );
  }
  console.log(`Reports: ${outMd}`);
  console.log(`         ${outJson}`);
  console.log(`         ${dir}/<scenario>-final-canvas.json (per-scenario canvas dumps)`);
  process.exit(failedScenarios > 0 ? 1 : 0);
}

// Run only when invoked directly (bun scripts/agent-eval/run-multishot.ts).
// run-eval.ts calls main() unconditionally; we guard so importing this module
// (smoke checks, programmatic use) never fires LLM calls. The argv check is
// used instead of import.meta.main because the tsc CLI verification compiles
// with default (CommonJS) module settings, where import.meta is a syntax error.
const INVOKED_DIRECTLY = (process.argv[1] ?? '')
  .replace(/\\/g, '/')
  .endsWith('scripts/agent-eval/run-multishot.ts');
if (INVOKED_DIRECTLY) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
