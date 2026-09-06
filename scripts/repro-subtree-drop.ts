#!/usr/bin/env bun
// repro-subtree-drop.ts — extract the add_subtree patch from the journal and
// apply it to a fresh doc to see whether nested children resolve.

import { db } from '@/lib/db';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';

const docId = process.argv[2] ?? 'e2e-oneshot-login-1788705112527';

const rows = await db.agentEvent.findMany({
  where: { documentId: docId, type: 'patch' },
  orderBy: { seq: 'asc' },
});
console.log(`patch rows: ${rows.length}`);
const patchRows = rows.map((r) => {
  const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
  return (p.patch ?? p) as CanvasPatch;
});

let canvas: CanvasDocument = {
  id: 'repro', name: 'Repro', background: '#ffffff', version: '2.17',
  children: [], viewport: { zoom: 1, panX: 0, panY: 0 },
  shapes: [], tokens: { colors: [], textStyles: [] },
} as CanvasDocument;

for (const p of patchRows) {
  console.log(`\n=== applying op=${p.op} ===`);
  const before = (canvas.shapes ?? []).length;
  canvas = applyPatchToCanvas(canvas, p);
  console.log(`shapes ${before} -> ${(canvas.shapes ?? []).length}, children(top) = ${(canvas.children ?? []).length}`);
}

const subtree = patchRows.find((p: any) => p.op === 'add_subtree') as any;
if (subtree) {
  const raw = subtree.shape;
  const countNodes = (n: any): number => 1 + (n.children ?? []).reduce((a: number, c: any) => a + countNodes(c), 0);
  console.log(`\nraw subtree node count (recursive): ${countNodes(raw)}`);
  const flatNames = (n: any, d = 0): void => {
    console.log(`${'  '.repeat(d)}- ${n.type} "${n.name}"${n.height !== undefined ? ` h=${JSON.stringify(n.height)}` : ''}`);
    for (const c of n.children ?? []) flatNames(c, d + 1);
  };
  flatNames(raw);
}

console.log(`\nRESOLVED shapes (${(canvas.shapes ?? []).length}):`);
for (const s of canvas.shapes ?? []) console.log(`  ${s.type} "${s.name}" ${(s as any).width}x${(s as any).height}`);

// Also dump the resolved children tree
const dumpTree = (n: any, d = 0): void => {
  console.log(`${'  '.repeat(d)}· ${n.type} "${n.name}"`);
  for (const c of n.children ?? []) dumpTree(c, d + 1);
};
console.log('\nRESOLVED children tree:');
for (const c of canvas.children ?? []) dumpTree(c);
process.exit(0);
