// tests/unit/repeated-structure-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateCanvasBeforeComplete } from '@/lib/agent/validators';
import type { Layer } from '@/lib/canvas/types';

let seq = 0;
function frame(name: string, x: number, opts?: { parentId?: string; componentId?: string }): Layer {
  return {
    id: `f${++seq}`, type: 'frame', name, x, y: 100, width: 200, height: 120,
    fill: '#ffffff', ...(opts?.parentId ? { parentId: opts.parentId } : {}),
    ...(opts?.componentId ? { componentId: opts.componentId } : {}),
  } as Layer;
}

describe('repeatedStructureWithoutComponents', () => {
  const opts = { relaxMinCount: true, repeatedStructures: { usedTemplateGeneration: false, componentToolsVisible: true } };

  it('fires on 3 identical non-ref siblings', () => {
    const shapes = [frame('KPI Card', 0), frame('KPI Card', 220), frame('KPI Card', 440), frame('Sidebar', 660)];
    const result = validateCanvasBeforeComplete(shapes, opts);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('repeated structures') && r.includes('component'))).toBe(true);
  });

  it('passes with 2 identical siblings (below threshold)', () => {
    const shapes = [frame('KPI Card', 0), frame('KPI Card', 220)];
    expect(validateCanvasBeforeComplete(shapes, opts).ok).toBe(true);
  });

  it('exempts component instances (refs)', () => {
    const shapes = [frame('KPI Card', 0, { componentId: 'c1' }), frame('KPI Card', 220, { componentId: 'c1' }), frame('KPI Card', 440, { componentId: 'c1' })];
    expect(validateCanvasBeforeComplete(shapes, opts).ok).toBe(true);
  });

  it('exempts template-generated turns', () => {
    const shapes = [frame('Card', 0), frame('Card', 220), frame('Card', 440)];
    expect(validateCanvasBeforeComplete(shapes, { relaxMinCount: true, repeatedStructures: { usedTemplateGeneration: true, componentToolsVisible: true } }).ok).toBe(true);
  });

  it('exempts when component tools were not visible', () => {
    const shapes = [frame('Card', 0), frame('Card', 220), frame('Card', 440)];
    expect(validateCanvasBeforeComplete(shapes, { relaxMinCount: true, repeatedStructures: { usedTemplateGeneration: false, componentToolsVisible: false } }).ok).toBe(true);
  });

  it('ignores text content and fills in the signature', () => {
    const a = frame('KPI Card', 0); (a as any).fill = '#ff0000';
    const b = frame('KPI Card', 220); (b as any).fill = '#00ff00';
    const shapes = [a, b, frame('KPI Card', 440)];
    expect(validateCanvasBeforeComplete(shapes, opts).ok).toBe(false);
  });
});
