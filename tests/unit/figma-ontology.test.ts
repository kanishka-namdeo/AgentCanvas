// Figma ontology alignment — unit tests for the new patch ops.

import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { createEmptyCanvasDocument, createMultiPageCanvasDocument } from '@/lib/canvas/types';
import type { CanvasPatch } from '@/lib/canvas/types';

describe('Figma ontology — Pages', () => {
  it('createEmptyCanvasDocument has no pages by default', () => {
    const doc = createEmptyCanvasDocument('test');
    expect(doc.pages).toBeUndefined();
    expect(doc.activePageIndex).toBeUndefined();
  });

  it('createMultiPageCanvasDocument starts with one page', () => {
    const doc = createMultiPageCanvasDocument('test');
    expect(doc.pages).toBeDefined();
    expect(doc.pages!.length).toBe(1);
    expect(doc.pages![0].name).toBe('Page 1');
    expect(doc.activePageIndex).toBe(0);
  });

  it('add_page adds a new page and switches to it', () => {
    const doc = createMultiPageCanvasDocument('test');
    const patch: CanvasPatch = {
      op: 'add_page',
      pageName: 'Dashboard',
      summary: 'Add Dashboard page',
    };
    const next = applyPatchToCanvas(doc, patch);
    expect(next.pages!.length).toBe(2);
    expect(next.pages![1].name).toBe('Dashboard');
    expect(next.activePageIndex).toBe(1);
    expect(next.children.length).toBe(0);
  });

  it('rename_page updates the page name (by id)', () => {
    const doc = createMultiPageCanvasDocument('test');
    const pageId = doc.pages![0].id;
    const patch: CanvasPatch = {
      op: 'rename_page',
      pageId,
      pageName: 'Home',
      summary: 'Rename Page 1 to Home',
    };
    const next = applyPatchToCanvas(doc, patch);
    expect(next.pages![0].name).toBe('Home');
  });

  it('delete_page cannot delete the last page', () => {
    const doc = createMultiPageCanvasDocument('test');
    const patch: CanvasPatch = {
      op: 'delete_page',
      pageName: 'Page 1',
      summary: 'Delete last page',
    };
    const next = applyPatchToCanvas(doc, patch);
    expect(next.pages!.length).toBe(1);
    expect(next.pages![0].name).toBe('Page 1');
  });

  it('set_active_page switches the active page', () => {
    const doc = createMultiPageCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'add_page',
      pageName: 'Dashboard',
      summary: 'Add Dashboard',
    });
    expect(next.activePageIndex).toBe(1);
    next = applyPatchToCanvas(next, {
      op: 'set_active_page',
      pageName: 'Page 1',
      summary: 'Switch to Page 1',
    });
    expect(next.activePageIndex).toBe(0);
  });

  it('add_page works on legacy single-page docs (migrates them)', () => {
    const doc = createEmptyCanvasDocument('test');
    const patch: CanvasPatch = {
      op: 'add_page',
      pageName: 'Home',
      summary: 'Add Home page',
    };
    const next = applyPatchToCanvas(doc, patch);
    expect(next.pages).toBeDefined();
    expect(next.pages!.length).toBe(1);
    expect(next.pages![0].name).toBe('Home');
  });
});

describe('Figma ontology — Section', () => {
  it('add_section creates a section node with a label', () => {
    const doc = createEmptyCanvasDocument('test');
    const patch: CanvasPatch = {
      op: 'add_section',
      shapeId: 'sec-1',
      shape: {
        id: 'sec-1',
        type: 'section',
        name: 'Onboarding flow',
        label: 'Onboarding flow',
        x: 100,
        y: 100,
        width: 600,
        height: 400,
      },
      summary: 'Add section',
    };
    const next = applyPatchToCanvas(doc, patch);
    expect(next.children.length).toBe(1);
    expect(next.children[0].type).toBe('section');
    expect((next.children[0] as any).label).toBe('Onboarding flow');
    expect(next.children[0].name).toBe('Onboarding flow');
    const section = next.shapes.find((s) => s.id === 'sec-1');
    expect(section).toBeDefined();
    expect(section!.type).toBe('section');
    expect(section!.label).toBe('Onboarding flow');
  });
});

describe('Figma ontology — Component', () => {
  it('create_component adds a component node', () => {
    const doc = createEmptyCanvasDocument('test');
    const patch: CanvasPatch = {
      op: 'create_component',
      shapeId: 'btn-1',
      shape: {
        id: 'btn-1',
        type: 'component',
        name: 'Primary Button',
        x: 100,
        y: 100,
        width: 120,
        height: 40,
        fill: '#0ea5e9',
        radius: 6,
      },
      summary: 'Add Primary Button component',
    };
    const next = applyPatchToCanvas(doc, patch);
    expect(next.children.length).toBe(1);
    expect(next.children[0].type).toBe('component');
    expect(next.children[0].name).toBe('Primary Button');
    expect(Array.isArray((next.children[0] as any).children)).toBe(true);
    const comp = next.shapes.find((s) => s.id === 'btn-1');
    expect(comp!.type).toBe('component');
  });
});

describe('Figma ontology — Component Set + Variants', () => {
  it('create_component_set adds a set with variant axes', () => {
    const doc = createEmptyCanvasDocument('test');
    const patch: CanvasPatch = {
      op: 'create_component_set',
      shapeId: 'btn-set',
      shape: {
        id: 'btn-set',
        type: 'component_set',
        name: 'Button',
        x: 100,
        y: 100,
        width: 400,
        height: 200,
      },
      variantPropertyAxes: ['size', 'state'],
      summary: 'Add Button component set',
    };
    const next = applyPatchToCanvas(doc, patch);
    expect(next.children[0].type).toBe('component_set');
    expect((next.children[0] as any).variantPropertyAxes).toEqual(['size', 'state']);
    const set = next.shapes.find((s) => s.id === 'btn-set');
    expect(set!.type).toBe('component_set');
    expect(set!.variantPropertyAxes).toEqual(['size', 'state']);
  });

  it('add_variant adds a variant inside a component_set', () => {
    const doc = createEmptyCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'create_component_set',
      shapeId: 'btn-set',
      shape: {
        id: 'btn-set',
        type: 'component_set',
        name: 'Button',
        x: 100, y: 100, width: 400, height: 200,
      },
      variantPropertyAxes: ['size', 'state'],
      summary: 'Add set',
    });
    next = applyPatchToCanvas(next, {
      op: 'add_variant',
      shapeId: 'btn-v1',
      shape: {
        id: 'btn-v1',
        type: 'component',
        name: 'Size=Large, State=Default',
        width: 120, height: 40,
        parentId: 'btn-set',
      },
      variantPropertyValues: { size: 'large', state: 'default' },
      summary: 'Add variant',
    });
    const set = next.children.find((c) => c.id === 'btn-set') as any;
    expect(set.children).toBeDefined();
    expect(set.children.length).toBe(1);
    expect(set.children[0].type).toBe('component');
    expect(set.children[0].name).toBe('Size=Large, State=Default');
    expect(set.children[0].variantPropertyValues).toEqual({ size: 'large', state: 'default' });
  });

  it('set_component_property adds a property to a component', () => {
    const doc = createEmptyCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'create_component',
      shapeId: 'btn-1',
      shape: {
        id: 'btn-1',
        type: 'component',
        name: 'Primary Button',
        x: 100, y: 100, width: 120, height: 40,
      },
      summary: 'Add component',
    });
    next = applyPatchToCanvas(next, {
      op: 'set_component_property',
      shapeId: 'btn-1',
      componentProperty: {
        name: 'show-icon',
        type: 'boolean',
        defaultValue: true,
      },
      summary: 'Add show-icon property',
    });
    const comp = next.children[0] as any;
    expect(comp.componentPropertyDefinitions).toBeDefined();
    expect(comp.componentPropertyDefinitions['show-icon']).toBeDefined();
    expect(comp.componentPropertyDefinitions['show-icon'].type).toBe('boolean');
    expect(comp.componentPropertyDefinitions['show-icon'].defaultValue).toBe(true);
  });
});

describe('Figma ontology — Layer type coverage', () => {
  it('LayerType union includes all Figma-canonical container types', () => {
    const types: import('@/lib/canvas/types').LayerType[] = [
      'frame', 'section', 'component', 'component_set', 'group', 'boolean_operation',
      'rectangle', 'ellipse', 'star', 'polygon', 'path', 'line', 'text', 'slice', 'image', 'instance',
    ];
    for (const t of types) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
  });
});
