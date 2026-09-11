// Tests for checkpoint signature deep tree enhancement (Task 8 fix).
// Verifies that the signature detects changes to deeply nested nodes.

import { describe, it, expect } from 'vitest';
import { checkpointSignature } from '@/lib/canvas/version-history';
import type { CanvasDocument } from '@/lib/canvas/types';

function makeDoc(children: any[] = []): CanvasDocument {
  return {
    id: 'doc-1',
    name: 'Test',
    version: '2.17',
    children,
    viewport: { zoom: 1, panX: 0, panY: 0 },
    background: '#ffffff',
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
}

describe('checkpointSignature', () => {
  it('returns different signatures for different root node counts', () => {
    const doc1 = makeDoc([{ id: 'n1', type: 'frame' }]);
    const doc2 = makeDoc([{ id: 'n1', type: 'frame' }, { id: 'n2', type: 'frame' }]);

    const sig1 = checkpointSignature(doc1);
    const sig2 = checkpointSignature(doc2);

    expect(sig1).not.toBe(sig2);
  });

  it('returns different signatures for different root node properties', () => {
    const doc1 = makeDoc([{ id: 'n1', type: 'frame', fill: '#ff0000' }]);
    const doc2 = makeDoc([{ id: 'n1', type: 'frame', fill: '#00ff00' }]);

    const sig1 = checkpointSignature(doc1);
    const sig2 = checkpointSignature(doc2);

    expect(sig1).not.toBe(sig2);
  });

  it('returns different signatures for deeply nested node changes (depth 1)', () => {
    const doc1 = makeDoc([
      {
        id: 'n1',
        type: 'frame',
        children: [{ id: 'n1-1', type: 'rectangle', fill: '#ff0000' }],
      },
    ]);
    const doc2 = makeDoc([
      {
        id: 'n1',
        type: 'frame',
        children: [{ id: 'n1-1', type: 'rectangle', fill: '#00ff00' }],
      },
    ]);

    const sig1 = checkpointSignature(doc1);
    const sig2 = checkpointSignature(doc2);

    expect(sig1).not.toBe(sig2);
  });

  it('returns different signatures for deeply nested node changes (depth 2)', () => {
    const doc1 = makeDoc([
      {
        id: 'n1',
        type: 'frame',
        children: [
          {
            id: 'n1-1',
            type: 'frame',
            children: [{ id: 'n1-1-1', type: 'rectangle', fill: '#ff0000' }],
          },
        ],
      },
    ]);
    const doc2 = makeDoc([
      {
        id: 'n1',
        type: 'frame',
        children: [
          {
            id: 'n1-1',
            type: 'frame',
            children: [{ id: 'n1-1-1', type: 'rectangle', fill: '#00ff00' }],
          },
        ],
      },
    ]);

    const sig1 = checkpointSignature(doc1);
    const sig2 = checkpointSignature(doc2);

    expect(sig1).not.toBe(sig2);
  });

  it('returns different signatures for structural changes (reparenting)', () => {
    const doc1 = makeDoc([
      {
        id: 'n1',
        type: 'frame',
        children: [{ id: 'n1-1', type: 'rectangle' }],
      },
      { id: 'n2', type: 'frame', children: [] },
    ]);
    const doc2 = makeDoc([
      { id: 'n1', type: 'frame', children: [] },
      {
        id: 'n2',
        type: 'frame',
        children: [{ id: 'n1-1', type: 'rectangle' }],
      },
    ]);

    const sig1 = checkpointSignature(doc1);
    const sig2 = checkpointSignature(doc2);

    expect(sig1).not.toBe(sig2);
  });

  it('returns different signatures for children count changes', () => {
    const doc1 = makeDoc([
      {
        id: 'n1',
        type: 'frame',
        children: [{ id: 'n1-1', type: 'rectangle' }],
      },
    ]);
    const doc2 = makeDoc([
      {
        id: 'n1',
        type: 'frame',
        children: [
          { id: 'n1-1', type: 'rectangle' },
          { id: 'n1-2', type: 'rectangle' },
        ],
      },
    ]);

    const sig1 = checkpointSignature(doc1);
    const sig2 = checkpointSignature(doc2);

    expect(sig1).not.toBe(sig2);
  });

  it('returns same signature for identical documents', () => {
    const doc = makeDoc([
      {
        id: 'n1',
        type: 'frame',
        fill: '#ff0000',
        children: [{ id: 'n1-1', type: 'rectangle', fill: '#00ff00' }],
      },
    ]);

    const sig1 = checkpointSignature(doc);
    const sig2 = checkpointSignature(doc);

    expect(sig1).toBe(sig2);
  });

  it('handles empty documents', () => {
    const doc = makeDoc([]);
    const sig = checkpointSignature(doc);

    // 0 roots, 0 shapes, JSON.stringify(undefined ?? {}) = "{}" (2 chars).
    expect(sig).toBe('0:0:2:0:0');
  });

  it('handles documents with an empty children array', () => {
    const doc = { ...makeDoc(), children: [] };
    const sig = checkpointSignature(doc);

    expect(sig).toBe('0:0:2:0:0');
  });
});
