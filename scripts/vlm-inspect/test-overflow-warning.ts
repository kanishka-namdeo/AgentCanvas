// test-overflow-warning.ts — verify the container_overflow resolver warning
// fires for a fixed-height container whose children overflow, and does NOT
// fire for a fit_content container.
import { resolvePenTreeDetailed } from '../../src/lib/pen/resolve';
import type { PenChild } from '../../src/lib/pen/types';

function textNode(name: string, content: string, opts: Partial<PenChild> = {}): any {
  return { type: 'text', name, content, fontSize: 14, ...opts };
}

// Fixed-height panel (420) with ~700px of children → should warn.
const fixedPanel: any = {
  type: 'frame', name: 'Fixed Panel', x: 100, y: 100, width: 480, height: 420,
  layout: 'vertical', gap: 16, padding: 24,
  children: [
    textNode('Title', 'Account Settings', { fontSize: 24 }),
    textNode('Label1', 'Display Name'),
    { type: 'rectangle', name: 'Input1', width: 400, height: 48 },
    textNode('Label2', 'Email Address'),
    { type: 'rectangle', name: 'Input2', width: 400, height: 48 },
    textNode('Section', 'Notifications'),
    textNode('Row1', 'Email updates'),
    { type: 'frame', name: 'Toggle1', width: 48, height: 28 },
    textNode('Row2', 'Product news'),
    { type: 'frame', name: 'Toggle2', width: 48, height: 28 },
    { type: 'frame', name: 'Button', width: 120, height: 40, children: [textNode('BtnLabel', 'Save Changes')] },
  ],
};

// fit_content panel → should NOT warn.
const hugPanel: any = { ...fixedPanel, name: 'Hug Panel', height: 'fit_content' };

const doc: any = { id: 't', name: 't', children: [fixedPanel, hugPanel], shapes: [] };

const result = resolvePenTreeDetailed(doc as any);
console.log('warnings:');
for (const w of result.warnings) console.log(`  [${w.kind}] ${w.message.slice(0, 130)}`);
const overflow = result.warnings.filter((w) => w.kind === 'container_overflow');
console.log(`\ncontainer_overflow fired: ${overflow.length === 1 ? 'YES (fixed) / ' : ''}${overflow.length} time(s)`);
console.log(overflow.length === 1 ? 'PASS' : 'FAIL');
