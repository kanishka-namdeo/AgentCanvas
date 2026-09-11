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

describe('Component Properties UI', () => {
  const componentDoc = {
    id: 'test',
    name: 'Test',
    version: '2.17',
    children: [
      {
        id: 'comp1',
        type: 'component',
        name: 'Button',
        reusable: true,
        componentPropertyDefinitions: {
          'show-icon': { type: 'boolean', defaultValue: true },
          'label-text': { type: 'text', defaultValue: 'Submit' },
        },
      },
    ],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    background: '#f8fafc',
    shapes: [
      {
        id: 'comp1',
        type: 'component',
        name: 'Button',
        componentId: 'comp1',
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        fill: '#ffffff',
        stroke: '#000000',
        strokeWidth: 1,
        radius: 0,
        opacity: 1,
        componentPropertyDefinitions: {
          'show-icon': { type: 'boolean', defaultValue: true },
          'label-text': { type: 'text', defaultValue: 'Submit' },
        },
      },
    ],
    tokens: { colors: [], textStyles: [] },
  } as unknown as CanvasDocument;

  it('renders Component Properties section when component is selected', () => {
    useCanvasStore.setState({
      document: componentDoc,
      selectedIds: ['comp1'],
    });

    render(<PropertiesPanel />);
    expect(screen.getByText(/Component Properties/i)).toBeInTheDocument();
    expect(screen.getByText(/show-icon/i)).toBeInTheDocument();
    expect(screen.getByText(/label-text/i)).toBeInTheDocument();
  });

  it('emits set_component_property patch from the Add Property dialog', () => {
    const patches: CanvasPatch[] = [];
    useCanvasStore.setState({
      document: componentDoc,
      selectedIds: ['comp1'],
      sendPatch: (p: CanvasPatch) => {
        patches.push(p);
        return true;
      },
    });

    render(<PropertiesPanel />);
    fireEvent.click(screen.getByText('+ Add Property'));
    fireEvent.change(screen.getByPlaceholderText('show-icon'), { target: { value: 'size' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      op: 'set_component_property',
      shapeId: 'comp1',
      componentProperty: { name: 'size', type: 'text' },
    });
  });
});
