// resolve-capture.ts — resolve the captured document and print cell geometry.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolvePenTreeDetailed } from '../../../src/lib/pen/resolve';
import { normalizeCanvas } from '../../../src/lib/agent/runner-legacy';

const log = JSON.parse(readFileSync('scripts/research/oneshot-opt/capture-log.json', 'utf-8'));
const { createEmptyCanvasDocument } = await import('../../../src/lib/canvas/types');
const { applyPatchToCanvas } = await import('../../../src/lib/canvas/patch');

let doc: any = createEmptyCanvasDocument('eval-capture', 'Capture');
for (const entry of log) {
  if (entry.kind === 'patch') {
    try { doc = applyPatchToCanvas(doc, entry.patch); } catch { /* skip */ }
  }
}
const normalized = normalizeCanvas(doc);
const resolved = resolvePenTreeDetailed(normalized as any);
console.log('resolved layers:', resolved.layers.length);
const tableRoot = resolved.layers.find((l: any) => (l.name ?? '').includes('table'));
console.log('table root:', tableRoot?.name, 'x=', tableRoot?.x, 'y=', tableRoot?.y, 'w=', tableRoot?.width, 'h=', tableRoot?.height, 'autoLayout=', JSON.stringify((tableRoot as any)?.autoLayout));
for (const s of resolved.layers) {
  const nm = String((s as any).name ?? '');
  if (/^(r0 |header |Recent)/.test(nm)) {
    console.log(`  ${nm.padEnd(24)} x=${s.x} y=${s.y}`);
  }
}
console.log('warnings:', JSON.stringify((resolved as any).warnings?.slice(0, 10), null, 1).slice(0, 1200));
// Also dump the pen-tree root's autoLayout + the first few children.
const root = (normalized.children ?? [])[0];
console.log('pen root:', root?.name, 'autoLayout=', JSON.stringify(root?.autoLayout));
const kids = root?.children ?? [];
for (const k of kids.slice(0, 10)) {
  console.log(`  pen child ${(k.name ?? '').padEnd(24)} x=${k.x} y=${k.y} w=${k.width} h=${k.height} autoLayout=${JSON.stringify(k.autoLayout)}`);
}
writeFileSync('scripts/research/oneshot-opt/capture-resolved.json', JSON.stringify({ layers: resolved.layers.map((l: any) => ({ name: l.name, x: l.x, y: l.y, w: l.width, h: l.height })) }, null, 1));
