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
  doc.shapes = applyPatchToCanvas(doc, { op: 'select', shapeIds: [], summary: '' }).shapes;
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

// ---- 6. Critique-loop prior-content protection -------------------------------

describe('multi-screen turns — critique loop protects prior content', () => {
  it('prior-content guard blocks pen_delete_nodes on prior shapes while active', async () => {
    const { wrapToolsWithPriorContentGuard } = await import('@/lib/agent/prior-content-guard');
    let guardActive = false;
    const protectedIds = new Set(['prior-1']);
    const names = new Map([['prior-1', 'Login Card']]);
    let deleteExecuted = false;
    const tools = wrapToolsWithPriorContentGuard(
      [
        {
          name: 'pen_delete_nodes',
          execute: async () => {
            deleteExecuted = true;
            return { content: [{ type: 'text', text: 'deleted' }] };
          },
        },
      ] as any,
      {
        getProtectedShapeIds: () => protectedIds,
        getProtectedShapeNames: () => names,
        isGuardActive: () => guardActive,
      },
    );

    // Inactive guard (main turn): delete passes through.
    const mainTurn: any = await (tools[0] as any).execute('c1', { nodeIds: ['prior-1'] }, undefined, undefined, undefined);
    expect(deleteExecuted).toBe(true);
    expect(mainTurn.isError).toBeUndefined();

    // Active guard (critique fix-turn): delete of a prior shape is REJECTED.
    guardActive = true;
    const fixTurn: any = await (tools[0] as any).execute('c2', { nodeIds: ['prior-1'] }, undefined, undefined, undefined);
    expect(fixTurn.isError).toBe(true);
    expect(fixTurn.details.error).toBe('prior_content_protected');
    expect(fixTurn.content[0].text).toContain('Login Card');
    expect(fixTurn.content[0].text).toContain('prior work');

    // New-shape deletes still pass while the guard is active.
    const newShapeDelete: any = await (tools[0] as any).execute('c3', { nodeIds: ['new-1'] }, undefined, undefined, undefined);
    expect(newShapeDelete.isError).toBeUndefined();
  });

  it('prior-content guard blocks pen_clear entirely while active, allows otherwise', async () => {
    const { wrapToolsWithPriorContentGuard } = await import('@/lib/agent/prior-content-guard');
    let guardActive = false;
    let clearExecuted = false;
    const tools = wrapToolsWithPriorContentGuard(
      [
        {
          name: 'pen_clear',
          execute: async () => {
            clearExecuted = true;
            return { content: [{ type: 'text', text: 'cleared' }] };
          },
        },
      ] as any,
      {
        getProtectedShapeIds: () => new Set(['x']),
        getProtectedShapeNames: () => new Map([['x', 'X']]),
        isGuardActive: () => guardActive,
      },
    );

    const mainTurn: any = await (tools[0] as any).execute('c1', {}, undefined, undefined, undefined);
    expect(clearExecuted).toBe(true);

    guardActive = true;
    const fixTurn: any = await (tools[0] as any).execute('c2', {}, undefined, undefined, undefined);
    expect(fixTurn.isError).toBe(true);
    expect(fixTurn.details.error).toBe('prior_content_protected');
  });

  it('extractNodeIdsFromParams tolerates LLM arg-shape mistakes', async () => {
    const { extractNodeIdsFromParams } = await import('@/lib/agent/prior-content-guard');
    expect(extractNodeIdsFromParams({ nodeIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(extractNodeIdsFromParams({ nodeId: 'a' })).toEqual(['a']);
    expect(extractNodeIdsFromParams({ shapeIds: ['a'] })).toEqual(['a']);
    expect(extractNodeIdsFromParams({ shapeId: 'a' })).toEqual(['a']);
    expect(extractNodeIdsFromParams({})).toEqual([]);
    expect(extractNodeIdsFromParams({ nodeIds: ['a', 42, null] })).toEqual(['a']);
  });

  it('critic snapshot is scoped: prior shapes excluded + out-of-scope header', async () => {
    // dispatchDesignCriticSubAgent would need an LLM; exercise the serializer
    // indirectly through the module by calling the dispatcher with a mock LLM
    // whose completion we can't easily fabricate — instead verify via the
    // exported path: build a canvas, call the dispatcher with priorShapeIds
    // and a stub LLM that echoes the user message it received.
    const { dispatchDesignCriticSubAgent } = await import('@/lib/agent/subagents/design-critic');
    let receivedUserMessage = '';
    const stubLlm = {
      chat: {
        completions: {
          create: async (params: any) => {
            receivedUserMessage = params.messages.find((m: any) => m.role === 'user').content;
            return { choices: [{ message: { content: 'CRITIQUE:\n- [MINOR] x\nSCORE: 8' } }] };
          },
        },
      },
    };
    const h = makeHarness([
      { id: 'prior-frame', type: 'frame', name: 'Login Card', x: 0, y: 0, width: 400, height: 600 },
      { id: 'prior-text', type: 'text', name: 'Email Label', x: 10, y: 10, width: 100, height: 20 },
    ]);
    // Add a NEW shape (created "this turn").
    await runCanvasTool(h, 'pen_create_node', {
      type: 'rectangle',
      name: 'New Card',
      x: 1000,
      y: 100,
      width: 200,
      height: 100,
    });

    await dispatchDesignCriticSubAgent({
      task: 'Critique the current canvas design.',
      canvas: h.doc,
      originalPrompt: 'Now create a dashboard screen',
      llm: stubLlm as any,
      priorShapeIds: ['prior-frame', 'prior-text'],
    });

    expect(receivedUserMessage).toContain('Out of scope: 2 shape(s) from EARLIER turns');
    expect(receivedUserMessage).toContain('"Login Card"');
    expect(receivedUserMessage).toContain('NEVER recommend deleting, replacing, or restyling them');
    expect(receivedUserMessage).toContain('New Card');
    // The prior shapes' own property lines must NOT appear as review targets
    // (the out-of-scope header may name them, but no `• "…"` bullet does).
    expect(receivedUserMessage).not.toContain('• "Email Label"');
    expect(receivedUserMessage).not.toContain('• "Login Card"');
  });

  it('validateCanvasBeforeComplete relaxMinCount lets small edit turns pass', async () => {
    const { validateCanvasBeforeComplete } = await import('@/lib/agent/validators');
    // 2 shapes — fails rule 1 by default; with relaxMinCount the remaining
    // rules pass because the text has weight 700 and the card has a shadow.
    const shapes = [
      { type: 'rectangle', name: 'Card', x: 0, y: 0, width: 10, height: 10, shadow: { x: 0, y: 1, blur: 2, color: '#000' } },
      { type: 'text', name: 'Label', x: 0, y: 0, width: 10, height: 10, fontWeight: 700 },
    ] as any[];
    expect(validateCanvasBeforeComplete(shapes).ok).toBe(false);
    expect(validateCanvasBeforeComplete(shapes, { relaxMinCount: true }).ok).toBe(true);
  });
});

// ---- 7. Turn-end reveal (off-screen content becomes visible) ------------------

describe('multi-screen turns — turn-end reveal', () => {
  it('contentOutsideViewport detects off-screen rightward growth', async () => {
    const { contentOutsideViewport } = await import('@/lib/canvas/viewport');
    // Viewport: zoom 1, pan (120, 80), 1200x800 visible → canvas rect
    // (-120..1080, -80..720). Three side-by-side 375px screens at x=200,
    // 655, 1110 extend to 1485 — outside horizontally.
    const vp = { zoom: 1, panX: 120, panY: 80 };
    const size = { w: 1200, h: 800 };
    const threeScreens = { x: 200, y: 50, width: 1285, height: 600 }; // 200..1485
    expect(contentOutsideViewport(threeScreens, vp, size)).toBe(true);

    // One screen at (200,50) 375x600 — fully inside (bottom edge 650 < 720).
    const oneScreen = { x: 200, y: 50, width: 375, height: 600 };
    expect(contentOutsideViewport(oneScreen, vp, size)).toBe(false);

    // Two screens (200..1030) still inside the 1080 visible edge.
    const twoScreens = { x: 200, y: 50, width: 830, height: 600 };
    expect(contentOutsideViewport(twoScreens, vp, size)).toBe(false);
  });

  it('fitViewport zooms out to fit three side-by-side screens', async () => {
    const { fitViewport } = await import('@/lib/canvas/viewport');
    const screens = [
      { x: 200, y: 50, width: 375, height: 812 },
      { x: 655, y: 50, width: 375, height: 812 },
      { x: 1110, y: 50, width: 375, height: 812 },
    ];
    const vp = fitViewport(screens, { w: 1200, h: 800 });
    // All three screens (200..1485) must fit inside the visible rect.
    expect(vp.zoom).toBeLessThan(1);
    const visX = -vp.panX / vp.zoom;
    const visW = 1200 / vp.zoom;
    expect(visX).toBeLessThanOrEqual(200);
    expect(visX + visW).toBeGreaterThanOrEqual(1485);
  });

  it('the store dispatches a reveal zoom request on turn end after adds', async () => {
    const { useCanvasStore } = await import('@/lib/canvas/store');
    const received: string[] = [];
    const listener = (ev: Event) => {
      received.push((ev as CustomEvent).detail?.kind ?? '?');
    };
    window.addEventListener('ac:canvas-zoom', listener);
    try {
      const st = useCanvasStore.getState();
      // Simulate an agent turn: patch an add through _onSync, then turn_end.
      st._onSync({
        type: 'canvas:patch',
        patch: {
          op: 'add',
          shapeId: 'reveal-1',
          shape: { id: 'reveal-1', type: 'frame', name: 'Screen', x: 200, y: 50, width: 375, height: 812 },
          summary: 'add',
        } as CanvasPatch,
      });
      // Flush the rAF-coalesced patch queue synchronously.
      await new Promise((r) => setTimeout(r, 60));
      st._onSync({ type: 'agent:turn_end' });
      expect(received).toContain('reveal');
    } finally {
      window.removeEventListener('ac:canvas-zoom', listener);
    }
  });
});

// ---- 8. Frame overflow (content must fit its screen) --------------------------

describe('multi-screen turns — content fits inside screen frames', () => {
  it('validateCanvasBeforeComplete flags children spilling below their frame', async () => {
    const { validateCanvasBeforeComplete } = await import('@/lib/agent/validators');
    const shapes = [
      { id: 'f1', type: 'frame', name: 'Login', x: 200, y: 50, width: 375, height: 812, parentId: null },
      { id: 'c1', type: 'rectangle', name: 'Header', x: 200, y: 50, width: 375, height: 70, parentId: 'f1' },
      // 158px below the frame bottom (1020 vs 862) — must be flagged.
      { id: 'c2', type: 'rectangle', name: 'Sign Up Prompt', x: 220, y: 980, width: 335, height: 40, parentId: 'f1' },
    ] as any[];
    const result = validateCanvasBeforeComplete(shapes, { relaxMinCount: true });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('below their parent screen frame'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('"Sign Up Prompt"') && r.includes('158px'))).toBe(true);
  });

  it('validateCanvasBeforeComplete tolerates small decorative bleeds (≤40px)', async () => {
    const { validateCanvasBeforeComplete } = await import('@/lib/agent/validators');
    const shapes = [
      { id: 'f1', type: 'frame', name: 'Login', x: 0, y: 0, width: 375, height: 812, parentId: null },
      { id: 'c1', type: 'rectangle', name: 'Card', x: 10, y: 10, width: 355, height: 790, parentId: 'f1' },
    ] as any[];
    const result = validateCanvasBeforeComplete(shapes, { relaxMinCount: true });
    expect(result.reasons.some((r) => r.includes('parent screen frame'))).toBe(false);
  });

  it('pen_create_node warns when a child would land below its parent frame', async () => {
    const h = makeHarness();
    const frame: any = await runCanvasTool(h, 'pen_create_node', {
      type: 'frame',
      name: 'Login',
      x: 200,
      y: 50,
      width: 375,
      height: 812,
    });
    const frameId = frame.details.shapeId;
    // Child at y=980 inside an 812-tall frame starting at y=50 — bottom edge 158px below.
    const child: any = await runCanvasTool(h, 'pen_create_node', {
      type: 'rectangle',
      name: 'Sign Up Prompt',
      x: 220,
      y: 980,
      width: 335,
      height: 40,
      parentId: frameId,
    });
    const text = child.content.map((c: any) => c.text).join('\n');
    expect(text).toContain('BELOW its parent frame "Login"');
    expect(text).toContain('158px');
    // A child that fits produces no warning.
    const fitting: any = await runCanvasTool(h, 'pen_create_node', {
      type: 'rectangle',
      name: 'Header',
      x: 200,
      y: 50,
      width: 375,
      height: 70,
      parentId: frameId,
    });
    expect(fitting.content.map((c: any) => c.text).join('\n')).not.toContain('BELOW');
  });

  it('the system prompt carries the vertical-budget rule', async () => {
    const { buildSystemPrompt } = await import('@/lib/agent/runner-legacy');
    const prompt = buildSystemPrompt('', '', '', createEmptyCanvasDocument('d'), 'slate', true);
    expect(prompt).toContain('CONTENT MUST FIT ITS FRAME');
    expect(prompt).toContain('spill below the frame');
  });
});
