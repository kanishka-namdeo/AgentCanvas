// test-composite-guard.ts — end-to-end verification of the composite-output
// auto-layout guard: create a table via pen_create_table (stamped), then try
// to re-flow it via pen_update_node / pen_apply_auto_layout / bulk update.
import { createEmptyCanvasDocument } from '../../../src/lib/canvas/types';
import { applyPatchToCanvas } from '../../../src/lib/canvas/patch';
import { normalizeCanvas } from '../../../src/lib/agent/runner-legacy';
import { createCanvasTools } from '../../../src/lib/agent/tools';

let doc: any = createEmptyCanvasDocument('guard-test', 'Guard Test');
const ctx = {
  getShapes: () => (normalizeCanvas(doc).shapes ?? []) as any[],
  getTokens: () => ({ colors: [], textStyles: [] }) as any,
  getDocument: () => doc,
  applyPatch: (p: any) => {
    doc = applyPatchToCanvas(doc, p);
    return p;
  },
};

const tools: any[] = createCanvasTools(ctx as any);
const byName = (n: string) => tools.find((t) => t.name === n);

const table = byName('pen_create_table');
const res = await table.execute('c1', {
  title: 'Recent Orders',
  columns: [{ header: 'Order' }, { header: 'Customer' }, { header: 'Date' }, { header: 'Status' }, { header: 'Amount' }],
  rows: [
    [{ text: 'ORD-1' }, { text: 'Alice' }, { text: 'Oct 24' }, { text: 'Paid', status: 'success' }, { text: '$120.50' }],
    [{ text: 'ORD-2' }, { text: 'Bob' }, { text: 'Oct 24' }, { text: 'Pending', status: 'warning' }, { text: '$85.00' }],
  ],
  x: 200, y: 52, width: 640,
}, undefined, undefined, ctx);
const frameId = res.details.frameId;
console.log('table created, frameId =', frameId);

// 1. pen_update_node with autoLayout changes → must REFUSE.
const upd = byName('pen_update_node');
const r1 = await upd.execute('c2', { nodeId: frameId, changes: { autoLayout: { direction: 'vertical', gap: 0, padding: 24 } } }, undefined, undefined, ctx);
console.log('update_node autoLayout ->', r1.isError ? 'REFUSED ✓' : 'ALLOWED ✗', '|', String(r1.content[0].text).slice(0, 90));

// 1b. pen_update_node with layout string → must REFUSE.
const r1b = await upd.execute('c2b', { nodeId: frameId, changes: { layout: 'vertical' } }, undefined, undefined, ctx);
console.log('update_node layout ->', r1b.isError ? 'REFUSED ✓' : 'ALLOWED ✗');

// 1c. pen_update_node with a CONTENT change (text color) → must ALLOW.
const shapes = ctx.getShapes();
const firstCell = shapes.find((s: any) => s.name === 'r0 c1');
const r1c = await upd.execute('c2c', { nodeId: firstCell.id, changes: { textColor: '#0f172a' } }, undefined, undefined, ctx);
console.log('update_node content ->', r1c.isError ? 'REFUSED ✗' : 'ALLOWED ✓');

// 2. pen_apply_auto_layout on the table root → must REFUSE.
const al = byName('pen_apply_auto_layout');
const r2 = await al.execute('c3', { frameId, direction: 'vertical' }, undefined, undefined, ctx);
console.log('apply_auto_layout ->', r2.isError ? 'REFUSED ✓' : 'ALLOWED ✗', '|', String(r2.content[0].text).slice(0, 90));

// 3. pen_bulk_update_by_filter with autoLayout → must REFUSE (blocked).
const bulk = byName('pen_bulk_update_by_filter');
const r3 = await bulk.execute('c4', { type: 'frame', changes: { autoLayout: { direction: 'vertical' } } }, undefined, undefined, ctx);
console.log('bulk_update autoLayout ->', r3.isError ? 'REFUSED ✓' : 'ALLOWED ✗', '|', String(r3.content[0].text).slice(0, 90));

// 4. Verify geometry survived: resolve and check cell x positions.
const norm = normalizeCanvas(doc);
const cells = (norm.shapes ?? []).filter((s: any) => s.name === 'r0 c1' || s.name === 'r0 c2');
for (const c of cells) console.log(`  ${c.name} x=${c.x} y=${c.y}`);
const distinctX = new Set(cells.map((c: any) => Math.round((c.x ?? 0) / 8))).size;
console.log('cells at distinct columns:', distinctX >= 2 ? 'YES ✓ (layout intact)' : 'NO ✗ (re-flowed!)');
