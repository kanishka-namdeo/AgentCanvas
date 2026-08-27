// Reproduce: does add_subtree preserve fontSize on NESTED text nodes?
// Extract the actual subtree payload from the perf-pass kanban tap, apply it,
// resolve, and inspect the text layers' fontSize.
import { readFileSync } from 'node:fs';
import { applyPatchToCanvas } from '../../src/lib/canvas/patch';
import { resolvePenTree } from '../../src/lib/pen/resolve';
import type { CanvasDocument } from '../../src/lib/canvas/types';

const lines = readFileSync('download/vlm-exercise/perf-pass/tap-events/os-kanban-t1.jsonl', 'utf-8').split('\n');
const patches: any[] = [];
for (const line of lines) {
  try {
    const e = JSON.parse(line);
    const ev = e.event ?? {};
    if (ev.type === 'canvas:patch' && ev.patch) {
      patches.push(ev.patch);
    }
  } catch {}
}
console.log(`replaying ${patches.length} patches…`);
const doc: CanvasDocument = {
  id: 'd', name: 'T', background: '#ffffff', version: '2.17',
  children: [], viewport: { zoom: 1, panX: 0, panY: 0 },
  shapes: [], tokens: { colors: [], textStyles: [] },
} as any;
let next: any = doc;
for (const p of patches) {
  try {
    next = applyPatchToCanvas(next, p);
  } catch (err: any) {
    console.log('  patch failed:', p.op, err?.message);
  }
}
const layers = resolvePenTree(next).layers ?? (resolvePenTree(next) as any);
const list = Array.isArray(layers) ? layers : layers.layers;
const texts = (list as any[]).filter((l: any) => l.type === 'text');
console.log(`FINAL text layers: ${texts.length}`);
for (const t of texts.slice(0, 16)) {
  console.log(`  "${String(t.characters ?? t.text ?? '').slice(0, 28)}" fontSize=${t.fontSize} w=${Math.round(t.width)} h=${Math.round(t.height)} x=${Math.round(t.x)} y=${Math.round(t.y)}`);
}
// Column header positions (To Do / In Progress / Done) in the FINAL state
for (const t of texts) {
  const label = String(t.characters ?? t.text ?? '');
  if (['To Do', 'In Progress', 'Done'].includes(label)) {
    console.log(`COLUMN "${label}" x=${Math.round(t.x)} y=${Math.round(t.y)}`);
  }
}
