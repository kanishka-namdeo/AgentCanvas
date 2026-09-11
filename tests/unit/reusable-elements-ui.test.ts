import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';

describe('remove_variable patch op', () => {
  it('removes a variable by key', () => {
    const doc: CanvasDocument = {
      id: 'test',
      name: 'Test',
      version: '2.17',
      children: [],
      viewport: { zoom: 1, panX: 0, panY: 0 },
      background: '#f8fafc',
      shapes: [],
      tokens: { colors: [{ name: 'color.primary', key: 'color.primary', value: '#0ea5e9' }], textStyles: [] },
      variables: {
        'color.primary': { type: 'color', value: '#0ea5e9' },
        'color.secondary': { type: 'color', value: '#8b5cf6' },
      },
    } as CanvasDocument;

    const patch: CanvasPatch = {
      op: 'remove_variable',
      variableKey: 'color.primary',
      summary: 'Removed variable color.primary',
    };

    const result = applyPatchToCanvas(doc, patch);
    expect(result.variables).toBeDefined();
    expect(result.variables!['color.primary']).toBeUndefined();
    expect(result.variables!['color.secondary']).toBeDefined();
  });

  it('is a no-op if variable does not exist', () => {
    const doc: CanvasDocument = {
      id: 'test',
      name: 'Test',
      version: '2.17',
      children: [],
      viewport: { zoom: 1, panX: 0, panY: 0 },
      background: '#f8fafc',
      shapes: [],
      tokens: { colors: [], textStyles: [] },
      variables: { 'color.primary': { type: 'color', value: '#0ea5e9' } },
    } as CanvasDocument;

    const patch: CanvasPatch = {
      op: 'remove_variable',
      variableKey: 'nonexistent',
      summary: 'Removed nonexistent',
    };

    const result = applyPatchToCanvas(doc, patch);
    expect(result.variables!['color.primary']).toBeDefined();
  });
});
