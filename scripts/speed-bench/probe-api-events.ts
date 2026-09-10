// probe-api-events.ts — Dump one agent turn's event-type sequence to stdout.
// Used to validate that the bench script's event detection matches reality.
//
// Usage: bun scripts/speed-bench/probe-api-events.ts "your prompt here"

const prompt = process.argv[2] ?? 'Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.';

import { createEmptyCanvasDocument } from '../../src/lib/canvas/types';
import { DEFAULT_SETTINGS } from '../../src/lib/settings/types';
import { normalizeCanvas } from '../../src/lib/agent/runner-legacy';

const canvas = normalizeCanvas(createEmptyCanvasDocument());

const body = {
  prompt,
  canvas,
  settings: { ...DEFAULT_SETTINGS, llmProvider: 'zai', thinkingLevel: 'low' },
  images: [],
  selection: { nodeIds: [], mode: 'replace' },
  sessionId: `probe-${Date.now()}`,
  runId: `probe-run-${Date.now()}`,
  userMessageId: `probe-um-${Date.now()}`,
  assistantMessageId: `probe-am-${Date.now()}`,
  canvasDelta: null,
};

const t0 = Date.now();
const res = await fetch('http://localhost:3000/api/agent', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

console.log('status:', res.status);
if (!res.body) { console.log('no body'); process.exit(1); }

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
let evCount = 0;
const evTypeHistogram = new Map<string, number>();

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    evCount++;
    const t = ev.type ?? '(?)';
    evTypeHistogram.set(t, (evTypeHistogram.get(t) ?? 0) + 1);
    // Show first 60 events with detail, then just histogram updates
    if (evCount <= 60) {
      const detail = t === 'patch' ? ` patch.toolCallId=${ev.patch?.toolCallId ?? '-'} ops=${ev.patch?.ops?.length ?? 0}` : '';
      const innerType = ev.event?.type ?? '';
      const innerDetail = innerType ? ` inner.type=${innerType}${ev.event?.toolName ? ' tool=' + ev.event.toolName : ''}${ev.event?.model ? ' model=' + ev.event.model : ''}` : '';
      console.log(`+${String(Date.now() - t0).padStart(6)}ms  ev#${evCount}  type=${t}${detail}${innerDetail}`);
    }
  }
}

console.log('---');
console.log(`total events: ${evCount}  in ${Date.now() - t0}ms`);
console.log('histogram:');
for (const [t, n] of [...evTypeHistogram.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(40)} ${n}`);
}
