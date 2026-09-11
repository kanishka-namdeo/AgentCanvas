import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { PropertiesPanel } from '@/components/canvas/PropertiesPanel';
import { useCanvasStore } from '@/lib/canvas/store';
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

describe('Token Editor UI', () => {
  const emptyDoc = {
    id: 'test',
    name: 'Test',
    version: '2.17',
    children: [],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    background: '#f8fafc',
    shapes: [],
    tokens: { colors: [], textStyles: [] },
    variables: undefined,
    themes: undefined,
  } as CanvasDocument;

  it('renders Add Variable button in empty state', () => {
    useCanvasStore.setState({
      document: emptyDoc,
      selectedIds: [],
    });

    render(<PropertiesPanel />);
    expect(screen.getByText(/Add Variable/i)).toBeInTheDocument();
  });

  it('renders existing variables with a delete button and emits remove_variable patch', () => {
    const sendPatch = vi.fn(() => true);
    useCanvasStore.setState({
      document: {
        ...emptyDoc,
        tokens: { colors: [{ name: 'color.primary', key: 'color.primary', value: '#0ea5e9' }], textStyles: [] },
      },
      selectedIds: [],
      sendPatch,
    });

    render(<PropertiesPanel />);
    expect(screen.getByText('color.primary')).toBeInTheDocument();
    const deleteBtn = screen.getByRole('button', { name: /×/ });
    fireEvent.click(deleteBtn);
    expect(sendPatch).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'remove_variable', variableKey: 'color.primary' }),
    );
  });
});
