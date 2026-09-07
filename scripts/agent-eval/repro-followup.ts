#!/usr/bin/env bun
// repro-followup.ts — Focused 2-turn repro for follow-up prompt debugging.
//
// Turn 1 builds a small design. Turn 2 issues a targeted EDIT follow-up.
// Captures per-turn: tool calls, patches, errors, message text, and a
// shape-level diff (added/removed/updated) so we can see whether the
// follow-up EDITED prior nodes or did something wrong (rebuild-all,
// no-op, error, canvas wipe).
//
// Usage: bun scripts/agent-eval/repro-followup.ts
// Env:   EVAL_API (default http://localhost:3000/api/agent)

import { applyPatchToCanvas } from '../../src/lib/canvas/patch';
import { normalizeCanvas } from '../../src/lib/agent/runner-legacy';
import { createEmptyCanvasDocument } from '../../src/lib/canvas/types';
import type { CanvasDocument, CanvasPatch, Shape } from '../../src/lib/canvas/types';
import { DEFAULT_SETTINGS } from '../../src/lib/settings/types';

const API = process.env.EVAL_API ?? 'http://localhost:3000/api/agent';
const TIMEOUT = 8 * 60 * 1000;

interface TurnRun {
  canvas: CanvasDocument;
  toolCalls: Array<{ name: string; success: boolean; summary: string }>;
  errors: string[];
  messageText: string;
  patchOps: Array<string>;
  durationMs: number;
  error?: string;
  finalEvent?: string;
}

async function runTurn(documentId: string, prompt: string, canvasIn: CanvasDocument): Promise<TurnRun> {
  let canvas = canvasIn;
  const toolCalls: TurnRun['toolCalls'] = [];
  const errors: string[] = [];
  const patchOps: string[] = [];
  let messageText = '';
  const openCalls: number[] = [];
  const t0 = Date.now();
  let error: string | undefined;
  let finalEvent: string | undefined;

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
    if (!res.ok || !res.body) {
      throw new Error(`API responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + TIMEOUT;
    let streamDone = false;

    while (!streamDone) {
      if (Date.now() > deadline) throw new Error(`turn timed out after ${TIMEOUT / 60000} min`);
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: { type: string; patch?: CanvasPatch; event?: any };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'patch' && ev.patch) {
          try {
            canvas = applyPatchToCanvas(canvas, ev.patch);
            patchOps.push(`${ev.patch.op}:${(ev.patch as any).path ?? ''}`.slice(0, 60));
          } catch (e) {
            errors.push(`patch apply failed: ${(e as Error).message}`);
          }
        } else if (ev.type === 'agent_event' && ev.event) {
          const e = ev.event;
          switch (e.type) {
            case 'agent:message_delta':
              messageText += e.text;
              break;
            case 'agent:tool_call_start':
              openCalls.push(toolCalls.length);
              toolCalls.push({ name: e.toolName, success: true, summary: '' });
              break;
            case 'agent:tool_call_end': {
              const idx = openCalls.shift();
              if (idx !== undefined) {
                toolCalls[idx].success = e.success;
                toolCalls[idx].summary = (e.summary ?? '').slice(0, 80);
              }
              break;
            }
            case 'agent:error':
              errors.push(`agent:error ${e.message ?? ''}`.slice(0, 200));
              break;
            case 'agent:turn_final':
              finalEvent = `stopReason=${e.stopReason ?? ''}`;
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

  canvas = normalizeCanvas(canvas);
  return { canvas, toolCalls, errors, messageText, patchOps, durationMs: Date.now() - t0, error, finalEvent };
}

// ---- shape-level diff ---------------------------------------------------------

function shapeDiff(before: CanvasDocument, after: CanvasDocument) {
  const b = new Map((before.shapes ?? []).map((s: Shape) => [s.id, s]));
  const a = new Map((after.shapes ?? []).map((s: Shape) => [s.id, s]));
  const added = [...a.keys()].filter((id) => !b.has(id));
  const removed = [...b.keys()].filter((id) => !a.has(id));
  const updated = [...a.keys()].filter((id) => {
    if (!b.has(id)) return false;
    const x = b.get(id)!;
    const y = a.get(id)!;
    return JSON.stringify(x) !== JSON.stringify(y);
  });
  return { added, removed, updated };
}

// ---- main --------------------------------------------------------------------

const T1 = 'Create a login form on a 420x320 white card centered on the canvas: an "Email" input field, a "Password" input field, and a blue "Log in" button below them.';
const T2 = 'Change the button label to "Sign in" and make the button full-width to match the input fields.';

const doc = createEmptyCanvasDocument(`repro-followup-${Date.now()}`, 'Repro Followup');
let canvas: CanvasDocument = doc;

console.log('=== TURN 1: build ===');
const r1 = await runTurn(doc.id, T1, canvas);
canvas = r1.canvas;
console.log(`  tools: ${r1.toolCalls.map((t) => t.name).join(', ') || '(none)'}`);
console.log(`  patches: ${r1.patchOps.length}, errors: ${r1.errors.length}, final: ${r1.finalEvent ?? '?'}`);
console.log(`  shapes after: ${(canvas.shapes ?? []).length}, duration: ${(r1.durationMs / 1000).toFixed(0)}s`);
if (r1.errors.length) console.log(`  ERRORS: ${r1.errors.join(' | ')}`);
if (r1.error) console.log(`  FATAL: ${r1.error}`);
console.log(`  message: ${r1.messageText.slice(0, 200).replace(/\n/g, ' ')}`);

console.log('\n=== TURN 2: follow-up edit ===');
const r2 = await runTurn(doc.id, T2, canvas);
console.log(`  tools: ${r2.toolCalls.map((t) => t.name).join(', ') || '(none)'}`);
console.log(`  patches: ${r2.patchOps.length}, errors: ${r2.errors.length}, final: ${r2.finalEvent ?? '?'}`);
console.log(`  shapes after: ${(r2.canvas.shapes ?? []).length}, duration: ${(r2.durationMs / 1000).toFixed(0)}s`);
if (r2.errors.length) console.log(`  ERRORS: ${r2.errors.join(' | ')}`);
if (r2.error) console.log(`  FATAL: ${r2.error}`);
console.log(`  message: ${r2.messageText.slice(0, 300).replace(/\n/g, ' ')}`);

const d = shapeDiff(canvas, r2.canvas);
console.log(`\n  follow-up diff: +${d.added.length} added, -${d.removed.length} removed, ~${d.updated.length} updated`);
if (d.removed.length) console.log(`  REMOVED node names: ${d.removed.map((id) => (canvas.shapes ?? []).find((s) => s.id === id)?.name ?? id).join(', ')}`);
if (d.added.length > 5) console.log(`  ADDED (first 8): ${d.added.map((id) => (r2.canvas.shapes ?? []).find((s) => s.id === id)?.name ?? id).slice(0, 8).join(', ')}`);

// Verdict heuristics
console.log('\n=== VERDICT ===');
const verdicts: string[] = [];
if (r2.error) verdicts.push('FATAL ERROR on follow-up turn');
if (r2.errors.length) verdicts.push(`stream errors on follow-up: ${r2.errors.length}`);
if (r2.toolCalls.length === 0 && !r2.messageText.trim()) verdicts.push('EMPTY follow-up turn (no tools, no message)');
if (d.removed.length > 3) verdicts.push(`follow-up REMOVED ${d.removed.length} nodes (possible canvas wipe/rebuild)`);
if (d.added.length > 3) verdicts.push(`follow-up ADDED ${d.added.length} nodes (possible rebuild instead of edit)`);
if (d.updated.length === 0 && d.added.length === 0 && d.removed.length === 0) verdicts.push('follow-up was a NO-OP');
if (verdicts.length === 0 && d.updated.length > 0) verdicts.push(`healthy edit: ${d.updated.length} nodes updated`);
console.log(verdicts.length ? verdicts.map((v) => `⚠ ${v}`).join('\n') : '✓ follow-up looks healthy');
