// Smoke tests for the DOM-renderer benchmark corpus generator
// (scripts/dom-renderer-bench/generate.ts — spec Phase 0 / Appendix F).
//
// Asserts: correct node counts, node-mix type coverage, structural invariants
// (per-screen frame parenting, clip on screen frames, instance componentId
// links, text/path payloads), and DETERMINISM (same seed → identical JSON).

import { describe, it, expect } from 'vitest';
import { generateDocument, mulberry32 } from '../../scripts/dom-renderer-bench/generate';

describe('bench corpus generator', () => {
  it('generates the requested node count plus one root frame per screen', () => {
    for (const [nodes, screens] of [[50, 1], [1000, 4], [5000, 20]] as const) {
      const doc = generateDocument({ nodes, screens, seed: 1 });
      expect(doc.shapes).toHaveLength(nodes + screens);
      const screenFrames = doc.shapes.filter((s) => s.parentId === null);
      expect(screenFrames).toHaveLength(screens);
      expect(screenFrames.every((f) => f.type === 'frame' && f.clip === true)).toBe(true);
    }
  });

  it('covers every node type of the Appendix F mix at 1000 nodes', () => {
    const doc = generateDocument({ nodes: 1000, screens: 4, seed: 2 });
    const types = new Set(doc.shapes.map((s) => s.type));
    for (const t of ['text', 'rectangle', 'frame', 'instance', 'image', 'path']) {
      expect(types.has(t as never), `expected type ${t} in the mix`).toBe(true);
    }
    // Rough mix proportions: text is the largest bucket (~40%).
    const textCount = doc.shapes.filter((s) => s.type === 'text').length;
    expect(textCount).toBeGreaterThan(300);
    expect(textCount).toBeLessThan(500);
  });

  it('produces structurally valid layers (parenting, instance links, payloads)', () => {
    const doc = generateDocument({ nodes: 500, screens: 2, seed: 3 });
    const screenIds = new Set(doc.shapes.filter((s) => s.parentId === null).map((s) => s.id));
    for (const layer of doc.shapes) {
      if (layer.parentId === null) continue; // screen frames
      // Every generated node is parented to a screen frame.
      expect(screenIds.has(layer.parentId!)).toBe(true);
      if (layer.type === 'instance') {
        expect(layer.componentId).not.toBeNull();
      }
      if (layer.type === 'text') {
        expect(typeof layer.text).toBe('string');
        expect(layer.text!.length).toBeGreaterThan(0);
      }
      if (layer.type === 'path') {
        expect(layer.points).not.toBeNull();
        expect(layer.points!.length).toBe(3);
      }
      if (layer.type === 'image') {
        expect(layer.src).toContain('https://example.com/bench/');
      }
    }
  });

  it('is deterministic: same {nodes, screens, seed} → identical JSON', () => {
    const a = generateDocument({ nodes: 300, screens: 3, seed: 42 });
    const b = generateDocument({ nodes: 300, screens: 3, seed: 42 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seeds produce different documents', () => {
    const a = generateDocument({ nodes: 300, screens: 3, seed: 1 });
    const b = generateDocument({ nodes: 300, screens: 3, seed: 2 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('mulberry32 returns a deterministic [0,1) sequence', () => {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    const seq1 = Array.from({ length: 5 }, () => r1());
    const seq2 = Array.from({ length: 5 }, () => r2());
    expect(seq1).toEqual(seq2);
    for (const v of seq1) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const r3 = mulberry32(8);
    expect(seq1).not.toEqual(Array.from({ length: 5 }, () => r3()));
  });
});
