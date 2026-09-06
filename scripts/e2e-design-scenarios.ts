#!/usr/bin/env bun
// e2e-design-scenarios.ts — one-shot & multi-shot design generation e2e (2026-09-06)
//
// Drives the RUNNING app (POST /api/agent, real LLM) exactly like the
// production client does (src/lib/canvas/store.ts promptAgent HTTP path):
//   { documentId, prompt, canvasState, settings }
// Canvas state is maintained BETWEEN turns with the REAL
// applyPatchToCanvas() — the same pure function the route/store use — so
// multi-shot continuity assertions (shape retention, update-targeting)
// reflect true behavior, not a reimplementation.
//
// Scenarios (run each separately — LLM turns are slow):
//   bun scripts/e2e-design-scenarios.ts oneshot-login
//   bun scripts/e2e-design-scenarios.ts oneshot-dashboard
//   bun scripts/e2e-design-scenarios.ts oneshot-pricing
//   bun scripts/e2e-design-scenarios.ts multishot [--resume]
//
// multishot saves per-turn state to scripts/.e2e-state/multishot.json so a
// timeout/killed run continues from the last COMPLETED turn with --resume.
//
// Assertions:
//   one-shot: turn_end, no errors, >= minShapes resolved shapes, finite
//             geometry, manual critique default (zero critic dispatches).
//   multi-shot: per-turn turn_end/no-errors; shape-id RETENTION across turns
//             (an edit turn must not bulldoze the canvas); turn 2+ must emit
//             update/remove ops TARGETING pre-existing ids (proves journal
//             history → context targeting, not blind rebuilds); theme-restyle
//             turn keeps count stable; extend turn grows the canvas.

import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT_DIR = '/home/z/my-project/download/e2e-design-2026-09-06';
const STATE_DIR = '/home/z/my-project/scripts/.e2e-state';
const REPORT = `${OUT_DIR}/report.json`;
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// ---- helpers ----------------------------------------------------------------

function freshDoc(id: string, name: string): CanvasDocument {
  return {
    id,
    name,
    background: '#f8fafc',
    version: '2.17',
    children: [],
    variables: undefined,
    themes: undefined,
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  } as CanvasDocument;
}

const SETTINGS = {
  llmProvider: 'zai',
  thinkingLevel: 'low',
  maxIterations: 12,
  // designCritiqueMode intentionally ABSENT — the product default ('manual')
  // must apply, and critics must stay silent without an explicit ask.
};

interface TurnResult {
  turnEnd: boolean;
  errors: string[];
  patches: CanvasPatch[];
  opCounts: Record<string, number>;
  eventCounts: Record<string, number>;
  toolCalls: number;
  subagentDispatches: string[];
  critiqueEvents: number;
  critiqueDefects: number;
  skipReasons: string[];
  planProposed: boolean;
  messages: string[];
  assistantText: string;
  finalStatus?: string;
  diffSummary: string;
  durationMs: number;
  environmentalRetries: number;
}

function emptyTurn(): TurnResult {
  return {
    turnEnd: false, errors: [], patches: [], opCounts: {}, eventCounts: {},
    toolCalls: 0, subagentDispatches: [], critiqueEvents: 0, critiqueDefects: 0,
    skipReasons: [], planProposed: false, messages: [], assistantText: '',
    finalStatus: undefined, diffSummary: '', durationMs: 0, environmentalRetries: 0,
  };
}

const ENV_ERROR = /rate.?limit|429|503|overload|too many requests|temporarily unavailable|timeout|timed out|econnreset|socket hang up|finish reason|provider error|stopped mid-turn/i;

/// Progressive provider-cooldown backoffs: the sandbox LLM needs ~1-2 minutes
/// of rest after sustained multi-round usage before stopReason-error rounds
/// recover (observed 2026-09-06: three consecutive design turns each died at
/// the wrap-up round; a 60s+ wait restored full builds).
const BACKOFFS = [30_000, 90_000, 150_000];

async function runTurn(
  documentId: string,
  prompt: string,
  canvas: CanvasDocument,
  maxRetries = 3,
): Promise<{ canvas: CanvasDocument; result: TurnResult }> {
  let result = emptyTurn();
  let state = canvas;
  let carriedText = ''; // assistant text from ANY attempt (a retried turn's
  let carriedDiff = ''; // earlier attempt may have streamed the full reply)
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    result = emptyTurn();
    if (attempt > 0) result.environmentalRetries = attempt;
    result.assistantText = carriedText;
    result.diffSummary = carriedDiff;
    const started = Date.now();
    console.log(`  [turn] POST /api/agent (${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''})${attempt > 0 ? ` RETRY ${attempt}` : ''}`);
    const res = await fetch(`${BASE}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId,
        prompt,
        canvasState: state,
        settings: SETTINGS,
      }),
    });
    if (!res.ok || !res.body) {
      result.errors.push(`HTTP ${res.status}`);
      if (attempt < maxRetries) { await sleep(BACKOFFS[attempt] ?? 60_000); continue; }
      result.durationMs = Date.now() - started;
      return { canvas: state, result };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const { createWriteStream } = await import('node:fs');
    const eventTee = createWriteStream(`${STATE_DIR}/events-latest.ndjson`);
    const closeTee = () => new Promise<void>((r) => eventTee.end(() => r()));
    outer: while (true) {
      if (Date.now() - started > 10 * 60 * 1000) { result.errors.push('harness turn timeout (10m)'); break; }
      const read = (await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ done: true, timedOut: true }), 120_000)),
      ])) as { done?: boolean; value?: unknown };
      if (read.done) break;
      buf += decoder.decode(read.value as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'agent_event' && ev.event?.type) {
          result.eventCounts[ev.event.type] = (result.eventCounts[ev.event.type] ?? 0) + 1;
          eventTee.write(JSON.stringify(ev.event) + '\n');
        } else if (ev.type === 'patch' && ev.patch) {
          eventTee.write(JSON.stringify({ type: 'patch', op: ev.patch.op ?? ev.patch.type, toolCallId: ev.toolCallId }) + '\n');
        }
        if (ev.type === 'patch' && ev.patch) {
          const op = ev.patch.op ?? ev.patch.type;
          result.patches.push(ev.patch);
          result.opCounts[op] = (result.opCounts[op] ?? 0) + 1;
          try {
            state = applyPatchToCanvas(state, ev.patch as CanvasPatch);
          } catch (e) {
            result.errors.push(`patch apply failed (op=${op}): ${String(e).slice(0, 140)}`);
          }
        } else if (ev.type === 'agent_event' && ev.event) {
          const t = ev.event.type as string;
          if (t === 'agent:turn_end') {
            result.turnEnd = true;
            // KEEP READING: the route's finally emits agent:turn_final (with
            // the assistant text + status + diff summary) AFTER turn_end and
            // closes the stream right after it.
          } else if (t === 'agent:turn_final') {
            result.turnEnd = true; // the route synthesizes turn_end around it
            result.assistantText = ev.event.text ?? result.assistantText;
            result.diffSummary = ev.event.diffSummary ?? result.diffSummary;
            result.finalStatus = ev.event.status ?? result.finalStatus;
            carriedText = result.assistantText;
            carriedDiff = result.diffSummary;
            break outer;
          } else if (t === 'agent:error') {
            result.errors.push(String(ev.event.message ?? 'unknown agent error'));
          } else if (t === 'agent:message_end') {
            const txt = String(ev.event.text ?? ev.event.content ?? '').trim();
            if (txt) result.messages.push(txt);
          } else if (t === 'agent:plan_proposed') {
            result.planProposed = true;
          } else if (t === 'agent:tool_call_start') {
            result.toolCalls++;
          } else if (t === 'agent:subagent_dispatch') {
            result.subagentDispatches.push(String(ev.event.subAgentType ?? '?'));
          } else if (t === 'agent:critique') {
            result.critiqueEvents++;
            result.critiqueDefects += (ev.event.defects ?? []).length;
          } else if (t === 'agent:critique_skipped') {
            result.skipReasons.push(String(ev.event.reason ?? '?'));
          }
        }
      }
    }
    result.durationMs = Date.now() - started;
    await closeTee();
    const envErrors = result.errors.filter((e) => ENV_ERROR.test(e));
    if (result.turnEnd && result.errors.length === envErrors.length && envErrors.length === 0) {
      return { canvas: state, result };
    }
    // terminal failure or environmental — retry env errors, give up on hard ones
    if (envErrors.length > 0 && envErrors.length === result.errors.length && attempt < maxRetries) {
      console.log(`  [turn] environmental error, backing off ${Math.round((BACKOFFS[attempt] ?? 60_000) / 1000)}s: ${envErrors[0].slice(0, 100)}`);
      await sleep(BACKOFFS[attempt] ?? 60_000);
      continue; // state keeps partially-applied patches — same as production
    }
    return { canvas: state, result };
  }
  return { canvas: state, result };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function idsOf(canvas: CanvasDocument): Set<string> {
  return new Set((canvas.shapes ?? []).map((s: any) => String(s.id)));
}

function targetedExistingIds(patches: CanvasPatch[], priorIds: Set<string>): Set<string> {
  const hit = new Set<string>();
  for (const p of patches as any[]) {
    const op = p.op ?? p.type;
    if (op === 'update' && p.shapeId && priorIds.has(p.shapeId)) hit.add(p.shapeId);
    if (op === 'update_many' && Array.isArray(p.updates)) {
      for (const u of p.updates) if (u.id && priorIds.has(u.id)) hit.add(u.id);
    }
    if (op === 'remove') {
      for (const id of p.shapeIds ?? (p.shapeId ? [p.shapeId] : [])) if (priorIds.has(id)) hit.add(id);
    }
  }
  return hit;
}

function geometryIssues(canvas: CanvasDocument): string[] {
  const issues: string[] = [];
  for (const s of canvas.shapes ?? []) {
    const sh = s as any;
    for (const k of ['x', 'y', 'width', 'height']) {
      const v = Number(sh[k]);
      if (!Number.isFinite(v)) { issues.push(`${sh.id}:${k}=NaN`); break; }
    }
    if (Number(sh.width) <= 0 || Number(sh.height) <= 0) issues.push(`${sh.id}:nonpositive-size`);
  }
  return issues.slice(0, 5);
}

function mergeReport(entry: Record<string, unknown>) {
  let report: any = {};
  if (existsSync(REPORT)) { try { report = JSON.parse(readFileSync(REPORT, 'utf8')); } catch { /* reset */ } }
  report.generatedAt = new Date().toISOString();
  report.scenarios = report.scenarios ?? {};
  for (const [k, v] of Object.entries(entry)) report.scenarios[k] = v;
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
}

function record(
  scenario: string, passed: boolean, checks: Array<[string, boolean]>,
  details: Record<string, unknown>,
) {
  const entry = { passed, checks: checks.map(([name, ok]) => ({ name, ok })), ...details };
  mergeReport({ [scenario]: entry });
  console.log(`\n[${scenario}] ${passed ? 'PASS' : 'FAIL'}`);
  for (const [name, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
}

// ---- one-shot ----------------------------------------------------------------

interface OneShotSpec {
  key: string; prompt: string; minShapes: number; docName: string;
}

const ONE_SHOTS: OneShotSpec[] = [
  {
    key: 'oneshot-login',
    docName: 'E2E Login',
    prompt:
      'Create a login screen: a centered card with a bold title "Welcome back", an email input with label, a password input with label, a primary "Log in" button, a remember-me row with checkbox, and a footer with two links ("Forgot password" and "Create account").',
    minShapes: 10,
  },
  {
    key: 'oneshot-dashboard',
    docName: 'E2E Dashboard',
    prompt:
      'Create an analytics dashboard: a top nav bar with logo text and 3 nav items, a page title, a row of 4 stat cards (each with metric label, big value, and a trend chip), a large chart area placeholder with axis labels, and a "Recent activity" list with 4 rows (icon, text, timestamp).',
    minShapes: 18,
  },
  {
    key: 'oneshot-pricing',
    docName: 'E2E Pricing',
    prompt:
      'Create a pricing page: a header with title "Simple pricing" and subtitle, then 3 pricing tier cards side by side (each with plan name, monthly price, 4 feature rows, and a CTA button), and a footer note row below.',
    minShapes: 16,
  },
];

async function runOneShot(spec: OneShotSpec) {
  const docId = `e2e-${spec.key}-${Date.now()}`;
  console.log(`\n=== ONE-SHOT ${spec.key} (doc ${docId}) ===`);
  const { canvas, result } = await runTurn(docId, spec.prompt, freshDoc(docId, spec.docName));
  const shapes = (canvas.shapes ?? []).length;
  const geo = geometryIssues(canvas);
  const criticDispatches = result.subagentDispatches.filter((t) => /design_critic/.test(t)).length;

  writeFileSync(`${OUT_DIR}/${spec.key}-shapes.json`, JSON.stringify(
    (canvas.shapes ?? []).map((s: any) => ({
      id: s.id, name: s.name, type: s.type,
      x: s.x, y: s.y, w: s.width, h: s.height,
    })), null, 2));

  const checks: Array<[string, boolean]> = [
    ['turn completed (agent:turn_end)', result.turnEnd],
    [`no agent errors${result.environmentalRetries ? ` (${result.environmentalRetries} environmental retries)` : ''}`, result.errors.length === 0],
    [`canvas populated (${shapes} shapes >= ${spec.minShapes})`, shapes >= spec.minShapes],
    ['geometry sane (finite, positive sizes)', geo.length === 0],
    // INVOCATION gate = subagent dispatches ONLY. The free deterministic
    // validator legitimately reports defects via agent:critique events after
    // every build turn (e.g. contrast warnings) — that is NOT an LLM critic
    // invocation (see scripts/verify-manual-critique.mjs semantics).
    ['manual critique default: no critic dispatch', criticDispatches === 0],
    ['agent produced an assistant reply', result.assistantText.trim().length > 0],
  ];
  const passed = checks.every(([, ok]) => ok);
  record(spec.key, passed, checks, {
    docId, shapes, durationMs: result.durationMs, toolCalls: result.toolCalls,
    opCounts: result.opCounts, diffSummary: result.diffSummary,
    errors: result.errors, assistantText: result.assistantText.slice(0, 500),
  });
  return passed;
}

// ---- multi-shot ---------------------------------------------------------------

interface MultiShotState {
  documentId: string;
  turnIndex: number;
  canvas: CanvasDocument;
  turns: Array<TurnResult & { prompt: string; shapesBefore: number; shapesAfter: number; idRetention: number; targetedExisting: number }>;
}

const MULTI_TURNS: Array<{ prompt: string; kind: 'build' | 'edit' | 'restyle' | 'extend'; minRetention: number; requireTargeting: boolean; countRange?: [number, number]; minGrowth?: number }> = [
  {
    kind: 'build',
    prompt: 'Create a pricing page: a header with the title "Plans for every team" and a short subtitle, then 3 pricing tier cards side by side named Starter, Pro, and Enterprise. Each tier has a plan name, a monthly price, 4 feature rows, and a CTA button. The middle Pro tier is the one I will iterate on.',
    minRetention: 1.0,
    requireTargeting: false,
  },
  {
    kind: 'edit',
    prompt: 'Add a "MOST POPULAR" badge above the Pro tier card and give the Pro card an accent border or background tint so it stands out from the other two tiers. Do not rebuild the other tiers.',
    minRetention: 0.9,
    requireTargeting: true,
  },
  {
    kind: 'restyle',
    prompt: 'Switch the entire page to a dark theme: very dark background, light text, and a violet accent color. Keep every section, card, and piece of text — this is a restyle, not a rebuild.',
    minRetention: 0.75,
    countRange: [0.7, 1.4],
    requireTargeting: true,
  },
  {
    kind: 'extend',
    prompt: 'Add a testimonials section below the pricing tiers: a section title "Loved by builders" and 2 quote cards, each with a circular avatar, a short quote text, and an author name. Keep everything above unchanged.',
    minRetention: 0.9,
    requireTargeting: false,
    minGrowth: 4,
  },
];

async function runMultiShot(resume: boolean) {
  const stateFile = `${STATE_DIR}/multishot.json`;
  let st: MultiShotState;
  if (resume && existsSync(stateFile)) {
    st = JSON.parse(readFileSync(stateFile, 'utf8')) as MultiShotState;
    console.log(`\n=== MULTI-SHOT RESUME (doc ${st.documentId}, from turn ${st.turnIndex + 1}/${MULTI_TURNS.length}) ===`);
  } else {
    const documentId = `e2e-multishot-${Date.now()}`;
    st = { documentId, turnIndex: 0, canvas: freshDoc(documentId, 'E2E Multi-shot'), turns: [] };
    console.log(`\n=== MULTI-SHOT (doc ${documentId}, ${MULTI_TURNS.length} turns) ===`);
  }

  while (st.turnIndex < MULTI_TURNS.length) {
    const spec = MULTI_TURNS[st.turnIndex];
    const idsBefore = idsOf(st.canvas);
    const shapesBefore = (st.canvas.shapes ?? []).length;
    const { canvas, result } = await runTurn(st.documentId, spec.prompt, st.canvas);
    const idsAfter = idsOf(canvas);
    const shapesAfter = (canvas.shapes ?? []).length;
    let retained = 1;
    if (idsBefore.size > 0) {
      let keep = 0;
      for (const id of idsBefore) if (idsAfter.has(id)) keep++;
      retained = keep / idsBefore.size;
    }
    const targeted = targetedExistingIds(result.patches, idsBefore);
    st.turns.push({
      ...result, prompt: spec.prompt, shapesBefore, shapesAfter,
      idRetention: retained, targetedExisting: targeted.size,
    });
    st.canvas = canvas;
    st.turnIndex++;
    writeFileSync(stateFile, JSON.stringify(st)); // checkpoint after EVERY turn
    console.log(`  [turn ${st.turnIndex}/${MULTI_TURNS.length}] done: shapes ${shapesBefore}->${shapesAfter}, retention=${(retained * 100).toFixed(0)}%, targetedExisting=${targeted.size}, toolCalls=${result.toolCalls}, ${result.durationMs}ms`);
  }

  // ---- assertions over the whole run ----
  const checks: Array<[string, boolean]> = [];
  MULTI_TURNS.forEach((spec, i) => {
    const t = st.turns[i];
    if (!t) return;
    const n = `T${i + 1} (${spec.kind})`;
    checks.push([`${n}: turn completed`, t.turnEnd]);
    checks.push([`${n}: no errors`, t.errors.length === 0]);
    if (spec.kind !== 'build') {
      checks.push([`${n}: shape-id retention >= ${(spec.minRetention * 100).toFixed(0)}% (${(t.idRetention * 100).toFixed(0)}%)`, t.idRetention >= spec.minRetention]);
    }
    if (spec.countRange) {
      const ratio = t.shapesBefore > 0 ? t.shapesAfter / t.shapesBefore : 1;
      checks.push([`${n}: count ratio in [${spec.countRange[0]}, ${spec.countRange[1]}] (${ratio.toFixed(2)})`, ratio >= spec.countRange[0] && ratio <= spec.countRange[1]]);
    }
    if (spec.minGrowth) {
      checks.push([`${n}: grew by >= ${spec.minGrowth} shapes (+${t.shapesAfter - t.shapesBefore})`, t.shapesAfter - t.shapesBefore >= spec.minGrowth]);
    }
    if (spec.requireTargeting) {
      checks.push([`${n}: targeted pre-existing nodes (${t.targetedExisting} update/remove hits)`, t.targetedExisting >= 1]);
    }
    const criticDispatches = t.subagentDispatches.filter((x) => /design_critic/.test(x)).length;
    // Invocation gate: dispatches only (the free validator may report defects).
    checks.push([`${n}: manual critique (no auto critics)`, criticDispatches === 0]);
  });
  const finalShapes = (st.canvas.shapes ?? []).length;
  checks.push([`final canvas substantial (${finalShapes} shapes >= 25)`, finalShapes >= 25]);
  checks.push(['geometry sane', geometryIssues(st.canvas).length === 0]);

  writeFileSync(`${OUT_DIR}/multishot-shapes.json`, JSON.stringify(
    (st.canvas.shapes ?? []).map((s: any) => ({ id: s.id, name: s.name, type: s.type, x: s.x, y: s.y, w: s.width, h: s.height })), null, 2));
  writeFileSync(`${OUT_DIR}/multishot-turns.json`, JSON.stringify(st.turns.map((t) => ({
    prompt: t.prompt, shapesBefore: t.shapesBefore, shapesAfter: t.shapesAfter,
    idRetention: t.idRetention, targetedExisting: t.targetedExisting,
    toolCalls: t.toolCalls, opCounts: t.opCounts, diffSummary: t.diffSummary,
    durationMs: t.durationMs, errors: t.errors, assistantText: t.assistantText.slice(0, 600),
  })), null, 2));

  const passed = checks.every(([, ok]) => ok);
  record('multishot', passed, checks, {
    docId: st.documentId,
    totalDurationMs: st.turns.reduce((a, t) => a + t.durationMs, 0),
    turns: st.turns.map((t) => ({ shapes: t.shapesAfter, retention: t.idRetention, targeted: t.targetedExisting })),
    finalShapes,
  });
  return passed;
}

// ---- main ----------------------------------------------------------------------

const arg = process.argv[2] ?? '';
const resume = process.argv.includes('--resume');
const one = ONE_SHOTS.find((s) => s.key === arg);
try {
  if (one) process.exit(await runOneShot(one) ? 0 : 1);
  else if (arg === 'multishot') process.exit(await runMultiShot(resume) ? 0 : 1);
  else {
    console.error('usage: bun scripts/e2e-design-scenarios.ts <oneshot-login|oneshot-dashboard|oneshot-pricing|multishot> [--resume]');
    process.exit(2);
  }
} catch (e) {
  console.error('[harness] fatal:', e);
  process.exit(2);
}
