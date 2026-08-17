// Tests for the 30 new agent tools added in Phase 1+2+5.
//
// Strategy:
//   - Use `executeTool` (already exported from tools.ts) to call each tool
//     by name with hand-crafted args.
//   - Maintain a tiny in-memory canvas state via a `CanvasToolContext` that
//     records every emitted patch and applies it through `applyPatchToCanvas`.
//   - For each tool we assert:
//       1. The return value's `content` text contains expected substrings.
//       2. The emitted patch has the correct `op` and key fields.
//       3. After applying the patch, the canvas state matches expectations.
//   - Error paths (missing shape, missing token, wrong type, …) are also
//     covered — they should return `isError: true`.

import { describe, it, expect, beforeEach } from 'vitest';
import { createCanvasTools, executeTool } from '@/lib/agent/tools';
import type { CanvasToolContext } from '@/lib/agent/tools';
import type { CanvasDocument, CanvasPatch, Shape, DesignTokens } from '@/lib/canvas/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';

// ---- In-memory test harness --------------------------------------------------

interface TestHarness {
  doc: CanvasDocument;
  patches: CanvasPatch[];
  ctx: CanvasToolContext;
  reset(): void;
  addShape(s: Partial<Shape> & { id: string }): Shape;
  setTokens(t: DesignTokens): void;
}

function makeHarness(): TestHarness {
  const doc: CanvasDocument = {
    id: 'doc-1',
    name: 'Test',
    background: '#ffffff',
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
  const patches: CanvasPatch[] = [];

  const ctx: CanvasToolContext = {
    getShapes: () => doc.shapes,
    getTokens: () => doc.tokens,
    getDocument: () => doc,
    applyPatch: (p) => {
      patches.push(p);
      // Apply to local doc so subsequent getShapes() calls see the change.
      const next = applyPatchToCanvas(doc, p);
      // Mutate in place — `doc` is the same reference the ctx closures hold.
      doc.shapes = next.shapes;
      doc.tokens = next.tokens;
      doc.children = next.children;
      doc.variables = next.variables;
      doc.themes = next.themes;
      doc.background = next.background;
      doc.viewport = next.viewport;
      return p;
    },
  };

  return {
    doc,
    patches,
    ctx,
    reset() {
      doc.shapes = [];
      doc.children = [];
      doc.variables = undefined;
      doc.themes = undefined;
      doc.tokens = { colors: [], textStyles: [] };
      patches.length = 0;
    },
    addShape(s) {
      const full: Shape = {
        type: 'rectangle',
        name: 'Shape',
        x: 0, y: 0, width: 100, height: 100,
        rotation: 0, opacity: 1,
        fill: '#e2e8f0', stroke: '#0f172a', strokeWidth: 0,
        radius: 0, fontSize: 16, textColor: '#0f172a',
        parentId: null, zIndex: doc.shapes.length,
        locked: false, visible: true,
        autoLayout: null, tokenBinding: null, componentId: null,
        points: null, closed: false, src: null, radii: null,
        gradient: null, shadow: null, blur: 0, maskId: null,
        ...s,
      };
      doc.shapes.push(full);
      return full;
    },
    setTokens(t) {
      doc.tokens = t;
    },
  };
}

// Convenience: get the tools array bound to the harness ctx.
function tools(h: TestHarness) {
  return createCanvasTools(h.ctx);
}

async function run(h: TestHarness, name: string, args: any = {}) {
  return executeTool(tools(h), name, args);
}

// ---- Setup -------------------------------------------------------------------

let h: TestHarness;
beforeEach(() => {
  h = makeHarness();
});

// ---- Phase 1a: Token binding -------------------------------------------------

describe('tools: pen_bind_shape_to_token', () => {
  it('binds fill to a token and applies the value', async () => {
    h.addShape({ id: 's1', fill: '#000000' });
    h.setTokens({
      colors: [{ name: 'Primary', key: 'bg.primary', value: '#ff0000' }],
      textStyles: [],
    });
    const r = await run(h, 'pen_bind_shape_to_token', {
      shapeId: 's1', tokenKey: 'bg.primary', property: 'fill',
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('bg.primary');
    expect(h.doc.shapes[0].fill).toBe('#ff0000');
    expect(h.doc.shapes[0].tokenBinding?.fillToken).toBe('bg.primary');
  });

  it('binds stroke and textColor correctly', async () => {
    h.addShape({ id: 's2' });
    h.setTokens({
      colors: [
        { name: 'B', key: 'border', value: '#111111' },
        { name: 'T', key: 'text', value: '#222222' },
      ],
      textStyles: [],
    });
    await run(h, 'pen_bind_shape_to_token', { shapeId: 's2', tokenKey: 'border', property: 'stroke' });
    await run(h, 'pen_bind_shape_to_token', { shapeId: 's2', tokenKey: 'text', property: 'textColor' });
    expect(h.doc.shapes[0].stroke).toBe('#111111');
    expect(h.doc.shapes[0].textColor).toBe('#222222');
    expect(h.doc.shapes[0].tokenBinding?.strokeToken).toBe('border');
    expect(h.doc.shapes[0].tokenBinding?.textToken).toBe('text');
  });

  it('returns isError when the shape does not exist', async () => {
    h.setTokens({ colors: [{ name: 'A', key: 'a', value: '#fff' }], textStyles: [] });
    const r = await run(h, 'pen_bind_shape_to_token', {
      shapeId: 'nope', tokenKey: 'a', property: 'fill',
    });
    expect(r.isError).toBe(true);
  });

  it('returns isError when the token does not exist', async () => {
    h.addShape({ id: 's3' });
    const r = await run(h, 'pen_bind_shape_to_token', {
      shapeId: 's3', tokenKey: 'no-such-token', property: 'fill',
    });
    expect(r.isError).toBe(true);
  });
});

describe('tools: pen_unbind_shape', () => {
  it('removes the fill binding', async () => {
    h.addShape({ id: 's1', tokenBinding: { fillToken: 'bg.primary' } });
    const r = await run(h, 'pen_unbind_shape', { shapeId: 's1', property: 'fill' });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes[0].tokenBinding?.fillToken).toBeUndefined();
    // When the binding becomes empty, it should be set to null.
    expect(h.doc.shapes[0].tokenBinding).toBeNull();
  });

  it('preserves other bindings when unbinding one property', async () => {
    h.addShape({
      id: 's2',
      tokenBinding: { fillToken: 'a', strokeToken: 'b' },
    });
    await run(h, 'pen_unbind_shape', { shapeId: 's2', property: 'fill' });
    expect(h.doc.shapes[0].tokenBinding?.strokeToken).toBe('b');
    expect(h.doc.shapes[0].tokenBinding?.fillToken).toBeUndefined();
  });

  it('returns isError when the shape does not exist', async () => {
    const r = await run(h, 'pen_unbind_shape', { shapeId: 'nope', property: 'fill' });
    expect(r.isError).toBe(true);
  });
});

describe('tools: pen_list_tokens', () => {
  it('lists colors and text styles', async () => {
    h.setTokens({
      colors: [{ name: 'Primary', key: 'bg.primary', value: '#ff0000' }],
      textStyles: [
        { name: 'Heading', key: 'h1', fontSize: 32, fontWeight: 700, lineHeight: 1.2, color: '#000' },
      ],
    });
    const r = await run(h, 'pen_list_tokens', {});
    expect(r.content).toContain('bg.primary');
    expect(r.content).toContain('Primary');
    expect(r.content).toContain('h1');
    expect(r.content).toContain('Heading');
  });

  it('handles an empty token set', async () => {
    const r = await run(h, 'pen_list_tokens', {});
    expect(r.content).toContain('(none)');
  });
});

describe('tools: pen_apply_token', () => {
  it('applies a token to multiple shapes (no binding)', async () => {
    h.addShape({ id: 's1' });
    h.addShape({ id: 's2' });
    h.setTokens({ colors: [{ name: 'A', key: 'a', value: '#ff00ff' }], textStyles: [] });
    const r = await run(h, 'pen_apply_token', {
      shapeIds: ['s1', 's2'], tokenKey: 'a', property: 'fill',
    });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes[0].fill).toBe('#ff00ff');
    expect(h.doc.shapes[1].fill).toBe('#ff00ff');
    expect(h.doc.shapes[0].tokenBinding).toBeNull();
  });

  it('applies a token AND binds when bind=true', async () => {
    h.addShape({ id: 's1' });
    h.setTokens({ colors: [{ name: 'A', key: 'a', value: '#00ff00' }], textStyles: [] });
    await run(h, 'pen_apply_token', {
      shapeIds: ['s1'], tokenKey: 'a', property: 'fill', bind: true,
    });
    expect(h.doc.shapes[0].fill).toBe('#00ff00');
    expect(h.doc.shapes[0].tokenBinding?.fillToken).toBe('a');
  });

  it('returns isError when the token does not exist', async () => {
    const r = await run(h, 'pen_apply_token', {
      shapeIds: ['s1'], tokenKey: 'no', property: 'fill',
    });
    expect(r.isError).toBe(true);
  });
});

// ---- Phase 1b: Lock & visibility ---------------------------------------------

describe('tools: pen_set_locked', () => {
  it('locks shapes', async () => {
    h.addShape({ id: 's1', locked: false });
    h.addShape({ id: 's2', locked: false });
    const r = await run(h, 'pen_set_locked', { shapeIds: ['s1', 's2'], locked: true });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes[0].locked).toBe(true);
    expect(h.doc.shapes[1].locked).toBe(true);
  });

  it('unlocks shapes', async () => {
    h.addShape({ id: 's1', locked: true });
    await run(h, 'pen_set_locked', { shapeIds: ['s1'], locked: false });
    expect(h.doc.shapes[0].locked).toBe(false);
  });
});

describe('tools: pen_set_visible', () => {
  it('hides shapes', async () => {
    h.addShape({ id: 's1', visible: true });
    await run(h, 'pen_set_visible', { shapeIds: ['s1'], visible: false });
    expect(h.doc.shapes[0].visible).toBe(false);
  });

  it('shows shapes', async () => {
    h.addShape({ id: 's1', visible: false });
    await run(h, 'pen_set_visible', { shapeIds: ['s1'], visible: true });
    expect(h.doc.shapes[0].visible).toBe(true);
  });
});

// ---- Phase 1c: Z-order -------------------------------------------------------

describe('tools: pen_bring_to_front', () => {
  it('emits a zorder=front patch', async () => {
    h.addShape({ id: 'a' });
    h.addShape({ id: 'b' });
    const r = await run(h, 'pen_bring_to_front', { shapeIds: ['a'] });
    expect(r.isError).toBeFalsy();
    expect(h.patches[0].op).toBe('zorder');
    expect(h.patches[0].zorderKind).toBe('front');
    expect(h.doc.shapes.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('tools: pen_send_to_back', () => {
  it('emits a zorder=back patch', async () => {
    h.addShape({ id: 'a' });
    h.addShape({ id: 'b' });
    const r = await run(h, 'pen_send_to_back', { shapeIds: ['b'] });
    expect(r.isError).toBeFalsy();
    expect(h.patches[0].zorderKind).toBe('back');
    expect(h.doc.shapes.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('tools: pen_move_forward', () => {
  it('emits a zorder=forward patch for a single shape', async () => {
    h.addShape({ id: 'a' });
    h.addShape({ id: 'b' });
    h.addShape({ id: 'c' });
    await run(h, 'pen_move_forward', { shapeId: 'b' });
    expect(h.patches[0].zorderKind).toBe('forward');
    expect(h.doc.shapes.map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('tools: pen_move_backward', () => {
  it('emits a zorder=backward patch for a single shape', async () => {
    h.addShape({ id: 'a' });
    h.addShape({ id: 'b' });
    h.addShape({ id: 'c' });
    await run(h, 'pen_move_backward', { shapeId: 'b' });
    expect(h.patches[0].zorderKind).toBe('backward');
    expect(h.doc.shapes.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('tools: pen_reorder_shape', () => {
  it('emits a reorder patch with the target zIndex', async () => {
    h.addShape({ id: 'a' });
    h.addShape({ id: 'b' });
    h.addShape({ id: 'c' });
    await run(h, 'pen_reorder_shape', { shapeId: 'c', zIndex: 0 });
    expect(h.patches[0].op).toBe('reorder');
    expect(h.patches[0].zIndex).toBe(0);
    expect(h.doc.shapes.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });
});

// ---- Phase 2a: Undo / redo ---------------------------------------------------

describe('tools: pen_undo / pen_redo', () => {
  it('emits an undo patch (op=undo)', async () => {
    const r = await run(h, 'pen_undo', {});
    expect(r.isError).toBeFalsy();
    expect(h.patches[0].op).toBe('undo');
  });

  it('emits a redo patch (op=redo)', async () => {
    const r = await run(h, 'pen_redo', {});
    expect(r.isError).toBeFalsy();
    expect(h.patches[0].op).toBe('redo');
  });
});

// ---- Phase 2b: Export --------------------------------------------------------

describe('tools: pen_export_json', () => {
  it('returns the document as JSON', async () => {
    h.addShape({ id: 's1', type: 'rectangle' });
    const r = await run(h, 'pen_export_json', {});
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('doc-1');
    expect(r.content).toContain('"shapes"');
    expect(r.content).toContain('"s1"');
  });
});

describe('tools: pen_export_svg', () => {
  it('returns SVG markup with the shapes', async () => {
    h.addShape({ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, fill: '#ff0000' });
    const r = await run(h, 'pen_export_svg', {});
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('<svg');
    expect(r.content).toContain('<rect');
    expect(r.content).toContain('#ff0000');
  });

  it('renders a path shape as <polygon> when closed', async () => {
    h.addShape({
      id: 'p1', type: 'path', closed: true,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }],
      fill: '#00ff00',
    });
    const r = await run(h, 'pen_export_svg', {});
    expect(r.content).toContain('<polygon');
    expect(r.content).toContain('#00ff00');
  });

  it('renders a path shape as <polyline> when open', async () => {
    h.addShape({
      id: 'p2', type: 'path', closed: false,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      stroke: '#000', strokeWidth: 2,
    });
    const r = await run(h, 'pen_export_svg', {});
    expect(r.content).toContain('<polyline');
  });

  it('renders an image shape as <image>', async () => {
    h.addShape({ id: 'i1', type: 'image', src: 'https://x/y.png', x: 0, y: 0, width: 50, height: 50 });
    const r = await run(h, 'pen_export_svg', {});
    expect(r.content).toContain('<image');
    expect(r.content).toContain('https://x/y.png');
  });

  it('returns empty when there are no shapes', async () => {
    const r = await run(h, 'pen_export_svg', {});
    expect(r.content).toContain('No shapes');
  });

  it('filters to a frame when frameId is given', async () => {
    h.addShape({ id: 'f1', type: 'frame', x: 0, y: 0, width: 100, height: 100 });
    h.addShape({ id: 'inner', type: 'rectangle', x: 10, y: 10, width: 20, height: 20, fill: '#ff0000' });
    h.addShape({ id: 'outer', type: 'rectangle', x: 500, y: 500, width: 10, height: 10, fill: '#00ff00' });
    const r = await run(h, 'pen_export_svg', { frameId: 'f1' });
    // The SVG should be sized to the inner shape (20x20), not the outer (510x510).
    expect(r.content).toContain('width="20"');
    expect(r.content).toContain('height="20"');
    expect(r.content).toContain('#ff0000'); // inner's fill
    expect(r.content).not.toContain('#00ff00'); // outer's fill — must be excluded
    expect(r.content).toContain('1 shapes'); // only inner
  });
});

describe('tools: pen_export_png', () => {
  it('returns an SVG data URL', async () => {
    h.addShape({ id: 's1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });
    // Call the tool directly so we can inspect `details.dataUrl` (executeTool
    // only surfaces the text content + patch).
    const tool = tools(h).find((t) => t.name === 'pen_export_png')!;
    const result: any = await tool.execute('call-1', {}, undefined, undefined, undefined as any);
    const dataUrl = result.details?.dataUrl as string | undefined;
    expect(dataUrl).toBeTruthy();
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(result.content[0].text).toContain('Exported as SVG data URL');
  });

  it('returns empty when there are no shapes', async () => {
    const r = await run(h, 'pen_export_png', {});
    expect(r.content).toContain('No shapes');
  });
});

describe('tools: pen_copy_as_code', () => {
  it('generates HTML with absolutely-positioned divs', async () => {
    h.addShape({ id: 's1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, fill: '#ff0000' });
    const r = await run(h, 'pen_copy_as_code', { framework: 'html' });
    expect(r.content).toContain('position:absolute');
    expect(r.content).toContain('#ff0000');
  });

  it('generates React component code', async () => {
    h.addShape({ id: 's1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });
    const r = await run(h, 'pen_copy_as_code', { framework: 'react' });
    expect(r.content).toContain('export function CanvasExport');
  });

  it('escapes HTML in text shapes', async () => {
    h.addShape({ id: 't1', type: 'text', text: '<script>alert(1)</script>', x: 0, y: 0 });
    const r = await run(h, 'pen_copy_as_code', { framework: 'html' });
    expect(r.content).not.toContain('<script>alert(1)</script>');
    expect(r.content).toContain('&lt;script&gt;');
  });
});

// ---- Phase 2c: Find & filter -------------------------------------------------

describe('tools: pen_find_shapes', () => {
  it('filters by type', async () => {
    h.addShape({ id: 'r1', type: 'rectangle' });
    h.addShape({ id: 'e1', type: 'ellipse' });
    h.addShape({ id: 'e2', type: 'ellipse' });
    const r = await run(h, 'pen_find_shapes', { type: 'ellipse' });
    expect(r.content).toContain('e1');
    expect(r.content).toContain('e2');
    expect(r.content).not.toContain('r1');
  });

  it('filters by fill color', async () => {
    h.addShape({ id: 'a', fill: '#ff0000' });
    h.addShape({ id: 'b', fill: '#00ff00' });
    const r = await run(h, 'pen_find_shapes', { fill: '#ff0000' });
    expect(r.content).toContain('a');
    expect(r.content).not.toContain('b');
  });

  it('filters by name substring (case-insensitive)', async () => {
    h.addShape({ id: 's-a', name: 'Submit Button' });
    h.addShape({ id: 's-b', name: 'Cancel' });
    const r = await run(h, 'pen_find_shapes', { nameContains: 'button' });
    // The report includes the matching shape's id and name.
    expect(r.content).toContain('s-a');
    expect(r.content).toContain('Submit Button');
    // The non-matching shape's id and name must not appear.
    expect(r.content).not.toContain('s-b');
    expect(r.content).not.toContain('Cancel');
  });

  it('filters by parentId', async () => {
    h.addShape({ id: 'p', type: 'frame' });
    h.addShape({ id: 'c1', parentId: 'p' });
    h.addShape({ id: 'c2', parentId: null });
    const r = await run(h, 'pen_find_shapes', { parentId: 'p' });
    expect(r.content).toContain('c1');
    expect(r.content).not.toContain('c2');
  });
});

describe('tools: pen_bulk_update_by_filter', () => {
  it('updates all matching shapes in one patch', async () => {
    h.addShape({ id: 'r1', type: 'rectangle', fill: '#aaa' });
    h.addShape({ id: 'r2', type: 'rectangle', fill: '#aaa' });
    h.addShape({ id: 'e1', type: 'ellipse', fill: '#aaa' });
    const r = await run(h, 'pen_bulk_update_by_filter', {
      type: 'rectangle',
      changes: { fill: '#ff0000' },
    });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes.find((s) => s.id === 'r1')!.fill).toBe('#ff0000');
    expect(h.doc.shapes.find((s) => s.id === 'r2')!.fill).toBe('#ff0000');
    expect(h.doc.shapes.find((s) => s.id === 'e1')!.fill).toBe('#aaa');
  });

  it('returns isError when no shapes match', async () => {
    const r = await run(h, 'pen_bulk_update_by_filter', {
      type: 'ellipse',
      changes: { fill: '#ff0000' },
    });
    expect(r.isError).toBe(true);
  });
});

describe('tools: pen_find_replace_text', () => {
  it('replaces text in matching text shapes', async () => {
    h.addShape({ id: 't1', type: 'text', text: 'Hello World' });
    h.addShape({ id: 't2', type: 'text', text: 'Hello there' });
    h.addShape({ id: 't3', type: 'text', text: 'Goodbye' });
    const r = await run(h, 'pen_find_replace_text', { find: 'Hello', replace: 'Welcome' });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes.find((s) => s.id === 't1')!.text).toBe('Welcome World');
    expect(h.doc.shapes.find((s) => s.id === 't2')!.text).toBe('Welcome there');
    expect(h.doc.shapes.find((s) => s.id === 't3')!.text).toBe('Goodbye');
  });

  it('escapes regex special characters in the find string', async () => {
    h.addShape({ id: 't1', type: 'text', text: 'price: $9.99 (was $20.00)' });
    const r = await run(h, 'pen_find_replace_text', { find: '$9.99', replace: '$9' });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes[0].text).toBe('price: $9 (was $20.00)');
  });

  it('returns no error when no text shapes match', async () => {
    h.addShape({ id: 't1', type: 'text', text: 'Nothing' });
    const r = await run(h, 'pen_find_replace_text', { find: 'missing', replace: 'x' });
    expect(r.content).toContain('No text shapes');
  });
});

// ---- Phase 5a: Vector editing ------------------------------------------------

describe('tools: pen_create_path', () => {
  it('creates a closed polygon', async () => {
    const r = await run(h, 'pen_create_path', {
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }],
      closed: true,
      fill: '#00ff00',
    });
    expect(r.isError).toBeFalsy();
    const s = h.doc.shapes[0];
    expect(s.type).toBe('path');
    expect(s.closed).toBe(true);
    expect(s.points).toHaveLength(3);
    expect(s.fill).toBe('#00ff00');
    // Bounding box should be computed from points.
    expect(s.x).toBe(0);
    expect(s.y).toBe(0);
    expect(s.width).toBe(10);
    expect(s.height).toBe(5);
  });

  it('creates an open polyline with stroke', async () => {
    const r = await run(h, 'pen_create_path', {
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      closed: false,
    });
    expect(r.isError).toBeFalsy();
    const s = h.doc.shapes[0];
    expect(s.closed).toBe(false);
    expect(s.strokeWidth).toBe(2); // default for open paths
  });

  it('returns isError when fewer than 2 points', async () => {
    const r = await run(h, 'pen_create_path', {
      points: [{ x: 0, y: 0 }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('at least 2');
  });

  it('returns isError when points is not an array', async () => {
    const r = await run(h, 'pen_create_path', { points: null as any });
    expect(r.isError).toBe(true);
  });
});

describe('tools: pen_boolean_op', () => {
  it('union groups two shapes', async () => {
    h.addShape({ id: 'a' });
    h.addShape({ id: 'b' });
    const r = await run(h, 'pen_boolean_op', {
      shapeId: 'a', otherShapeId: 'b', operation: 'union',
    });
    expect(r.isError).toBeFalsy();
    expect(h.patches[0].op).toBe('group');
    expect(h.patches[0].shapeIds).toEqual(['a', 'b']);
  });

  it('subtract sets maskId on the primary shape', async () => {
    h.addShape({ id: 'a' });
    h.addShape({ id: 'b' });
    await run(h, 'pen_boolean_op', {
      shapeId: 'a', otherShapeId: 'b', operation: 'subtract',
    });
    expect(h.doc.shapes.find((s) => s.id === 'a')!.maskId).toBe('b');
  });

  it('intersect behaves like subtract (maskId)', async () => {
    h.addShape({ id: 'a' });
    h.addShape({ id: 'b' });
    await run(h, 'pen_boolean_op', {
      shapeId: 'a', otherShapeId: 'b', operation: 'intersect',
    });
    expect(h.doc.shapes.find((s) => s.id === 'a')!.maskId).toBe('b');
  });

  it('exclude hides the second shape', async () => {
    h.addShape({ id: 'a', visible: true });
    h.addShape({ id: 'b', visible: true });
    await run(h, 'pen_boolean_op', {
      shapeId: 'a', otherShapeId: 'b', operation: 'exclude',
    });
    expect(h.doc.shapes.find((s) => s.id === 'b')!.visible).toBe(false);
  });

  it('returns isError when a shape is not found', async () => {
    const r = await run(h, 'pen_boolean_op', {
      shapeId: 'nope', otherShapeId: 'b', operation: 'union',
    });
    expect(r.isError).toBe(true);
  });
});

describe('tools: pen_mask_with', () => {
  it('sets maskId on the target', async () => {
    h.addShape({ id: 'a' });
    h.addShape({ id: 'b' });
    await run(h, 'pen_mask_with', { shapeId: 'a', maskShapeId: 'b' });
    expect(h.doc.shapes.find((s) => s.id === 'a')!.maskId).toBe('b');
  });

  it('removes the mask when maskShapeId is omitted', async () => {
    h.addShape({ id: 'a', maskId: 'b' });
    await run(h, 'pen_mask_with', { shapeId: 'a' });
    expect(h.doc.shapes.find((s) => s.id === 'a')!.maskId).toBeNull();
  });

  it('returns isError when the target shape does not exist', async () => {
    const r = await run(h, 'pen_mask_with', { shapeId: 'nope', maskShapeId: 'b' });
    expect(r.isError).toBe(true);
  });

  it('returns isError when the mask shape does not exist', async () => {
    h.addShape({ id: 'a' });
    const r = await run(h, 'pen_mask_with', { shapeId: 'a', maskShapeId: 'nope' });
    expect(r.isError).toBe(true);
  });
});

// ---- Phase 5b: Effects & styling ---------------------------------------------

describe('tools: pen_set_gradient_fill', () => {
  it('sets a linear gradient with 2 stops', async () => {
    h.addShape({ id: 's1', fill: '#aaaaaa' });
    const r = await run(h, 'pen_set_gradient_fill', {
      shapeId: 's1',
      type: 'linear',
      angle: 45,
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const g = h.doc.shapes[0].gradient!;
    expect(g.type).toBe('linear');
    expect(g.angle).toBe(45);
    expect(g.stops).toHaveLength(2);
    // Fill should be synced to the first stop's color.
    expect(h.doc.shapes[0].fill).toBe('#ff0000');
  });

  it('sets a radial gradient', async () => {
    h.addShape({ id: 's1' });
    await run(h, 'pen_set_gradient_fill', {
      shapeId: 's1',
      type: 'radial',
      stops: [
        { offset: 0, color: '#fff' },
        { offset: 1, color: '#000' },
      ],
    });
    expect(h.doc.shapes[0].gradient!.type).toBe('radial');
  });

  it('defaults the angle to 90 when omitted', async () => {
    h.addShape({ id: 's1' });
    await run(h, 'pen_set_gradient_fill', {
      shapeId: 's1',
      type: 'linear',
      stops: [
        { offset: 0, color: '#fff' },
        { offset: 1, color: '#000' },
      ],
    });
    expect(h.doc.shapes[0].gradient!.angle).toBe(90);
  });

  it('returns isError when the shape is not found', async () => {
    const r = await run(h, 'pen_set_gradient_fill', {
      shapeId: 'nope',
      type: 'linear',
      stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }],
    });
    expect(r.isError).toBe(true);
  });

  it('returns isError when fewer than 2 stops', async () => {
    h.addShape({ id: 's1' });
    const r = await run(h, 'pen_set_gradient_fill', {
      shapeId: 's1',
      type: 'linear',
      stops: [{ offset: 0, color: '#fff' }],
    });
    expect(r.isError).toBe(true);
  });
});

describe('tools: pen_set_shadow', () => {
  it('sets a drop shadow on a shape', async () => {
    h.addShape({ id: 's1' });
    const r = await run(h, 'pen_set_shadow', {
      shapeId: 's1', x: 2, y: 4, blur: 8, color: '#00000044',
    });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes[0].shadow).toEqual({
      x: 2, y: 4, blur: 8, color: '#00000044', spread: 0, inset: false,
    });
  });

  it('accepts optional spread and inset', async () => {
    h.addShape({ id: 's1' });
    await run(h, 'pen_set_shadow', {
      shapeId: 's1', x: 0, y: 0, blur: 4, color: '#000', spread: 2, inset: true,
    });
    expect(h.doc.shapes[0].shadow!.spread).toBe(2);
    expect(h.doc.shapes[0].shadow!.inset).toBe(true);
  });

  it('returns isError when the shape is not found', async () => {
    const r = await run(h, 'pen_set_shadow', {
      shapeId: 'nope', x: 0, y: 0, blur: 0, color: '#000',
    });
    expect(r.isError).toBe(true);
  });
});

describe('tools: pen_set_blur', () => {
  it('sets a Gaussian blur on a shape', async () => {
    h.addShape({ id: 's1' });
    await run(h, 'pen_set_blur', { shapeId: 's1', radius: 4 });
    expect(h.doc.shapes[0].blur).toBe(4);
  });

  it('clamps negative radius to 0', async () => {
    h.addShape({ id: 's1' });
    await run(h, 'pen_set_blur', { shapeId: 's1', radius: -5 });
    expect(h.doc.shapes[0].blur).toBe(0);
  });

  it('returns isError when the shape is not found', async () => {
    const r = await run(h, 'pen_set_blur', { shapeId: 'nope', radius: 4 });
    expect(r.isError).toBe(true);
  });
});

describe('tools: pen_set_corner_radius_per_corner', () => {
  it('sets independent radii on a rectangle', async () => {
    h.addShape({ id: 's1', type: 'rectangle' });
    const r = await run(h, 'pen_set_corner_radius_per_corner', {
      shapeId: 's1', topLeft: 4, topRight: 8, bottomRight: 12, bottomLeft: 16,
    });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes[0].radii).toEqual({
      topLeft: 4, topRight: 8, bottomRight: 12, bottomLeft: 16,
    });
  });

  it('works on a frame shape', async () => {
    h.addShape({ id: 's1', type: 'frame' });
    await run(h, 'pen_set_corner_radius_per_corner', {
      shapeId: 's1', topLeft: 2, topRight: 2, bottomRight: 2, bottomLeft: 2,
    });
    expect(h.doc.shapes[0].radii).toBeDefined();
  });

  it('returns isError when the shape is not a rectangle/frame', async () => {
    h.addShape({ id: 's1', type: 'ellipse' });
    const r = await run(h, 'pen_set_corner_radius_per_corner', {
      shapeId: 's1', topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0,
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('rectangle/frame');
  });

  it('clamps negative radii to 0', async () => {
    h.addShape({ id: 's1', type: 'rectangle' });
    await run(h, 'pen_set_corner_radius_per_corner', {
      shapeId: 's1', topLeft: -5, topRight: 0, bottomRight: 0, bottomLeft: 0,
    });
    expect(h.doc.shapes[0].radii!.topLeft).toBe(0);
  });
});

// ---- Phase 5c: Image support -------------------------------------------------

describe('tools: pen_upload_image', () => {
  it('places an image shape with a remote URL', async () => {
    const r = await run(h, 'pen_upload_image', {
      src: 'https://example.com/photo.jpg',
      x: 100, y: 50, width: 200, height: 100,
      name: 'Photo',
    });
    expect(r.isError).toBeFalsy();
    const s = h.doc.shapes[0];
    expect(s.type).toBe('image');
    expect(s.src).toBe('https://example.com/photo.jpg');
    expect(s.x).toBe(100);
    expect(s.y).toBe(50);
    expect(s.width).toBe(200);
    expect(s.height).toBe(100);
    expect(s.name).toBe('Photo');
  });

  it('defaults width and height to 200', async () => {
    await run(h, 'pen_upload_image', {
      src: 'data:image/png;base64,xxx',
      x: 0, y: 0,
    });
    expect(h.doc.shapes[0].width).toBe(200);
    expect(h.doc.shapes[0].height).toBe(200);
  });
});

describe('tools: pen_search_icons', () => {
  it('places a known icon as a path', async () => {
    const r = await run(h, 'pen_search_icons', {
      icon: 'check', x: 100, y: 100, size: 24,
    });
    expect(r.isError).toBeFalsy();
    const s = h.doc.shapes[0];
    expect(s.type).toBe('path');
    expect(s.name).toBe('Icon: check');
    expect(s.points!.length).toBeGreaterThan(0);
    expect(s.closed).toBe(false);
    expect(s.width).toBe(24);
    expect(s.height).toBe(24);
  });

  it('scales the icon to the requested size', async () => {
    await run(h, 'pen_search_icons', {
      icon: 'check', x: 0, y: 0, size: 48,
    });
    const s = h.doc.shapes[0];
    expect(s.width).toBe(48);
    expect(s.height).toBe(48);
    // The check icon's first point at 24px is at (20, 6).
    // At 48px (2x scale) it should be at (40, 12).
    expect(s.points![0]).toEqual({ x: 40, y: 12 });
  });

  it('uses default stroke color and width', async () => {
    await run(h, 'pen_search_icons', { icon: 'check', x: 0, y: 0 });
    const s = h.doc.shapes[0];
    expect(s.stroke).toBe('#0f172a');
    expect(s.strokeWidth).toBe(2);
  });

  it('returns isError when the icon name is unknown', async () => {
    const r = await run(h, 'pen_search_icons', { icon: 'definitely-not-real', x: 0, y: 0 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not found');
    expect(r.content).toContain('check'); // lists available icons
  });

  it('matches icon names case-insensitively', async () => {
    const r = await run(h, 'pen_search_icons', { icon: 'CHECK', x: 0, y: 0 });
    expect(r.isError).toBeFalsy();
  });
});

describe('tools: pen_generate_image', () => {
  it('places a placeholder rectangle + text label', async () => {
    const r = await run(h, 'pen_generate_image', {
      prompt: 'A sunset over mountains',
      x: 100, y: 100,
    });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes.length).toBe(2);
    // The placeholder rectangle.
    const placeholder = h.doc.shapes[0];
    expect(placeholder.type).toBe('rectangle');
    expect(placeholder.name).toContain('sunset over mountains');
    // The text label.
    const label = h.doc.shapes[1];
    expect(label.type).toBe('text');
    expect(label.text).toContain('A sunset over mountains');
  });

  it('uses default dimensions when not specified', async () => {
    await run(h, 'pen_generate_image', { prompt: 'x', x: 0, y: 0 });
    expect(h.doc.shapes[0].width).toBe(320);
    expect(h.doc.shapes[0].height).toBe(200);
  });

  it('places the label inside the placeholder rectangle', async () => {
    await run(h, 'pen_generate_image', {
      prompt: 'x', x: 50, y: 60, width: 300, height: 180,
    });
    const placeholder = h.doc.shapes[0];
    const label = h.doc.shapes[1];
    expect(label.x).toBeGreaterThanOrEqual(placeholder.x);
    expect(label.y).toBeGreaterThanOrEqual(placeholder.y);
    expect(label.x + label.width).toBeLessThanOrEqual(placeholder.x + placeholder.width);
  });
});

// ---- Tool registration sanity ------------------------------------------------

describe('tools: registration sanity', () => {
  it('returns 55 tools total', () => {
    const tools = createCanvasTools(h.ctx);
    expect(tools).toHaveLength(55);
  });

  it('every tool has a unique name', () => {
    const tools = createCanvasTools(h.ctx);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool has a non-empty description', () => {
    const tools = createCanvasTools(h.ctx);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(10);
    }
  });
});
