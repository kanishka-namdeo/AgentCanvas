// Tests for canvasSnapshot measured-bounds enrichment (spec §5.5 — M2-c).
//
// canvasSnapshot (runner-legacy.ts) appends ` measured=<w>×<h>` to a layer's
// line when the server-side measured-bounds map (client-roundtrip.ts, fed by
// the DOM renderer's canvas:measured_bounds push) has an entry for that
// layer id — so the agent's mental model stops diverging from pixels.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { canvasSnapshot } from '@/lib/agent/runner-legacy';
import { setMeasuredBounds, __resetClientRoundtripForTests } from '@/lib/agent/client-roundtrip';
import type { CanvasDocument, Shape } from '@/lib/canvas/types';

function makeShape(id: string, over: Partial<Shape> = {}): Shape {
  return {
    id,
    type: 'text',
    name: id,
    x: 320, y: 88, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill: '#0f172a', stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    constraints: null,
    ...over,
  } as Shape;
}

function makeDoc(id: string, shapes: Shape[]): CanvasDocument {
  return {
    id,
    name: 'Snapshot Doc',
    background: '#ffffff',
    version: '2.17',
    children: [],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

beforeEach(() => {
  __resetClientRoundtripForTests();
});

afterEach(() => {
  __resetClientRoundtripForTests();
});

describe('canvasSnapshot: measured= enrichment (spec §5.5)', () => {
  it('emits NO measured= suffix when the map is empty (baseline unchanged)', () => {
    const doc = makeDoc('snap-doc', [makeShape('total', { text: 'Total' })]);
    const snap = canvasSnapshot(doc);
    const line = snap.split('\n').find((l) => l.includes('total'))!;
    expect(line).toContain('size=100×100');
    expect(line).not.toContain('measured=');
    expect(line).toMatch(/size=100×100 fill=/);
  });

  it('appends ` measured=<w>×<h>` after size= for layers with measured entries', () => {
    const doc = makeDoc('snap-doc', [makeShape('total', { text: 'Total' })]);
    setMeasuredBounds('snap-doc', { total: { width: 84, height: 24 } });
    const snap = canvasSnapshot(doc);
    const line = snap.split('\n').find((l) => l.includes('total'))!;
    // Spec §5.5 shape: size=<model>×<model> measured=<real>×<real> …
    expect(line).toContain('size=100×100 measured=84×24');
    expect(line).toContain('fill=');
    expect(line).toContain('text="Total"');
  });

  it('rounds fractional measured sizes', () => {
    const doc = makeDoc('snap-doc', [makeShape('total')]);
    setMeasuredBounds('snap-doc', { total: { width: 84.4, height: 23.6 } });
    const snap = canvasSnapshot(doc);
    expect(snap).toContain('measured=84×24');
  });

  it('only enriches layers with entries (partial maps stay partial)', () => {
    const doc = makeDoc('snap-doc', [
      makeShape('measured-one'),
      makeShape('unmeasured-one'),
    ]);
    setMeasuredBounds('snap-doc', { 'measured-one': { width: 10, height: 20 } });
    const snap = canvasSnapshot(doc);
    const mLine = snap.split('\n').find((l) => l.includes('measured-one'))!;
    const uLine = snap.split('\n').find((l) => l.includes('unmeasured-one'))!;
    expect(mLine).toContain('measured=10×20');
    expect(uLine).not.toContain('measured=');
  });

  it('scopes the map per document id (another doc\'s bounds do not leak)', () => {
    const doc = makeDoc('snap-doc', [makeShape('total')]);
    setMeasuredBounds('other-doc', { total: { width: 1, height: 1 } });
    const snap = canvasSnapshot(doc);
    expect(snap).not.toContain('measured=1×1');
    expect(snap).not.toContain('measured=');
  });

  it('ignores garbage measured entries (non-finite values)', () => {
    const doc = makeDoc('snap-doc', [makeShape('total')]);
    setMeasuredBounds('snap-doc', { total: { width: NaN, height: 24 } });
    const snap = canvasSnapshot(doc);
    const line = snap.split('\n').find((l) => l.includes('total'))!;
    expect(line).not.toContain('measured=');
  });

  it('measured= appears on nested (child) layer lines too', () => {
    const doc = makeDoc('snap-doc', [
      makeShape('parent', { type: 'frame' }),
      makeShape('child', { parentId: 'parent' }),
    ]);
    setMeasuredBounds('snap-doc', { child: { width: 55, height: 66 } });
    const snap = canvasSnapshot(doc);
    const childLine = snap.split('\n').find((l) => l.includes('child'))!;
    expect(childLine).toContain('measured=55×66');
    // Indentation proves the child stayed nested under the parent.
    expect(childLine.startsWith('    ◦')).toBe(true);
  });
});
