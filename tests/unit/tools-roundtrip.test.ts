// Tests for the client round-trip tools (spec §5.2 / Phase 3 — M2-c):
//
//   pen_get_computed  — live DOM readback with resolver fallback (never hangs)
//   pen_get_screenshot— client capture with server-side resvg fallback
//   pen_bake_layout   — measured-bounds writeback (update_many, dynamic skip)
//
// Uses the same in-memory CanvasToolContext harness as tools-mcp.test.ts.
// The event sink (plugins/event-bus) is installed per-test to exercise the
// round-trip paths; ROUNDTRIP_DEFAULTS timeouts are shrunk so timeouts cost
// milliseconds instead of seconds. renderCanvasToPng is module-mocked (resvg
// is a native dep — the fallback contract, not the pixels, is under test).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCanvasTools } from '@/lib/agent/tools';
import type { CanvasToolContext } from '@/lib/agent/tools';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { resolvePenTreeDetailed } from '@/lib/pen/resolve';
import { setEventSink } from '@/lib/agent/plugins/event-bus';
import {
  resolveComputedResponse,
  resolveScreenshotResponse,
  setMeasuredBounds,
  __resetClientRoundtripForTests,
  ROUNDTRIP_DEFAULTS,
} from '@/lib/agent/client-roundtrip';
import type { SyncEvent } from '@/lib/canvas/types';

vi.mock('@/lib/canvas/render-to-png', () => ({
  renderCanvasToPng: vi.fn(async () => Buffer.from('fake-png-bytes-for-tests')),
  renderCanvasToSvg: vi.fn(() => '<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
}));

// ---- In-memory test harness (same pattern as tools-mcp.test.ts) ---------------

interface TestHarness {
  doc: CanvasDocument;
  patches: CanvasPatch[];
  ctx: CanvasToolContext;
  addPenNode(node: PenChild): void;
}

function makeHarness(): TestHarness {
  const doc: CanvasDocument = {
    id: 'doc-rt',
    name: 'Roundtrip',
    background: '#ffffff',
    version: '2.17',
    children: [],
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
      const next = applyPatchToCanvas(doc, p);
      doc.shapes = next.shapes;
      doc.tokens = next.tokens;
      doc.children = next.children;
      doc.variables = next.variables;
      doc.themes = next.themes;
      doc.background = next.background;
      doc.viewport = next.viewport;
      doc.pages = next.pages;
      doc.activePageIndex = next.activePageIndex;
      return p;
    },
  };

  return {
    doc,
    patches,
    ctx,
    addPenNode(node) {
      doc.children.push(node);
      doc.shapes = resolvePenTreeDetailed(doc).layers;
    },
  };
}

let h: TestHarness;
let restoreSink: (() => void) | null = null;
const originalTimeouts = { ...ROUNDTRIP_DEFAULTS };

beforeEach(() => {
  h = makeHarness();
  __resetClientRoundtripForTests();
  // Shrink every round-trip budget so timeout paths cost ~10ms.
  ROUNDTRIP_DEFAULTS.computedTimeoutMs = 10;
  ROUNDTRIP_DEFAULTS.screenshotTimeoutMs = 10;
  ROUNDTRIP_DEFAULTS.criticScreenshotTimeoutMs = 10;
});

afterEach(() => {
  if (restoreSink) {
    restoreSink();
    restoreSink = null;
  }
  Object.assign(ROUNDTRIP_DEFAULTS, originalTimeouts);
  __resetClientRoundtripForTests();
});

/// Install a capturing event sink; returns the collected events.
function installSink(): SyncEvent[] {
  const events: SyncEvent[] = [];
  restoreSink = setEventSink((event) => {
    events.push(event);
  });
  return events;
}

async function run(name: string, args: any = {}) {
  const tool = createCanvasTools(h.ctx).find((t: any) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const result: any = await tool.execute(
    `call-${name}-${Math.random().toString(36).slice(2, 6)}`,
    args,
    undefined,
    undefined,
    undefined as any,
  );
  // Normalize to the executeTool shape (text content) + keep details.
  const text = Array.isArray(result.content)
    ? result.content.map((c: any) => c.text ?? '').join('\n')
    : String(result.content ?? '');
  return { content: text, details: result.details ?? {}, isError: result.isError === true };
}

function seedNodes() {
  h.addPenNode({ id: 'frame-1', type: 'frame', name: 'Card', x: 40, y: 40, width: 320, height: 200, fill: '#e2e8f0', radius: 12 } as PenChild);
  h.addPenNode({ id: 'text-1', type: 'text', name: 'Title', x: 56, y: 56, width: 120, height: 24, fill: '#0f172a', text: 'Total' } as PenChild);
}

// ---- pen_get_computed -----------------------------------------------------------

describe('tools-roundtrip: pen_get_computed', () => {
  it('falls back to resolver data (measured:false) when NO event sink is installed — never hangs', async () => {
    seedNodes();
    const r = await run('pen_get_computed', { nodeIds: ['frame-1', 'text-1'] });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('client offline — resolver fallback');
    expect(r.content).toContain('measured: false');
    // Resolver-derived geometry + styles present per node.
    expect(r.content).toContain('node frame-1 (frame "Card")');
    expect(r.content).toContain('rect (canvas space): x=40 y=40 w=320 h=200');
    expect(r.content).toContain('backgroundColor: #e2e8f0');
    expect(r.details.measured).toBe(false);
    expect(r.details.results).toHaveLength(2);
    for (const res of r.details.results) {
      expect(res.measured).toBe(false);
    }
  });

  it('emits agent:computed_request (with nodeIds + properties) and times out to the fallback', async () => {
    seedNodes();
    const events = installSink();
    const r = await run('pen_get_computed', { nodeIds: ['frame-1'], properties: ['backgroundColor', 'fontSize'] });
    // The request event rode the per-turn sink with the right shape.
    const req = events.find((e) => e.type === 'agent:computed_request');
    expect(req).toMatchObject({ type: 'agent:computed_request', nodeIds: ['frame-1'] });
    expect((req as any).properties).toEqual(['backgroundColor', 'fontSize']);
    // No client answered (10ms budget) → fallback, and the tool COMPLETED.
    expect(r.content).toContain('client offline — resolver fallback');
    expect(r.details.measured).toBe(false);
  });

  it('resolves live data when the client answers DURING the wait', async () => {
    seedNodes();
    const events = installSink();
    // Start the tool; answer as soon as the request event appears.
    const promise = run('pen_get_computed', { nodeIds: ['frame-1'] });
    const answer = vi.waitFor(() => {
      const req = events.find((e) => e.type === 'agent:computed_request') as Extract<SyncEvent, { type: 'agent:computed_request' }> | undefined;
      expect(req).toBeTruthy();
      return req!;
    }).then((req) =>
      resolveComputedResponse(req.toolCallId, [
        {
          id: 'frame-1',
          rect: { x: 160, y: 120, width: 640, height: 400 },
          canvasRect: { x: 40, y: 40, width: 320, height: 200 },
          computed: { backgroundColor: 'rgb(226, 232, 240)', borderRadius: '12px' },
        },
      ]),
    );
    const r = await promise;
    await answer;

    expect(r.content).toContain('All 1 node(s) read from the LIVE DOM');
    expect(r.content).toContain('measured: true');
    expect(r.content).toContain('backgroundColor: rgb(226, 232, 240)');
    expect(r.content).toContain('rect (canvas space): x=40 y=40 w=320 h=200');
    expect(r.details.measured).toBe(true);
    expect(r.details.liveCount).toBe(1);
  });

  it('mixes live + fallback results when only some nodes are in the DOM', async () => {
    seedNodes();
    const events = installSink();
    const promise = run('pen_get_computed', { nodeIds: ['frame-1', 'text-1'] });
    const answer = vi
      .waitFor(() => {
        const req = events.find((e) => e.type === 'agent:computed_request') as Extract<SyncEvent, { type: 'agent:computed_request' }>;
        expect(req).toBeTruthy();
        return req;
      })
      .then((req) => resolveComputedResponse(req.toolCallId, [{ id: 'text-1', rect: { x: 0, y: 0, width: 84, height: 24 }, computed: { fontSize: '16px' } }]));
    const r = await promise;
    await answer;
    expect(r.content).toContain('1/2 node(s) read from the live DOM');
    expect(r.details.liveCount).toBe(1);
  });

  it('reports unknown node ids without crashing', async () => {
    seedNodes();
    const r = await run('pen_get_computed', { nodeIds: ['ghost-node'] });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Unknown node id(s)');
    expect(r.content).toContain('ghost-node');
  });

  it('respects the properties filter in the resolver fallback', async () => {
    seedNodes();
    const r = await run('pen_get_computed', { nodeIds: ['frame-1'], properties: ['width'] });
    const res = r.details.results[0];
    expect(Object.keys(res.computed)).toEqual(['width']);
    expect(res.computed.width).toBe('320px');
  });

  it('rejects an empty nodeIds array with a navigation hint (never crashes)', async () => {
    seedNodes();
    const r = await run('pen_get_computed', { nodeIds: [] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('nodeIds must be a non-empty array');
  });
});

// ---- pen_get_screenshot -----------------------------------------------------------

describe('tools-roundtrip: pen_get_screenshot', () => {
  it('falls back to the server render (measured:false) with NO sink — never hangs', async () => {
    seedNodes();
    const r = await run('pen_get_screenshot', {});
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('client offline — resolver fallback');
    expect(r.content).toContain('measured: false');
    expect(r.details.measured).toBe(false);
    expect(r.details.screenshotDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('falls back after the round-trip timeout when a client never answers (sink installed)', async () => {
    seedNodes();
    const events = installSink();
    const r = await run('pen_get_screenshot', { scale: 2 });
    const req = events.find((e) => e.type === 'agent:screenshot_request');
    expect(req).toMatchObject({ type: 'agent:screenshot_request', scale: 2 });
    expect(r.content).toContain('client offline — resolver fallback');
    expect(r.content).toContain('no client responded within the timeout');
    expect(r.details.measured).toBe(false);
  });

  it('surfaces the client error when the client answers with one (no-dom-renderer)', async () => {
    seedNodes();
    const events = installSink();
    const promise = run('pen_get_screenshot', {});
    const answer = vi
      .waitFor(() => {
        const req = events.find((e) => e.type === 'agent:screenshot_request') as Extract<SyncEvent, { type: 'agent:screenshot_request' }>;
        expect(req).toBeTruthy();
        return req;
      })
      .then((req) => resolveScreenshotResponse(req.toolCallId, undefined, 'no-dom-renderer'));
    const r = await promise;
    await answer;
    expect(r.content).toContain('client reported: no-dom-renderer');
    expect(r.details.measured).toBe(false);
  });

  it('returns the REAL client dataUrl (measured:true) when the client answers in time', async () => {
    seedNodes();
    const events = installSink();
    const dataUrl = 'data:image/png;base64,' + Buffer.from('real-client-shot').toString('base64');
    const promise = run('pen_get_screenshot', { nodeId: 'frame-1', scale: 3 });
    const answer = vi
      .waitFor(() => {
        const req = events.find((e) => e.type === 'agent:screenshot_request') as Extract<SyncEvent, { type: 'agent:screenshot_request' }>;
        expect(req).toBeTruthy();
        return req;
      })
      .then((req) => resolveScreenshotResponse(req.toolCallId, dataUrl));
    const r = await promise;
    await answer;
    expect(r.content).toContain('Real client screenshot captured');
    expect(r.content).toContain('measured: true');
    expect(r.content).toContain('scope hint: node frame-1');
    expect(r.details.screenshotDataUrl).toBe(dataUrl);
    expect(r.details.measured).toBe(true);
    expect(r.details.scale).toBe(3);
  });

  it('empty canvas → nothing to screenshot (no render attempted)', async () => {
    const r = await run('pen_get_screenshot', {});
    expect(r.content).toContain('Canvas is empty');
  });
});

// ---- pen_bake_layout --------------------------------------------------------------

describe('tools-roundtrip: pen_bake_layout', () => {
  it('makes no patch and explains why when no measured bounds exist', async () => {
    seedNodes();
    const r = await run('pen_bake_layout', { nodeIds: ['frame-1'] });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('no measured bounds available');
    expect(r.content).toContain('no changes made');
    expect(h.patches).toHaveLength(0);
  });

  it('bakes measured sizes via ONE update_many patch', async () => {
    seedNodes();
    setMeasuredBounds('doc-rt', {
      'frame-1': { width: 342, height: 188 },
      'text-1': { width: 84, height: 24 },
    });
    const r = await run('pen_bake_layout', { nodeIds: ['frame-1', 'text-1'] });
    expect(r.isError).toBeFalsy();
    expect(h.patches).toHaveLength(1);
    const patch = h.patches[0];
    expect(patch.op).toBe('update_many');
    expect(patch.updates).toEqual([
      { id: 'frame-1', changes: { width: 342, height: 188 } },
      { id: 'text-1', changes: { width: 84, height: 24 } },
    ]);
    expect(r.details.measured).toBe(true);
    expect(r.details.baked).toBe(2);
    expect(r.content).toContain('Baked measured sizes into 2 node(s)');
  });

  it('all=true bakes every measured id', async () => {
    seedNodes();
    setMeasuredBounds('doc-rt', { 'frame-1': { width: 300, height: 150 } });
    const r = await run('pen_bake_layout', { all: true });
    expect(h.patches).toHaveLength(1);
    expect(h.patches[0].updates).toEqual([{ id: 'frame-1', changes: { width: 300, height: 150 } }]);
    expect(r.details.baked).toBe(1);
  });

  it('NEVER bakes nodes whose .pen sizing is dynamic (fit_content / fill_container) — skipped with a note', async () => {
    seedNodes();
    h.addPenNode({ id: 'dyn-frame', type: 'frame', name: 'Dyn', x: 0, y: 0, width: 'fit_content', height: 'fill_container', layout: 'vertical', children: [] } as PenChild);
    setMeasuredBounds('doc-rt', {
      'frame-1': { width: 342, height: 188 },
      'dyn-frame': { width: 999, height: 999 },
    });
    const r = await run('pen_bake_layout', { all: true });
    expect(r.content).toContain('Baked measured sizes into 1 node(s)');
    expect(r.content).toContain('Skipped 1 dynamic-sizing node(s)');
    expect(r.content).toContain('dyn-frame');
    expect(r.content).toContain('fit_content');
    // Only the fixed-size node landed in the patch.
    expect(h.patches[0].updates).toEqual([{ id: 'frame-1', changes: { width: 342, height: 188 } }]);
    expect(r.details.skipped).toHaveLength(1);
    expect(r.details.skipped[0].id).toBe('dyn-frame');
  });

  it('requested ids without measured data → notice, no patch', async () => {
    seedNodes();
    setMeasuredBounds('doc-rt', { 'text-1': { width: 84, height: 24 } });
    const r = await run('pen_bake_layout', { nodeIds: ['frame-1'] });
    expect(r.content).toContain('none of the requested node ids have measured bounds');
    expect(h.patches).toHaveLength(0);
  });
});
