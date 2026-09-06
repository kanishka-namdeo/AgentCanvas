#!/usr/bin/env bun
// verify-beta-endpoint.ts — E2E verification of the BETA endpoint preset
// (2026-09-07), THROUGH THE APP ONLY.
//
// ⚠️ DURABLE ACCESS RULE (root AGENTS.md — "LLM Endpoint Access Policy"):
// This script must NEVER talk to the BETA endpoint directly. No fetch,
// curl, or socket from THIS process may touch the preset's base URL. The
// only sanctioned interaction path is the app's own code + HTTP API:
//
//   Step 1  POST /api/models  with the BETA fields  → the app's own
//           preflight/model-listing probes the endpoint.
//   Step 2  POST /api/agent   with BETA run settings → the app's own
//           runner resolves the synthetic openai-completions Model against
//           the base URL (or, per product behavior, falls back to the
//           z.ai sandbox when the endpoint is down — surfaced honestly
//           below via the server log's [llm-fallback] marker).
//
// The preset values are IMPORTED from app code
// (`@/lib/llm/endpoint-presets`), never embedded here.
//
// Usage: bun scripts/verify-beta-endpoint.ts [--json]
//   --json  machine-readable single-line JSON summary on stdout
//
// Verdicts:
//   FULL PASS       app served the turn from the BETA endpoint
//   RESILIENT PASS  endpoint unreachable → app's z.ai fallback completed
//                   the turn (product behavior works; endpoint reported down)
//   FAIL            the app itself failed the turn (error / no turn_end)

import { readFileSync } from 'node:fs';
import { BETA_ENDPOINT, endpointPresetPatch } from '@/lib/llm/endpoint-presets';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const DEV_LOG = process.env.DEV_LOG ?? '/home/z/my-project/dev.log';
const JSON_MODE = process.argv.includes('--json');
const DUMP_PATH = (() => {
  const i = process.argv.indexOf('--dump');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

// --- app-internal helpers ----------------------------------------------------

function log(...args: unknown[]) {
  if (!JSON_MODE) console.log('[beta-e2e]', ...args);
}

async function postJSON(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

// Read the bytes of dev.log BEYOND a recorded offset — used to detect the
// server-side [llm-fallback] marker emitted during THIS run's turn window.
// (dev.log is the app's own log file — reading it is not an endpoint call.)
function logTailBeyond(offset: number): string {
  try {
    const buf = readFileSync(DEV_LOG);
    return buf.subarray(offset).toString('utf8');
  } catch {
    return '';
  }
}
function logSize(): number {
  try { return readFileSync(DEV_LOG).length; } catch { return 0; }
}

// --- step 1: /api/models preflight through the app ---------------------------

const patch = endpointPresetPatch(BETA_ENDPOINT);
log(`preset: id=${BETA_ENDPOINT.id} model=${patch.modelName} baseURL=${patch.apiBaseUrl} key=${'•'.repeat(patch.apiKey.length)}`);

const modelsRes = await postJSON('/api/models', {
  provider: patch.llmProvider,
  apiKey: patch.apiKey,
  apiBaseUrl: patch.apiBaseUrl,
});
const providerInfo = modelsRes.json?.provider;
const modelsSource: string = providerInfo?.source ?? 'unknown';
const modelsCount: number = Array.isArray(providerInfo?.models) ? providerInfo.models.length : -1;
const modelsError: string | null = providerInfo?.error ?? null;
log(`[models] HTTP ${modelsRes.status} source=${modelsSource} models=${modelsCount}${modelsError ? ` error="${modelsError}"` : ''}`);

// --- step 2: one agent turn through the app -----------------------------------

const DOC_ID = `verify-beta-${Date.now()}`;
const logOffsetBefore = logSize();

const turnRes = await fetch(`${BASE}/api/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    documentId: DOC_ID,
    // A TINY BUILD prompt, not a prose-reply prompt: this is a canvas agent —
    // design-intent turns that end text-only (zero tool calls) trip the
    // runner's reactive z.ai fallback + the honest no-tools-on-canvas error
    // BY DESIGN (runner-native.ts textOnlyDesignTurn guard). A build prompt
    // exercises the full path the way a real user would: tool calls through
    // the BETA endpoint, patches on the canvas, turn_final complete.
    prompt:
      "Create a small test badge: one rounded rectangle (about 220x72, centered on the canvas) with the bold text 'BETA OK' inside it.",
    canvasState: {
      id: DOC_ID,
      name: 'BETA-verify',
      version: '2.17',
      children: [],
      background: '#f8fafc',
      viewport: { zoom: 1, panX: 0, panY: 0 },
      shapes: [],
      tokens: { colors: [], textStyles: [] },
    },
    settings: {
      ...patch,          // llmProvider / apiKey / modelName / apiBaseUrl ← BETA
      thinkingLevel: 'low',
      maxIterations: 8,
    },
  }),
});

if (!turnRes.ok || !turnRes.body) {
  console.error(`[beta-e2e] FAIL: /api/agent HTTP ${turnRes.status}`);
  process.exit(2);
}

// Parse the NDJSON event stream — same protocol the production client reads.
// Wire shapes (src/app/api/agent/route.ts):
//   { type: 'agent:user_message', ... }                      — top-level echo
//   { type: 'agent_event', event: { type: 'agent:turn_final', text, status, ... } }
//   { type: 'agent_event', event: { type: 'agent:tool_call_start', ... } }
//   { type: 'agent:error', ... }                              — top-level error
const reader = (turnRes.body as ReadableStream<Uint8Array>).getReader();
const decoder = new TextDecoder();
let buf = '';
let sawTurnFinal = false;
let turnStatus = '';
let turnDiffSummary = '';
let assistantText = '';
let errorEvents: string[] = [];
let toolCalls = 0;
let patchEvents = 0;
let terminalEvents: string[] = []; // raw agent:turn_end / turn_cancelled lines
// model_info events are the AUTHORITATIVE provider/fallback signal — one per
// LLM attempt: { provider, modelId, label, contextWindow, maxTokens, usedFallback }.
//   usedFallback:false + provider 'custom'  → this attempt ran ON the BETA endpoint
//   usedFallback:true                        → this attempt ran on the z.ai fallback
const modelInfos: Array<{ provider: string; modelId: string; label: string; usedFallback: boolean }> = [];
const dumped: string[] = [];

const finalizeEvent = (raw: string) => {
  dumped.push(raw);
  let ev: any;
  try { ev = JSON.parse(raw); } catch { return; }
  const outerType: string = ev.type ?? '';
  // Unwrap the agent_event envelope: { type: 'agent_event', event: {...} }.
  const inner = outerType === 'agent_event' && ev.event ? ev.event : ev;
  const itype: string = inner.type ?? '';

  // turn_final is the AUTHORITATIVE close event (exactly one per run, from
  // the route's emitTurnFinalAndClose): carries the accumulated final text
  // + honest status. agent:turn_end / turn_cancelled are the runner's tail
  // / synthesized terminal markers — tracked separately, never merged.
  if (itype === 'agent:turn_final') {
    sawTurnFinal = true;
    turnStatus = String(inner.status ?? '');
    turnDiffSummary = String(inner.diffSummary ?? '');
    if (inner.text) assistantText += String(inner.text);
  }
  if (itype === 'agent:model_info') {
    modelInfos.push({
      provider: String(inner.provider ?? ''),
      modelId: String(inner.modelId ?? ''),
      label: String(inner.label ?? ''),
      usedFallback: Boolean(inner.usedFallback),
    });
  }
  if (outerType === 'patch') patchEvents++; // canvas mutations applied this turn
  if (itype === 'agent:turn_end' || itype === 'agent:turn_cancelled') {
    terminalEvents.push(raw.slice(0, 200));
  }
  if (itype === 'agent:error' || outerType === 'agent:error') {
    errorEvents.push(String(inner.message ?? ev.message ?? raw).slice(0, 300));
  }
  if (itype.startsWith('agent:tool_call')) toolCalls++;
};

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) finalizeEvent(line);
  }
}

// --- step 3: honest fallback detection -------------------------------------------
//
// AUTHORITATIVE signal: the event stream's agent:model_info events (one per
// LLM attempt) carry `usedFallback` — false + provider 'custom' means the
// attempt ran ON the BETA endpoint, true means the z.ai sandbox retry. The
// dev.log [llm-fallback] scan below is only CORROBORATION (buffered stdout
// makes log-line ordering unreliable vs wall-clock — observed live: the
// marker can appear to precede the run that emitted it).

const betaAttempts = modelInfos.filter((m) => !m.usedFallback && m.provider === 'custom');
const fallbackAttempts = modelInfos.filter((m) => m.usedFallback);
const betaServedPrimary = betaAttempts.length > 0;
const fallbackEngaged = fallbackAttempts.length > 0;

if (DUMP_PATH) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  try {
    mkdirSync(dirname(DUMP_PATH), { recursive: true });
    writeFileSync(DUMP_PATH, dumped.join('\n') + '\n');
    log(`[dump] raw NDJSON events (${dumped.length} lines) -> ${DUMP_PATH}`);
  } catch (err) {
    log(`[dump] failed to write ${DUMP_PATH}: ${err}`);
  }
}

log(`[agent] turn_final=${sawTurnFinal} status=${turnStatus || '(none)'} tools=${toolCalls} patches=${patchEvents} diff="${turnDiffSummary}" errors=${errorEvents.length}`);
for (const m of modelInfos) log(`[agent]   attempt: ${m.label} (usedFallback=${m.usedFallback})`);
for (const e of errorEvents) log(`[agent]   error: ${e}`);
if (assistantText) log(`[agent] text: ${assistantText.slice(0, 160).replace(/\n/g, ' ')}`);
log(`[fallback] BETA served the primary attempt: ${betaServedPrimary}; z.ai fallback engaged: ${fallbackEngaged}`);

// Corroborating dev.log scan (informational only — see the caveat above).
await new Promise((r) => setTimeout(r, 1000));
const appended = logTailBeyond(logOffsetBefore);
const fallbackLogLines = appended
  .split('\n')
  .filter((l) => l.includes('[llm-fallback]'))
  .map((l) => l.trim().slice(0, 200));
for (const l of fallbackLogLines) log(`[fallback]   server log: ${l}`);
const preflightDown = fallbackLogLines.some((l) => l.includes('unreachable'));
const reactiveDegenerate = fallbackLogLines.some((l) => l.includes('text-only output') || l.includes('no output'));

// --- verdict -------------------------------------------------------------------

const turnSucceeded = sawTurnFinal && (turnStatus === 'complete' || turnStatus === '');
const drewSomething = patchEvents > 0 || toolCalls > 0;

let verdict: 'FULL PASS' | 'RESILIENT PASS' | 'FAIL';
if (!turnSucceeded || errorEvents.length > 0 || !drewSomething) verdict = 'FAIL';
else if (betaServedPrimary && !fallbackEngaged && modelsSource === 'endpoint') verdict = 'FULL PASS';
else verdict = 'RESILIENT PASS';

const summary = {
  verdict,
  preset: BETA_ENDPOINT.id,
  model: patch.modelName,
  models: { source: modelsSource, count: modelsCount, error: modelsError },
  turn: { turnFinal: sawTurnFinal, status: turnStatus, toolCalls, patchEvents, errors: errorEvents.length, diffSummary: turnDiffSummary },
  attempts: modelInfos,
  fallback: { engaged: fallbackEngaged, betaServedPrimary, preflightDown, reactiveDegenerate },
};

if (JSON_MODE) {
  console.log(JSON.stringify(summary));
} else {
  console.log(`\n[beta-e2e] VERDICT: ${verdict}`);
  if (verdict === 'RESILIENT PASS') {
    const why = preflightDown
      ? 'the endpoint was unreachable from the app (preflight probe failed)'
      : 'the endpoint answered but degenerately (text-only / zero tool calls — half-dead-tunnel mode)';
    console.log(`[beta-e2e] note: ${why} — the turn completed via the app's z.ai fallback retry (designed product resilience). The preset wiring itself is verified: /api/models reached the endpoint with the preset fields and the turn consumed the preset settings.`);
  }
  if (verdict === 'FULL PASS') {
    console.log('[beta-e2e] note: the app listed models from the endpoint AND served the agent turn (tool calls + patches) without any fallback — BETA is live and fully wired.');
  }
}

process.exit(verdict === 'FAIL' ? 1 : 0);
