import { createCanvasTools, executeTool } from '@/lib/agent/tools';
import type { CanvasToolContext } from '@/lib/agent/tools';
import type { CanvasDocument } from '@/lib/canvas/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';

const doc: CanvasDocument = {
  id: 'doc-repro', name: 'T', background: '#ffffff', version: '2.17',
  children: [], viewport: { zoom: 1, panX: 0, panY: 0 },
  shapes: [], tokens: { colors: [], textStyles: [] },
};
const ctx: CanvasToolContext = {
  getShapes: () => doc.shapes,
  getTokens: () => doc.tokens,
  getDocument: () => doc,
  applyPatch: (p) => {
    const next = applyPatchToCanvas(doc, p);
    doc.shapes = next.shapes; doc.children = next.children;
  },
} as CanvasToolContext;

const tools = createCanvasTools(ctx);
const run = (name: string, args: Record<string, unknown>) => executeTool(tools, name, args);
const find = (name: string) => doc.shapes.find((s) => s.name === name)!;

await run('pen_create_subtree', {
  nodes: [{
    type: 'frame', name: 'Screen', x: 0, y: 0, width: 375, height: 812, fill: '#f8fafc',
    children: [
      { type: 'rectangle', name: 'Sign In Button', fill: '#ffffff', width: 311, height: 48 },
      { type: 'text', name: 'Sign In Text', text: 'Sign In', fontSize: 16, textColor: '#0f172a' },
    ],
  }],
});
console.log('created, shapes:', doc.shapes.length);
console.log('initial btn fill:', find('Sign In Button').fill);

const btnId = find('Sign In Button').id;
const u = await run('pen_update_node', { shapeId: btnId, changes: { fill: '#0ea5e9' } });
console.log('update ok:', !u.isError, '→ btn fill now:', find('Sign In Button').fill);

const b = await run('pen_bulk_update_by_filter', { changes: { textColor: '#ffffff' } });
console.log('bulk ok:', !b.isError, '→ btn fill still:', find('Sign In Button').fill, '| textColor:', find('Sign In Button').textColor);
console.log('text layer textColor:', find('Sign In Text').textColor);
