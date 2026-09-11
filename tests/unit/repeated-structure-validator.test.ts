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
function childShape(type: string, parentId: string, x: number, y: number, extra?: Record<string, unknown>): Layer {
  return {
    id: `c${++seq}`, type, name: type, x, y, width: 40, height: 24, parentId,
    ...(extra ?? {}),
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

  it('ignores names and text content in the signature', () => {
    const mk = (name: string, label: string, x: number) => {
      const parent = frame(name, x);
      return [parent, childShape('text', parent.id, 10, 5, { text: label })];
    };
    const shapes = [...mk('Alpha', 'Revenue', 0), ...mk('Beta', 'Users', 220), ...mk('Gamma', 'Conversion', 440)];
    const result = validateCanvasBeforeComplete(shapes, opts);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('repeated structures') && r.includes('component'))).toBe(true);
  });

  it('stabilizes child order by x then y (mirrored creation order → same signature)', () => {
    // Same child types at consistent positions; the shapes ARRAY order is
    // mirrored between parents. The signature must normalize children via
    // x-then-y, so all three parents share one signature and the rule fires.
    // The third parent also uses equal-x children (y tiebreak) at different
    // coordinates, proving geometry values never enter the signature.
    const mk = (x: number, textFirst: boolean, sameX: boolean) => {
      const parent = frame('Row', x);
      const t = childShape('text', parent.id, 10, 5);
      const r = childShape('rectangle', parent.id, sameX ? 10 : 60, sameX ? 30 : 0);
      return textFirst ? [parent, t, r] : [parent, r, t];
    };
    const shapes = [...mk(0, true, false), ...mk(220, false, false), ...mk(440, false, true)];
    const result = validateCanvasBeforeComplete(shapes, opts);
    expect(result.reasons.some((r) => r.includes('repeated structures'))).toBe(true);
  });

  it('exempts a mixed bucket (1 instance + 2 bespoke copies)', () => {
    const shapes = [
      frame('KPI Card', 0, { componentId: 'c1' }),
      frame('KPI Card', 220),
      frame('KPI Card', 440),
    ];
    expect(validateCanvasBeforeComplete(shapes, opts).ok).toBe(true);
  });

  it('counts descendant componentId too (documented sibling-level deviation)', () => {
    // Deliberate leniency (see validators.ts Rule 8 comment): an instance
    // anywhere in a sibling's subtree exempts the bucket — pins the
    // no-false-positive direction so the deviation cannot silently regress.
    const mk = (x: number) => {
      const parent = frame('KPI Card', x);
      return [parent, childShape('frame', parent.id, 10, 5, { componentId: 'c1' })];
    };
    const shapes = [...mk(0), ...mk(220), ...mk(440)];
    const result = validateCanvasBeforeComplete(shapes, opts);
    expect(result.reasons.some((r) => r.includes('repeated structures'))).toBe(false);
  });

  it('ignores fills and geometry values in the signature', () => {
    const a = frame('KPI Card', 0); (a as any).fill = '#ff0000';
    const b = frame('KPI Card', 220); (b as any).fill = '#00ff00';
    const shapes = [a, b, frame('KPI Card', 440)];
    expect(validateCanvasBeforeComplete(shapes, opts).ok).toBe(false);
  });
});
