#!/usr/bin/env bun
// poor-prompts.ts — Real-world poor-prompt robustness battery.
//
// Real users type junk: gibberish, emoji, typos, vague anaphora ("make it
// blue" on an empty canvas), off-scope requests, run-on multi-intent walls,
// mega-long rambles, non-English, and hopelessly vague follow-ups. This
// harness runs each through the app's own HTTP API (POST /api/agent, BETA
// preset via app defaults — respects the no-direct-invocation DOX policy)
// and applies per-scenario verdict rules:
//
//   CLARIFY scenarios (gibberish/emoji/anaphora-empty): the honest behavior
//     is a text clarification with LITTLE/NO canvas mutation — building a
//     random canvas from "asdfgh" is hallucination, a crash is a bug.
//   BUILD scenarios (typo/non-english/run-on): the model should still
//     deliver a real screen despite typos / language.
//   OFF-SCOPE: graceful text answer or minimal canvas, never a crash.
//   MEGA-LONG: the turn must complete (no prompt-length 400, no hang).
//   VAGUE-FOLLOWUP: prior content survives, something gets enhanced.
//
// Usage: bun scripts/agent-eval/poor-prompts.ts
// Env:   EVAL_API (default http://localhost:3000/api/agent)

import { applyPatchToCanvas } from '../../src/lib/canvas/patch';
import { normalizeCanvas } from '../../src/lib/agent/runner-legacy';
import { createEmptyCanvasDocument } from '../../src/lib/canvas/types';
import type { CanvasDocument, CanvasPatch, Shape } from '../../src/lib/canvas/types';
import { DEFAULT_SETTINGS } from '../../src/lib/settings/types';

const API = process.env.EVAL_API ?? 'http://localhost:3000/api/agent';
const TIMEOUT = 8 * 60 * 1000;
// SCENARIOS=run-on-multi-intent,off-scope bun scripts/agent-eval/poor-prompts.ts
const ONLY = (process.env.SCENARIOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SKIP_FOLLOWUP = process.env.SKIP_FOLLOWUP === '1';

interface TurnRun {
  canvas: CanvasDocument;
  toolCalls: Array<{ name: string; success: boolean }>;
  errors: string[];
  messageText: string;
  patchCount: number;
  durationMs: number;
  httpStatus?: number;
  httpError?: string;
  finalStatus?: string;
  stopReason?: string;
  llmRounds: number;
}

async function runTurn(documentId: string, prompt: string, canvasIn: CanvasDocument): Promise<TurnRun> {
  let canvas = canvasIn;
  const toolCalls: TurnRun['toolCalls'] = [];
  const errors: string[] = [];
  let messageText = '';
  let patchCount = 0;
  const t0 = Date.now();
  let httpStatus: number | undefined;
  let httpError: string | undefined;
  let finalStatus: string | undefined;
  let stopReason: string | undefined;
  let llmRounds = 0;
  const openCalls: number[] = [];

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT + 60_000),
      body: JSON.stringify({
        documentId,
        prompt,
        canvasState: canvasIn,
        settings: {
          temperature: DEFAULT_SETTINGS.temperature,
          maxIterations: DEFAULT_SETTINGS.maxIterations,
          planFirst: DEFAULT_SETTINGS.planFirst,
          thinkingLevel: DEFAULT_SETTINGS.thinkingLevel,
          defaultPalette: DEFAULT_SETTINGS.defaultPalette,
          skillSelectionMode: DEFAULT_SETTINGS.skillSelectionMode,
          llmProvider: DEFAULT_SETTINGS.llmProvider,
          modelName: DEFAULT_SETTINGS.modelName,
        },
      }),
    });
    httpStatus = res.status;
    if (!res.ok || !res.body) {
      httpError = (await res.text()).slice(0, 200);
      return { canvas, toolCalls, errors, messageText, patchCount, durationMs: Date.now() - t0, httpStatus, httpError, llmRounds };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + TIMEOUT;
    let streamDone = false;

    while (!streamDone) {
      if (Date.now() > deadline) { errors.push('STREAM TIMEOUT'); break; }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: { type: string; patch?: CanvasPatch; event?: any };
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'patch' && ev.patch) {
          patchCount++;
          try { canvas = applyPatchToCanvas(canvas, ev.patch); } catch (e) { errors.push(`patch apply failed: ${(e as Error).message}`); }
        } else if (ev.type === 'agent_event' && ev.event) {
          const e = ev.event;
          switch (e.type) {
            case 'agent:message_delta': messageText += e.text; break;
            case 'agent:tool_call_start':
              openCalls.push(toolCalls.length);
              toolCalls.push({ name: e.toolName, success: true });
              break;
            case 'agent:tool_call_end': {
              const idx = openCalls.shift();
              if (idx !== undefined) toolCalls[idx].success = e.success;
              break;
            }
            case 'agent:round_start': case 'agent:llm_round': llmRounds++; break;
            case 'agent:error': errors.push(`agent:error ${e.message ?? ''}`.slice(0, 150)); break;
            case 'agent:turn_final':
              finalStatus = e.status ?? '';
              stopReason = e.stopReason ?? '';
              streamDone = true;
              break;
            default: break;
          }
        }
      }
    }
  } catch (e) {
    httpError = (e as Error).message;
  }

  canvas = normalizeCanvas(canvas);
  return { canvas, toolCalls, errors, messageText, patchCount, durationMs: Date.now() - t0, httpStatus, httpError, finalStatus, stopReason, llmRounds };
}

// ---- scenarios ---------------------------------------------------------------

type Kind = 'clarify' | 'build' | 'offscope' | 'mega' | 'empty' | 'followup';
interface Scenario {
  id: string;
  kind: Kind;
  prompt: string;
  promptZh?: string;
}

const LONG_RAMBLE = Array.from({ length: 24 }, (_, i) =>
  `Also we need section ${i + 2} with a heading and some text about feature ${i + 2} and maybe an icon and a bullet list of three benefits and a small illustration placeholder`,
).join('. ');

const scenarios: Scenario[] = [
  { id: 'empty-whitespace', kind: 'empty', prompt: '   \n\t  ' },
  { id: 'gibberish', kind: 'clarify', prompt: 'asdfgh jklqw zxcv bnm poiuy' },
  { id: 'emoji-only', kind: 'clarify', prompt: '🔥🔥🔥 ✨ 👍' },
  { id: 'anaphora-empty-canvas', kind: 'clarify', prompt: 'make it blue and bigger' },
  { id: 'typo-storm', kind: 'build', prompt: 'buld me a lgin pge wth emial + paswrod feilds n a submmit btn' },
  { id: 'non-english', kind: 'build', prompt: '做一个简单的登录表单，包含邮箱输入框、密码输入框和一个登录按钮，风格简洁' },
  { id: 'run-on-multi-intent', kind: 'build', prompt: 'make a pricing page with 3 tiers and a hero with a big headline and a nav bar with logo and 4 links and a footer with social icons and make it dark mode' },
  { id: 'off-scope', kind: 'offscope', prompt: 'write a python function that sorts a list of numbers and prints hello world' },
  { id: 'mega-long', kind: 'mega', prompt: `Build a product landing page. It needs a hero section with a headline, subheadline, two CTA buttons and a product screenshot placeholder. ${LONG_RAMBLE}. Also a pricing section, an FAQ, testimonials, and a footer. Make it cohesive.` },
];

const FUZZ_T1 = 'Create a pricing page with three plan cards: Starter at $9, Pro at $29 (highlighted), Enterprise at $99. Each card has a title, price, three feature bullets, and a CTA button.';
const FUZZ_T2 = 'make it pop';

// ---- verdict rules ------------------------------------------------------------

interface Verdict { pass: boolean; notes: string[] }

function verdictFor(s: Scenario, r: TurnRun, shapesBefore: number): Verdict {
  const notes: string[] = [];
  const shapesAfter = (r.canvas.shapes ?? []).length;
  const added = Math.max(0, shapesAfter - shapesBefore);
  const hasText = r.messageText.trim().length > 20;
  const failedCall = r.toolCalls.some((t) => !t.success);
  let pass = true;

  const fatal = () => {
    if (r.httpError && r.httpStatus && r.httpStatus !== 400) { pass = false; notes.push(`HTTP ${r.httpStatus}: ${r.httpError}`); return true; }
    if (r.httpError && !r.httpStatus) { pass = false; notes.push(`fetch fail: ${r.httpError}`); return true; }
    if (r.finalStatus === 'error' || r.finalStatus === 'stuck') { pass = false; notes.push(`turn_final status=${r.finalStatus} stopReason=${r.stopReason}`); return true; }
    if (r.errors.length) { pass = false; notes.push(`stream errors: ${r.errors.slice(0, 2).join(' | ')}`); return true; }
    if (!r.finalStatus) { pass = false; notes.push('no turn_final (stream never finished)'); return true; }
    return false;
  };

  switch (s.kind) {
    case 'empty':
      if (r.httpStatus !== 400) { pass = false; notes.push(`expected 400, got ${r.httpStatus} — junk prompt burned an LLM call`); }
      else notes.push('400 rejected without LLM call');
      break;
    case 'clarify':
      if (fatal()) break;
      if (!hasText) { pass = false; notes.push('no clarification text — silent turn'); }
      if (added > 3) { pass = false; notes.push(`hallucinated ${added} shapes from junk input`); }
      if (pass) notes.push(`honest clarification (${r.messageText.trim().length} chars, ${added} shapes added)`);
      break;
    case 'build':
      if (fatal()) break;
      if (added < 5) { pass = false; notes.push(`only ${added} shapes — screen not really built`); }
      if (failedCall) notes.push('(some tool calls failed)');
      if (pass) notes.push(`built ${added} shapes via ${r.toolCalls.length} tool calls`);
      break;
    case 'offscope':
      if (fatal()) break;
      if (!hasText) { pass = false; notes.push('no text response to off-scope request'); }
      else if (added > 12) notes.push(`note: built ${added} shapes from off-scope prompt`);
      if (pass) notes.push(`graceful: ${r.messageText.trim().length}-char answer, ${added} shapes`);
      break;
    case 'mega':
      if (fatal()) break;
      if (r.httpStatus === 400) { pass = false; notes.push('400 — likely prompt-length rejection'); }
      if (pass) notes.push(`completed: ${added} shapes, ${r.toolCalls.length} tools, ${r.durationMs / 1000 | 0}s`);
      break;
    case 'followup':
      if (fatal()) break;
      {
        const b = new Map((r.canvas.shapes ?? []).map((x: Shape) => [x.id, 1]));
        // removals: shapes from before that vanished
        // (canvas after already has them removed; compute via patch trail not available — approximate with before/after counts)
        if (shapesAfter < shapesBefore - 2) { pass = false; notes.push(`canvas shrank ${shapesBefore}→${shapesAfter} (wipe?)`); }
        else if (r.patchCount === 0) { pass = false; notes.push('follow-up was a no-op'); }
        else notes.push(`vague follow-up engaged: ${r.patchCount} patches, ${shapesBefore}→${shapesAfter} shapes`);
        void b;
      }
      break;
  }
  return { pass, notes };
}

// ---- main --------------------------------------------------------------------

console.log(`Poor-prompt battery against ${API}\n`);
const results: Array<{ id: string; kind: Kind; pass: boolean; notes: string[]; dur: number }> = [];

for (const s of ONLY.length ? scenarios.filter((s) => ONLY.includes(s.id)) : scenarios) {
  const doc = createEmptyCanvasDocument(`poor-prompts-${s.id}-${Date.now()}`, s.id);
  const r = await runTurn(doc.id, s.prompt, doc);
  const v = verdictFor(s, r, 0);
  const icon = v.pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${s.id} (${s.kind}) — ${(r.durationMs / 1000).toFixed(0)}s, http=${r.httpStatus ?? '-'}, final=${r.finalStatus ?? '-'}${r.stopReason ? `/${r.stopReason}` : ''}`);
  for (const n of v.notes) console.log(`        ${n}`);
  if (r.messageText.trim()) console.log(`        msg: ${r.messageText.trim().slice(0, 160).replace(/\n/g, ' ')}`);
  results.push({ id: s.id, kind: s.kind, pass: v.pass, notes: v.notes, dur: r.durationMs });
}

// Vague follow-up (needs a real first turn)
if (!SKIP_FOLLOWUP) {
  const doc = createEmptyCanvasDocument(`poor-prompts-followup-${Date.now()}`, 'followup');
  const r1 = await runTurn(doc.id, FUZZ_T1, doc);
  const shapes1 = (r1.canvas.shapes ?? []).length;
  console.log(`\n(follow-up setup turn: ${shapes1} shapes, final=${r1.finalStatus ?? '-'})`);
  const r2 = await runTurn(doc.id, FUZZ_T2, r1.canvas);
  const v = verdictFor({ id: 'vague-followup', kind: 'followup', prompt: FUZZ_T2 }, r2, shapes1);
  const icon = v.pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] vague-followup (followup) — ${(r2.durationMs / 1000).toFixed(0)}s, final=${r2.finalStatus ?? '-'}`);
  for (const n of v.notes) console.log(`        ${n}`);
  if (r2.messageText.trim()) console.log(`        msg: ${r2.messageText.trim().slice(0, 160).replace(/\n/g, ' ')}`);
  results.push({ id: 'vague-followup', kind: 'followup', pass: v.pass, notes: v.notes, dur: r2.durationMs });
}

// ---- summary ------------------------------------------------------------------

const failed = results.filter((r) => !r.pass);
console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) {
  console.log('Failures:');
  for (const f of failed) console.log(`  ✗ ${f.id}: ${f.notes.join('; ')}`);
}
