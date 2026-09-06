#!/usr/bin/env bun
// diagnose-fill.ts — trace how fill_container widths resolve through the
// Screen > Content > StatsRow chain of the failing dashboard patch.

import { db } from '@/lib/db';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { resolvePenTreeDetailed } from '@/lib/pen/resolve';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';

const docId = process.argv[2] ?? 'e2e-oneshot-dashboard-1788707369341';

const rows = await db.agentEvent.findMany({ where: { documentId: docId, type: 'patch' }, orderBy: { seq: 'asc' } });
const patches = rows.map((r) => {
  const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
  return (p.patch ?? p) as CanvasPatch;
});

let canvas: CanvasDocument = {
  id: 'diag', name: 'Diag', background: '#ffffff', version: '2.17',
  children: [], viewport: { zoom: 1, panX: 0, panY: 0 },
  shapes: [], tokens: { colors: [], textStyles: [] },
} as CanvasDocument;
for (const p of patches) canvas = applyPatchToCanvas(canvas, p);

const { layers, warnings } = resolvePenTreeDetailed(canvas);
console.log('--- resolved widths along the chain ---');
for (const name of ['Screen', 'Navbar', 'Content', 'StatsRow', 'ChartArea', 'RecentActivity', 'StatCard1', 'StatCard2']) {
  const s = layers.find((l: any) => l.name === name);
  if (s) console.log(`${name.padEnd(16)} w=${s.width} h=${s.height} x=${(s as any).x} type=${s.type}`);
}
console.log('--- warnings (first 8) ---');
for (const w of warnings.slice(0, 8)) console.log(w.kind, '|', String(w.message).slice(0, 140));
console.log(`total warnings: ${warnings.length}, total layers: ${layers.length}`);
process.exit(0);
