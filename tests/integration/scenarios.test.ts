// Integration tests — realistic multi-tool design scenarios.
//
// These exercise the system the way a real agent would: a sequence of tool
// calls that build on each other, with the document state flowing through
// the same ctx.applyPatch → useCanvasStore._onSync pipeline the production
// runner uses.
//
// Scenarios:
//   1. "Design a card": create shape → add text → group → align → style
//   2. "Wireframe + palette + copy": bulk_add wireframe → apply_palette → generate_copy
//   3. "Design system": update_tokens → bind shapes → re-theme via tokens
//   4. "Layer organization": create 5 shapes → organize_layers → zorder fixups
//   5. "Find & replace": create text shapes → find_replace_text → verify
//   6. "Lock + hide + find": lock some shapes → set_visible false on others → find_visible

import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { createCanvasTools, executeTool } from '@/lib/agent/tools';
import type { CanvasToolContext } from '@/lib/agent/tools';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types'
import type { PenChild } from '@/lib/pen/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';

// ---- Fixtures ----------------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'test-doc',
    name: 'Test',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

function makeShape(id: string, overrides: Partial<Shape> = {}): Shape {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill: '#cccccc', stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    ...overrides,
  };
}

function resetStore(doc: CanvasDocument = makeDoc([])) {
  useCanvasStore.setState({
    document: doc,
    selectedIds: [],
    agentHighlightIds: [],
    socket: null,
    connected: false,
    viewerCount: 1,
    turns: [],
    agentBusy: false,
    documentId: 'test-doc',
    activeSessionId: null,
    undoStack: [],
    redoStack: [],
  });
  useSessionStore.setState({
    sessions: {},
    runs: {},
    messages: {},
    toolCalls: {},
    snapshots: {},
    activeSessionByDoc: {},
  });
}

function makeIntegrationCtx(): { ctx: CanvasToolContext; patches: CanvasPatch[] } {
  const initial = useCanvasStore.getState().document;
  let canvas: CanvasDocument = JSON.parse(JSON.stringify(initial));
  const patches: CanvasPatch[] = [];

  const ctx: CanvasToolContext = {
    getShapes: () => canvas.shapes,
    getTokens: () => canvas.tokens,
    getDocument: () => canvas,
    applyPatch(patch: CanvasPatch): CanvasPatch {
      patches.push(patch);
      canvas = applyPatchToCanvas(canvas, patch);
      useCanvasStore.getState()._onSync({ type: 'canvas:patch', patch });
      return patch;
    },
  };
  return { ctx, patches };
}

async function run(ctx: CanvasToolContext, name: string, args: any) {
  const tools = createCanvasTools(ctx);
  return executeTool(tools, name, args);
}

function firstShapeId(content: string): string {
  const m = content.match(/id[:\s]+([a-f0-9-]{8,})/i) ?? content.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return m ? m[1] : '';
}

// ---- Tests -------------------------------------------------------------------

describe('scenario: design a card (create → text → group → align → shadow)', () => {
  beforeEach(() => resetStore());

  it('builds a styled card group with shadow + rounded corners', async () => {
    const { ctx } = makeIntegrationCtx();

    // 1. Card background — shape fields at top level.
    const cardRes = await run(ctx, 'pen_create_shape', {
      type: 'rectangle',
      name: 'Card',
      x: 100, y: 100, width: 320, height: 200,
      fill: '#ffffff', radius: 12,
    });
    expect(cardRes.isError).toBeFalsy();
    const cardId = firstShapeId(cardRes.content);
    expect(cardId).not.toBe('');

    // 2. Title text.
    const titleRes = await run(ctx, 'pen_create_shape', {
      type: 'text',
      name: 'Title',
      x: 120, y: 120, width: 280, height: 32,
      text: 'Welcome back', fontSize: 24, textColor: '#0f172a',
    });
    const titleId = firstShapeId(titleRes.content);

    // 3. Body text.
    const bodyRes = await run(ctx, 'pen_create_shape', {
      type: 'text',
      name: 'Body',
      x: 120, y: 160, width: 280, height: 24,
      text: 'You have 3 new messages.', fontSize: 14, textColor: '#475569',
    });
    const bodyId = firstShapeId(bodyRes.content);

    // 4. Group them. The group tool's content doesn't surface the new group
    // id (it's generated inside applyPatchToCanvas), so we look the group
    // up by type after the fact.
    const groupRes = await run(ctx, 'pen_group_shapes', { shapeIds: [cardId, titleId, bodyId] });
    expect(groupRes.isError).toBeFalsy();

    // 5. Apply shadow to the card — x/y/blur/color are flat at the top level.
    await run(ctx, 'pen_set_shadow', {
      shapeId: cardId,
      x: 0, y: 4, blur: 12, color: '#000000',
    });

    // 6. Per-corner radius on the card (asymmetric for fun) — flat at top level.
    await run(ctx, 'pen_set_corner_radius_per_corner', {
      shapeId: cardId,
      topLeft: 16, topRight: 16, bottomRight: 4, bottomLeft: 4,
    });

    // Verify final state through the store.
    const doc = useCanvasStore.getState().document;
    expect(doc.shapes.length).toBe(4); // 3 originals + 1 group

    const card = doc.shapes.find((s) => s.id === cardId)!;
    expect(card.shadow).not.toBeNull();
    expect(card.shadow!.blur).toBe(12);
    expect(card.radii).not.toBeNull();
    expect(card.radii!.topLeft).toBe(16);
    expect(card.radii!.bottomRight).toBe(4);

    // The group is the only shape of type 'group'; the three originals are
    // its children (parentId points at it).
    const group = doc.shapes.find((s) => s.type === 'group')!;
    expect(group).toBeDefined();
    const groupId = group.id;
    const children = doc.shapes.filter((s) => s.parentId === groupId);
    expect(children.map((s) => s.id).sort()).toEqual([bodyId, cardId, titleId].sort());

    // Undo stack should have 6 entries (one per mutating tool call).
    expect(useCanvasStore.getState().undoStack).toHaveLength(6);

    // Undo all the way back to empty.
    for (let i = 0; i < 6; i++) useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document.shapes).toHaveLength(0);

    // Redo all the way forward.
    for (let i = 0; i < 6; i++) useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().document.shapes).toHaveLength(4);
    expect(useCanvasStore.getState().document.shapes.find((s) => s.id === cardId)!.shadow).not.toBeNull();
  });
});

describe('scenario: design system with tokens + binding', () => {
  beforeEach(() => resetStore());

  it('re-themes shapes by changing token values (live binding)', async () => {
    const { ctx } = makeIntegrationCtx();

    // 1. Define design tokens — `colors` is flat at the top level of the params.
    await run(ctx, 'pen_update_tokens', {
      colors: [
        { name: 'Brand Primary', key: 'brand.primary', value: '#3b82f6' },
        { name: 'Text Body', key: 'text.body', value: '#1e293b' },
      ],
    });

    // 2. Create three button shapes.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await run(ctx, 'pen_create_shape', {
        type: 'rectangle',
        name: `Btn ${i + 1}`,
        x: i * 120, y: 0, width: 100, height: 40,
        fill: '#cccccc',
      });
      ids.push(firstShapeId(r.content));
    }

    // 3. Bind all three to brand.primary (also applies the value immediately).
    await run(ctx, 'pen_apply_token', {
      tokenKey: 'brand.primary',
      shapeIds: ids,
      property: 'fill',
      bind: true,
    });

    // All three should now be blue.
    const afterBind = useCanvasStore.getState().document;
    for (const id of ids) {
      const s = afterBind.shapes.find((x) => x.id === id)!;
      expect(s.fill.toLowerCase()).toBe('#3b82f6');
      expect(s.tokenBinding?.fillToken).toBe('brand.primary');
    }

    // 4. Re-theme: change brand.primary to red.
    await run(ctx, 'pen_update_tokens', {
      colors: [{ name: 'Brand Primary', key: 'brand.primary', value: '#ef4444' }],
    });

    // All three buttons should now be red — the tokens-patch re-application
    // in patch.ts propagated the change to bound shapes.
    const afterTheme = useCanvasStore.getState().document;
    for (const id of ids) {
      const s = afterTheme.shapes.find((x) => x.id === id)!;
      expect(s.fill.toLowerCase()).toBe('#ef4444');
      // Binding still in place.
      expect(s.tokenBinding?.fillToken).toBe('brand.primary');
    }

    // 5. Unbind one button and re-theme — only 2 should change.
    await run(ctx, 'pen_unbind_shape', { shapeId: ids[0], property: 'fill' });
    await run(ctx, 'pen_update_tokens', {
      colors: [{ name: 'Brand Primary', key: 'brand.primary', value: '#10b981' }],
    });

    const afterUnbind = useCanvasStore.getState().document;
    expect(afterUnbind.shapes.find((x) => x.id === ids[0])!.fill.toLowerCase()).toBe('#ef4444'); // still red
    expect(afterUnbind.shapes.find((x) => x.id === ids[1])!.fill.toLowerCase()).toBe('#10b981');
    expect(afterUnbind.shapes.find((x) => x.id === ids[2])!.fill.toLowerCase()).toBe('#10b981');
  });
});

describe('scenario: find & replace text across multiple text shapes', () => {
  beforeEach(() => resetStore());

  it('replaces "lorem" with "real" in all matching text shapes', async () => {
    const { ctx } = makeIntegrationCtx();

    // Create 4 text shapes, 3 of which contain "lorem" in their text.
    const ids: string[] = [];
    for (const [name, text] of [
      ['Heading', 'Welcome to lorem'],
      ['Body 1', 'lorem ipsum dolor'],
      ['Body 2', 'sed do eiusmod lorem'],
      ['Footer', 'No match here'],
    ] as const) {
      const r = await run(ctx, 'pen_create_shape', {
        type: 'text',
        name,
        x: 0, y: 0, width: 200, height: 24,
        text, fontSize: 14, textColor: '#000',
      });
      ids.push(firstShapeId(r.content));
    }

    // find_shapes with no filter returns all.
    const findRes = await run(ctx, 'pen_find_shapes', {});
    expect(findRes.isError).toBeFalsy();
    expect(findRes.content).toContain('Heading');
    expect(findRes.content).toContain('Body 1');
    expect(findRes.content).toContain('Body 2');
    expect(findRes.content).toContain('Footer');

    // Find & replace via the dedicated tool.
    const replaceRes = await run(ctx, 'pen_find_replace_text', { find: 'lorem', replace: 'real' });
    expect(replaceRes.isError).toBeFalsy();
    expect(replaceRes.content).toContain('3 text shape');

    const doc = useCanvasStore.getState().document;
    expect(doc.shapes.find((s) => s.name === 'Heading')!.text).toBe('Welcome to real');
    expect(doc.shapes.find((s) => s.name === 'Body 1')!.text).toBe('real ipsum dolor');
    expect(doc.shapes.find((s) => s.name === 'Body 2')!.text).toBe('sed do eiusmod real');
    expect(doc.shapes.find((s) => s.name === 'Footer')!.text).toBe('No match here');
  });
});

describe('scenario: lock + hide + find by visibility', () => {
  beforeEach(() => resetStore());

  it('locks and hides shapes; find_shapes still sees them but filters accordingly', async () => {
    resetStore(makeDoc([
      makeShape('visible-unlocked', { fill: '#ff0000', visible: true, locked: false }),
      makeShape('hidden-unlocked', { fill: '#00ff00', visible: false, locked: false }),
      makeShape('visible-locked', { fill: '#0000ff', visible: true, locked: true }),
    ]));
    const { ctx } = makeIntegrationCtx();

    // Lock visible-unlocked via the tool.
    await run(ctx, 'pen_set_locked', { shapeIds: ['visible-unlocked'], locked: true });
    expect(useCanvasStore.getState().document.shapes.find((s) => s.id === 'visible-unlocked')!.locked).toBe(true);

    // Hide visible-locked via the tool.
    await run(ctx, 'pen_set_visible', { shapeIds: ['visible-locked'], visible: false });
    expect(useCanvasStore.getState().document.shapes.find((s) => s.id === 'visible-locked')!.visible).toBe(false);

    // find_shapes returns all matches regardless of visibility/lock.
    const findRes = await run(ctx, 'pen_find_shapes', {});
    expect(findRes.content).toContain('visible-unlocked');
    expect(findRes.content).toContain('hidden-unlocked');
    expect(findRes.content).toContain('visible-locked');

    // Verify undo reverts the visibility change.
    useCanvasStore.getState().undo(); // revert set_visible
    expect(useCanvasStore.getState().document.shapes.find((s) => s.id === 'visible-locked')!.visible).toBe(true);
    useCanvasStore.getState().undo(); // revert set_locked
    expect(useCanvasStore.getState().document.shapes.find((s) => s.id === 'visible-unlocked')!.locked).toBe(false);
  });
});

describe('scenario: z-order across multiple operations', () => {
  beforeEach(() => resetStore());

  it('bring_to_front then move_backward then send_to_back leaves consistent z-indices', async () => {
    resetStore(makeDoc([
      makeShape('a', { zIndex: 0 }),
      makeShape('b', { zIndex: 1 }),
      makeShape('c', { zIndex: 2 }),
      makeShape('d', { zIndex: 3 }),
    ]));
    const { ctx } = makeIntegrationCtx();

    // Bring 'a' to front.
    await run(ctx, 'pen_bring_to_front', { shapeIds: ['a'] });
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['b', 'c', 'd', 'a']);

    // Move 'a' backward by one.
    await run(ctx, 'pen_move_backward', { shapeId: 'a' });
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['b', 'c', 'a', 'd']);

    // Send 'a' all the way to back.
    await run(ctx, 'pen_send_to_back', { shapeIds: ['a'] });
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);

    // z-indices should be 0..3 sequential.
    const z = useCanvasStore.getState().document.shapes.map((s) => s.zIndex);
    expect(z).toEqual([0, 1, 2, 3]);

    // Three mutations → three undo entries.
    expect(useCanvasStore.getState().undoStack).toHaveLength(3);

    // Undo back to the starting order.
    useCanvasStore.getState().undo();
    useCanvasStore.getState().undo();
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('scenario: export SVG reflects the actual document state', () => {
  beforeEach(() => resetStore());

  it('export_svg after a series of mutations includes the latest fills', async () => {
    const { ctx } = makeIntegrationCtx();

    await run(ctx, 'pen_create_shape', {
      type: 'rectangle',
      name: 'Hero',
      x: 0, y: 0, width: 400, height: 200,
      fill: '#ff0000',
    });
    await run(ctx, 'pen_create_shape', {
      type: 'ellipse',
      name: 'Avatar',
      x: 50, y: 50, width: 80, height: 80,
      fill: '#00ff00',
    });

    // Update hero fill.
    const heroId = useCanvasStore.getState().document.shapes[0].id;
    await run(ctx, 'pen_update_shape', { shapeId: heroId, changes: { fill: '#0000ff' } });

    const r = await run(ctx, 'pen_export_svg', {});
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('<svg');
    expect(r.content).toContain('</svg>');
    // The latest fill (blue) should be in the SVG, not the original red.
    expect(r.content.toLowerCase()).toContain('#0000ff');
    expect(r.content.toLowerCase()).not.toContain('#ff0000');
    // The ellipse's green fill should also be present.
    expect(r.content.toLowerCase()).toContain('#00ff00');
    // And the ellipse element should be an <ellipse>, not a default rect.
    expect(r.content).toContain('<ellipse');
  });
});

describe('scenario: multiple shape creations batch into a single bulk_add', () => {
  beforeEach(() => resetStore());

  it('generate_wireframe emits one bulk_add patch that creates many shapes atomically', async () => {
    const { ctx, patches } = makeIntegrationCtx();

    const r = await run(ctx, 'pen_generate_wireframe', {
      template: 'web_landing',
      title: 'Acme',
    });
    expect(r.isError).toBeFalsy();

    // The wireframe should have emitted at least one bulk_add patch.
    const bulkAdds = patches.filter((p) => p.op === 'bulk_add');
    expect(bulkAdds.length).toBeGreaterThanOrEqual(1);

    // Store's document should now have many shapes (frame + children).
    expect(useCanvasStore.getState().document.shapes.length).toBeGreaterThan(5);

    // Undo of the single bulk_add should clear all of them in one step.
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document.shapes).toHaveLength(0);

    // Redo restores.
    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().document.shapes.length).toBeGreaterThan(5);
  });
});
