// capture-patches.ts — run ONE prompt through /api/agent and record every
// streamed patch + tool event, then bisect which patch first moves a target
// node's x. Diagnostic for the data-table vertical re-flow.
// Usage: bun scripts/research/oneshot-opt/capture-patches.ts

import { writeFileSync } from 'node:fs';
import { createEmptyCanvasDocument } from '../../../src/lib/canvas/types';
import { applyPatchToCanvas } from '../../../src/lib/canvas/patch';
import { DEFAULT_SETTINGS } from '../../../src/lib/settings/types';

const API = 'http://localhost:3000/api/agent';
const PROMPT =
  "Design a high-fidelity 'Recent Orders' table card with columns Order, Customer, Date, Status, Amount and 4 data rows with realistic values, status shown as color-coded text or badges.";

const canvas = createEmptyCanvasDocument('eval-capture', 'Capture');
const log: any[] = [];

const res = await fetch(API, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    documentId: canvas.id,
    prompt: PROMPT,
    canvasState: canvas,
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
  console.error('API error', res.status, await res.text());
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
let n = 0;
outer: while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'patch' && ev.patch) {
      log.push({ seq: n++, kind: 'patch', patch: ev.patch });
    } else if (ev.type === 'agent_event' && ev.event) {
      const e = ev.event;
      if (e.type === 'agent:tool_call_end') log.push({ seq: n++, kind: 'tool_end', name: e.toolName, success: e.success, summary: (e.summary ?? '').slice(0, 120) });
      else if (e.type === 'agent:tool_call_start') log.push({ seq: n++, kind: 'tool_start', name: e.toolName });
      else if (e.type === 'agent:error') log.push({ seq: n++, kind: 'error', message: (e.message ?? '').slice(0, 200) });
      else if (e.type === 'agent:turn_end') { log.push({ seq: n++, kind: 'turn_end' }); break outer; }
    }
  }
}

writeFileSync('scripts/research/oneshot-opt/capture-log.json', JSON.stringify(log, null, 1));

// Bisect: track a 'r0 c1'-ish cell across patches.
let doc: any = canvas;
const snapshots: Array<{ seq: number; tool: string; c1x: number | null }> = [];
let lastTool = '(initial)';
for (const entry of log) {
  if (entry.kind === 'tool_start') lastTool = entry.name;
  if (entry.kind === 'patch') {
    try { doc = applyPatchToCanvas(doc, entry.patch); } catch { /* skip */ }
    const flat: any[] = [];
    const walk = (nodes: any[]) => { for (const nd of nodes) { flat.push(nd); if (nd.children) walk(nd.children); } };
    walk(doc.children ?? []);
    const c1 = flat.find((f) => f.name === 'r0 c1');
    snapshots.push({ seq: entry.seq, tool: lastTool, c1x: c1 ? (c1.x ?? null) : null });
  }
}
console.log('cell r0 c1 x across patches (first change = culprit):');
let prev: number | null | undefined;
for (const s of snapshots) {
  if (s.c1x !== prev) {
    console.log(`  seq ${String(s.seq).padStart(3)} ${s.tool.padEnd(28)} x=${s.c1x}`);
    prev = s.c1x;
  }
}
