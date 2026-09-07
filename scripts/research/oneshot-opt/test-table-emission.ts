// test-table-emission.ts — isolate pen_create_table geometry.
// Calls the tool directly against a fabricated canvas ctx, applies the patch,
// resolves the document, and prints the resulting cell geometry.
// Usage: bun scripts/research/oneshot-opt/test-table-emission.ts

import { createEmptyCanvasDocument } from '../../../src/lib/canvas/types';
import { applyPatchToCanvas } from '../../../src/lib/canvas/patch';
import { resolvePenTreeDetailed } from '../../../src/lib/pen/resolve';
import { createCanvasTools } from '../../../src/lib/agent/tools';

const doc = createEmptyCanvasDocument('test-table');
const patches: any[] = [];
const ctx = {
  getShapes: () => [] as any[],
  getTokens: () => ({ colors: [], textStyles: [] }) as any,
  getDocument: () => doc,
  applyPatch: (p: any) => {
    patches.push(p);
    applyPatchToCanvas(doc, p);
    return p;
  },
};

const tools = createCanvasTools(ctx as any);
const table = tools.find((t: any) => t.name === 'pen_create_table')!;
const setShadow = tools.find((t: any) => t.name === 'pen_set_shadow');

const res = await (table as any).execute('call-1', {
  title: 'Recent Orders',
  columns: [
    { header: 'Order' },
    { header: 'Customer' },
    { header: 'Date' },
    { header: 'Status' },
    { header: 'Amount', align: 'right' },
  ],
  rows: [
    [{ text: 'ORD-7829' }, { text: 'Alice Smith' }, { text: 'Oct 24' }, { text: 'Completed', status: 'success' }, { text: '$120.50' }],
    [{ text: 'ORD-7830' }, { text: 'Bob Jones' }, { text: 'Oct 24' }, { text: 'Processing', status: 'warning' }, { text: '$85.00' }],
  ],
  x: 200,
  y: 52,
  width: 640,
}, undefined, undefined, ctx);

console.log('=== RAW patch children (first 12) ===');
const kids: any[] = res.details.patch.shape.children;
for (const k of kids.slice(0, 12)) {
  console.log(`  ${(k.name as string).padEnd(22)} x=${k.x} y=${k.y} w=${k.width} autoLayout=${JSON.stringify(k.autoLayout) ?? '-'}`);
}
console.log('root autoLayout:', JSON.stringify((res.details.patch.shape as any).autoLayout));

console.log('doc.children:', (doc as any).children?.length, 'doc.shapes:', (doc as any).shapes?.length);
console.log('=== RESOLVED (after add_subtree only) ===');
let resolved = resolvePenTreeDetailed(doc);
const printCells = (label: string) => {
  console.log(label);
  console.log('  total layers:', resolved.layers.length);
  for (const s of resolved.layers.slice(0, 14)) {
    console.log(`  ${String((s as any).name ?? s.id).padEnd(24)} x=${s.x} y=${s.y} w=${s.width}`);
  }
  console.log('  warnings:', JSON.stringify((resolved as any).warnings?.slice(0, 8)));
};
printCells('-- cells --');

// Now apply a pen_set_shadow call the way the model does and re-check.
if (setShadow) {
  const frameId = res.details.frameId;
  try {
    await (setShadow as any).execute('call-2', { nodeId: frameId, x: 0, y: 2, blur: 6, color: '#00000022' }, undefined, undefined, ctx);
    resolved = resolvePenTreeDetailed(doc);
    printCells('=== RESOLVED (after pen_set_shadow) ===');
  } catch (e) {
    console.log('set_shadow failed:', (e as Error).message);
  }
}
