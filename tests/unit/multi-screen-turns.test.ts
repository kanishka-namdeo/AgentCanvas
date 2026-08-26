// Multi-screen turns — regression tests for the "second prompt breaks the
// design" bug family.
//
// User scenario: "create one screen" in prompt 1, "create the next screen"
// in prompt 2. Three defects made this produce overlapping garbage:
//
//   1. figma-tools (pen_create_page & co.) applied patches to the
//      runner-local canvas but never returned them in `details`, so the
//      agent-session translator never streamed them — the client canvas and
//      the WS twin never learned about page swaps, and the agent kept
//      building "on the empty new page" on top of the user's screen 1.
//   2. patch.ts `add_page` on a legacy single-page doc orphaned the existing
//      children (`next.pages = [newPage]; next.children = []`).
//   3. Nothing told the model where free canvas space was, and nothing
//      deterministically stopped a new top-level screen frame from stacking
//      on an existing one.
//
// These tests pin the fixes: patch streaming, legacy-page migration + the
// active-page write-back, the resolveTopLevelFramePlacement guard, and the
// canvasSnapshot placement hint.

import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { createEmptyCanvasDocument, createMultiPageCanvasDocument } from '@/lib/canvas/types';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';
import { createFigmaTools } from '@/lib/agent/figma-tools';
import { createCanvasTools, resolveTopLevelFramePlacement, type CanvasToolContext } from '@/lib/agent/tools';
import { canvasSnapshot } from '@/lib/agent/runner-legacy';
import { translateAgentSessionEvent, createTranslatorState } from '@/lib/agent/agent-session-translator';

// ---- Harness ----------------------------------------------------------------

interface TestHarness {
  doc: CanvasDocument;
  ctx: CanvasToolContext;
}

function makeHarness(initialChildren: Array<Record<string, unknown>> = []): TestHarness {
  const doc: CanvasDocument = {
    ...createEmptyCanvasDocument('doc-ms'),
    children: initialChildren as never,
  };
  doc.shapes = applyPatchToCanvas(doc, { op: 'select', shapeIds: [] }).shapes;
  const ctx: CanvasToolContext = {
    getShapes: () => doc.shapes,
    getTokens: () => doc.tokens,
    getDocument: () => doc,
    applyPatch: (p) => {
      const next = applyPatchToCanvas(doc, p);
      Object.assign(doc, next);
      return p;
    },
  };
  return { doc, ctx };
}

async function runFigmaTool(h: TestHarness, name: string, args: Record<string, unknown>) {
  const tool = createFigmaTools(h.ctx).find((t: any) => t.name === name);
  if (!tool) throw new Error(`Unknown figma tool: ${name}`);
  return await tool.execute(`call-${name}`, args as any, undefined, undefined, undefined as any);
}

async function runCanvasTool(h: TestHarness, name: string, args: Record<string, unknown>) {
  const tool = createCanvasTools(h.ctx).find((t: any) => t.name === name);
  if (!tool) throw new Error(`Unknown canvas tool: ${name}`);
  return await tool.execute(`call-${name}`, args as any, undefined, undefined, undefined as any);
}

/// Build a resolved top-level frame Shape for guard/snapshot fixtures.
function frameShape(overrides: Partial<Shape> & { id: string }): Shape {
  return {
    type: 'frame',
    name: 'Screen',
    x: 200,
    y: 50,
    width: 375,
    height: 812,
    fill: '#ffffff',
    zIndex: 1,
    parentId: null,
    ...overrides,
  } as Shape;
}

// ---- 1. figma-tools patch streaming ------------------------------------------

describe('multi-screen turns — figma tool patches stream through details', () => {
  it('pen_create_page returns its add_page patch in details', async () => {
    const h = makeHarness([
      { id: 'screen-1', type: 'frame', name: 'Login Screen', x: 200, y: 50, width: 375, height: 812 },
    ]);
    const result: any = await runFigmaTool(h, 'pen_create_page', { name: 'Dashboard' });
    expect(result.details.patch).toBeDefined();
    expect(result.details.patch.op).toBe('add_page');
    expect(result.details.patch.pageName).toBe('Dashboard');
  });

  it('the translator forwards a page op from a tool_execution_end result', async () => {
    const h = makeHarness();
    const toolResult: any = await runFigmaTool(h, 'pen_create_page', { name: 'Home' });
    const state = createTranslatorState();
    const events = translateAgentSessionEvent(
      { type: 'tool_execution_end', toolCallId: 'call-1', result: toolResult } as any,
      state,
    );
    const patches = events.filter((e: any) => e.kind === 'patch');
    expect(patches.length).toBe(1);
    expect((patches[0] as any).patch.op).toBe('add_page');
  });

  it('every figma tool that mutates the canvas returns a patch in details', async () => {
    const h = makeHarness();
    // pen_create_section (add_section op)
    const section: any = await runFigmaTool(h, 'pen_create_section', { label: 'Flow' });
    expect(section.details.patch?.op).toBe('add_section');
    // pen_create_component (create_component op)
    const component: any = await runFigmaTool(h, 'pen_create_component', { name: 'Button' });
    expect(component.details.patch?.op).toBe('create_component');
    // pen_create_component_set
    const set: any = await runFigmaTool(h, 'pen_create_component_set', {
      name: 'Button',
      variantPropertyAxes: ['state'],
    });
    expect(set.details.patch?.op).toBe('create_component_set');
    // pen_add_variant into the set just created
    const setId = set.details.id as string;
    const variant: any = await runFigmaTool(h, 'pen_add_variant', {
      componentSetId: setId,
      variantPropertyValues: { state: 'hover' },
    });
    expect(variant.details.patch?.op).toBe('add_variant');
    // pen_set_component_property
    const prop: any = await runFigmaTool(h, 'pen_set_component_property', {
      componentId: component.details.id,
      propertyName: 'label-text',
      propertyType: 'text',
      defaultValue: 'Submit',
    });
    expect(prop.details.patch?.op).toBe('set_component_property');
    // pen_set_active_page on a multi-page doc
    h.ctx.applyPatch({ op: 'add_page', pageName: 'Second', summary: 'add page' });
    const active: any = await runFigmaTool(h, 'pen_set_active_page', { pageName: 'Page 1' });
    expect(active.details.patch?.op).toBe('set_active_page');
    // pen_rename_page
    const renamed: any = await runFigmaTool(h, 'pen_rename_page', {
      currentPageName: 'Page 1',
      newName: 'Home',
    });
    expect(renamed.details.patch?.op).toBe('rename_page');
  });
});

// ---- 2. add_page legacy migration + active-page write-back --------------------

describe('multi-screen turns — add_page preserves existing content', () => {
  it('migrates legacy children into an implicit Page 1 instead of orphaning them', () => {
    const doc = createEmptyCanvasDocument('doc-ms');
    const withScreen = applyPatchToCanvas(doc, {
      op: 'add',
      shapeId: 'screen-1',
      shape: { id: 'screen-1', type: 'frame', name: 'Login Screen', x: 200, y: 50, width: 375, height: 812 },
      summary: 'screen 1',
    } as CanvasPatch);
    expect(withScreen.children.length).toBe(1);

    const paged = applyPatchToCanvas(withScreen, {
      op: 'add_page',
      pageName: 'Dashboard',
      summary: 'add Dashboard page',
    } as CanvasPatch);

    expect(paged.pages!.length).toBe(2);
    expect(paged.pages![0].name).toBe('Page 1');
    expect(paged.pages![0].children.length).toBe(1);
    expect(paged.pages![0].children[0].id).toBe('screen-1');
    expect(paged.pages![1].name).toBe('Dashboard');
    expect(paged.activePageIndex).toBe(1);
    expect(paged.children.length).toBe(0);
    // Screen 1 is still rendered nowhere on the active page…
    expect(paged.shapes.filter((s) => s.id === 'screen-1')).toHaveLength(0);
    // …but survives on page 1: switching back restores it.
    const back = applyPatchToCanvas(paged, {
      op: 'set_active_page',
      pageName: 'Page 1',
      summary: 'switch back',
    } as CanvasPatch);
    expect(back.activePageIndex).toBe(0);
    expect(back.shapes.some((s) => s.id === 'screen-1')).toBe(true);
  });

  it('content created on the new page is written back into pages[active] and survives page switches', () => {
    const doc = createMultiPageCanvasDocument('doc-ms');
    let next = applyPatchToCanvas(doc, {
      op: 'add_page',
      pageName: 'Dashboard',
      summary: 'add page',
    } as CanvasPatch);
    next = applyPatchToCanvas(next, {
      op: 'add',
      shapeId: 'dash-1',
      shape: { id: 'dash-1', type: 'frame', name: 'Dashboard Screen', x: 0, y: 0, width: 375, height: 812 },
      summary: 'dashboard',
    } as CanvasPatch);
    // Write-back: the active page owns the new node.
    expect(next.pages![1].children.some((c: any) => c.id === 'dash-1')).toBe(true);
    // Switch away and back — the node must survive.
    let switched = applyPatchToCanvas(next, {
      op: 'set_active_page',
      pageName: 'Page 1',
      summary: 'away',
    } as CanvasPatch);
    expect(switched.shapes.some((s) => s.id === 'dash-1')).toBe(false);
    switched = applyPatchToCanvas(switched, {
      op: 'set_active_page',
      pageName: 'Dashboard',
      summary: 'back',
    } as CanvasPatch);
    expect(switched.shapes.some((s) => s.id === 'dash-1')).toBe(true);
  });

  it('empty legacy docs still get a single new page (existing pinned behavior)', () => {
    const doc = createEmptyCanvasDocument('doc-ms');
    const next = applyPatchToCanvas(doc, { op: 'add_page', pageName: 'Home', summary: 'x' } as CanvasPatch);
    expect(next.pages!.length).toBe(1);
    expect(next.pages![0].name).toBe('Home');
  });
});

// ---- 3. Collision guard -------------------------------------------------------

describe('multi-screen turns — resolveTopLevelFramePlacement guard', () => {
  it('shifts a frame stacked exactly on an existing screen to free space', () => {
    const shapes = [frameShape({ id: 'a' })]; // (200,50) 375x812
    const r = resolveTopLevelFramePlacement(shapes, 200, 50, 375, 812);
    expect(r.adjusted).toBe(true);
    expect(r.x).toBe(200 + 375 + 80); // right of max right edge + gutter
    expect(r.y).toBe(50);
  });

  it('lets a side-by-side frame through untouched', () => {
    const shapes = [frameShape({ id: 'a' })];
    const r = resolveTopLevelFramePlacement(shapes, 200 + 375 + 80, 50, 375, 812);
    expect(r.adjusted).toBe(false);
    expect(r.x).toBe(655);
  });

  it('does not shift a small frame nested inside a big screen (no mutual majority)', () => {
    const shapes = [frameShape({ id: 'a' })]; // 375x812
    // 120x60 card fully inside the screen: covers 100% of itself but only
    // ~2.4% of the screen — not a mutual majority overlap.
    const r = resolveTopLevelFramePlacement(shapes, 240, 100, 120, 60);
    expect(r.adjusted).toBe(false);
  });

  it('ignores sections and parented frames as obstacles', () => {
    const shapes = [
      frameShape({ id: 'sec', type: 'section' as any }), // sections enclose by design
      frameShape({ id: 'child', parentId: 'a' }),
    ];
    const r = resolveTopLevelFramePlacement(shapes, 200, 50, 375, 812);
    expect(r.adjusted).toBe(false);
  });

  it('returns input unchanged when the canvas has no top-level frames', () => {
    const r = resolveTopLevelFramePlacement([], 0, 0, 375, 812);
    expect(r.adjusted).toBe(false);
    expect(r.x).toBe(0);
  });

  it('pen_create_node auto-places a stacked top-level frame and reports it', async () => {
    const h = makeHarness();
    const first: any = await runCanvasTool(h, 'pen_create_node', {
      type: 'frame',
      name: 'Login Screen',
      x: 200,
      y: 50,
      width: 375,
      height: 812,
    });
    expect(first.details.patch.shape.x).toBe(200);

    const second: any = await runCanvasTool(h, 'pen_create_node', {
      type: 'frame',
      name: 'Dashboard Screen',
      x: 200, // stacked on the login screen — the exact bug repro
      y: 50,
      width: 375,
      height: 812,
    });
    const text = second.content.map((c: any) => c.text).join('\n');
    expect(second.details.patch.shape.x).toBe(655);
    expect(second.details.patch.shape.y).toBe(50);
    expect(text).toContain('auto-placed');
    expect(text).toContain('(655, 50)');
    // The streamed patch carries the ADJUSTED coordinates, so the client and
    // the WS twin place the frame in free space too.
    const placed = h.doc.shapes.find((s) => s.name === 'Dashboard Screen');
    expect(placed?.x).toBe(655);
  });

  it('pen_create_node leaves parented child nodes untouched', async () => {
    const h = makeHarness();
    await runCanvasTool(h, 'pen_create_node', {
      type: 'frame',
      name: 'Login Screen',
      x: 200,
      y: 50,
      width: 375,
      height: 812,
    });
    const child: any = await runCanvasTool(h, 'pen_create_node', {
      type: 'rectangle',
      name: 'Card',
      x: 240,
      y: 100,
      width: 120,
      height: 60,
      parentId: (h.doc.shapes.find((s) => s.name === 'Login Screen') as Shape)!.id,
    });
    expect(child.details.patch.shape.x).toBe(240);
    expect((child.content[0] as any).text).not.toContain('auto-placed');
  });
});

// ---- 4. Snapshot placement hint -----------------------------------------------

describe('multi-screen turns — canvasSnapshot placement hint', () => {
  it('tells the model where to place the first screen on an empty canvas', () => {
    const doc = createEmptyCanvasDocument('doc-ms');
    const snap = canvasSnapshot(doc);
    expect(snap).toContain('Next screen placement:');
    expect(snap).toContain('canvas is empty');
  });

  it('tells the model the exact free position next to existing screens', () => {
    const h = makeHarness([
      { id: 'screen-1', type: 'frame', name: 'Login Screen', x: 200, y: 50, width: 375, height: 812 },
    ]);
    const snap = canvasSnapshot(h.doc);
    expect(snap).toContain('Next screen placement:');
    expect(snap).toContain('place the NEXT screen frame at (655,50)');
    expect(snap).toContain('never on top of them');
  });

  it('computes the hint from multiple screens (rightmost edge + 80)', () => {
    const h = makeHarness([
      { id: 'screen-1', type: 'frame', name: 'Login', x: 200, y: 50, width: 375, height: 812 },
      { id: 'screen-2', type: 'frame', name: 'Dashboard', x: 655, y: 50, width: 375, height: 812 },
    ]);
    const snap = canvasSnapshot(h.doc);
    expect(snap).toContain('place the NEXT screen frame at (1110,50)');
  });
});

// ---- 5. System prompt guidance -------------------------------------------------

describe('multi-screen turns — system prompt guidance', () => {
  it('no longer steers multi-screen designs toward separate pages', async () => {
    const { buildSystemPrompt, SYSTEM_PROMPT_TEMPLATE } = await import('@/lib/agent/runner-legacy');
    const prompt = buildSystemPrompt('', '', '', createEmptyCanvasDocument('d'), 'slate', true);
    expect(prompt).not.toContain('one page per screen');
    expect(prompt).toContain('MULTI-SCREEN DESIGNS');
    expect(prompt).toContain('side-by-side');
    expect(SYSTEM_PROMPT_TEMPLATE).not.toContain('one page per screen');
  });
});
