// Agent-optimization regression suite (2026-09-05 pi-agent quality pass).
//
// Covers the four optimization changes shipped in this pass:
//   1. textTransform pipeline — Layer field → DOM renderer CSS → tool schema
//      → .pen resolve passthrough → SVG/PNG export → html-import mapping.
//   2. Deterministic contrast validator (validators.ts rule 6) — catches the
//      grey-on-grey defect class without an LLM call.
//   3. Wireframe template parameterization — `palette` rebrands the default
//      Sky/Indigo template colors in the same call; type-scale drift fixed
//      (375×667 → 375×812, 22px → 24px headings).
//   4. System prompt doctrine reconciliation — one canonical construction
//      path, a worked example, and PROMPT_VERSION stamped.
//
// Follows the dated-audit test convention (audit-2026-08-30.test.ts etc.):
// source-level assertions for prompt/wiring + behavioral tests for tools
// and validators via the same in-memory harness pattern as tools.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { createCanvasTools, executeTool } from '@/lib/agent/tools';
import type { CanvasToolContext } from '@/lib/agent/tools';
import type { CanvasDocument, CanvasPatch, Shape, DesignTokens } from '@/lib/canvas/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { validateCanvasBeforeComplete } from '@/lib/agent/validators';
import { DomNode } from '@/components/canvas/dom/DomNode';

// ---- In-memory harness (same shape as tools.test.ts) -------------------------

interface TestHarness {
  doc: CanvasDocument;
  patches: CanvasPatch[];
  ctx: CanvasToolContext;
  reset(): void;
  addShape(s: Partial<Shape> & { id: string }): Shape;
}

function makeHarness(): TestHarness {
  const doc: CanvasDocument = {
    id: 'doc-opt',
    name: 'Test',
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
    },
  } as CanvasToolContext;
  return {
    doc,
    patches,
    ctx,
    reset() {
      doc.shapes = [];
      doc.children = [];
      doc.tokens = { colors: [], textStyles: [] };
      patches.length = 0;
    },
    addShape(s) {
      const full: Shape = {
        name: 'Layer', x: 0, y: 0, width: 100, height: 40, rotation: 0,
        opacity: 1, fill: '#ffffff', stroke: 'transparent', strokeWidth: 0,
        fontSize: 16, zIndex: doc.shapes.length, locked: false, visible: true,
        ...s,
      } as Shape;
      doc.shapes.push(full);
      return full;
    },
  };
}

let h: TestHarness;
beforeEach(() => {
  h = makeHarness();
});

async function run(name: string, args: Record<string, unknown> = {}) {
  return executeTool(createCanvasTools(h.ctx), name, args);
}

// ---- 1. textTransform pipeline ----------------------------------------------

describe('2026-09-05: textTransform pipeline', () => {
  it('DOM renderer applies CSS text-transform for uppercase labels', () => {
    const { container } = render(
      createElement(DomNode, {
        layer: {
          id: 'tt1', type: 'text', name: 'KPI label', x: 0, y: 0, width: 120,
          height: 16, fontSize: 12, fontWeight: 600, text: 'Revenue',
          textColor: '#475569', zIndex: 0, locked: false, visible: true,
          textTransform: 'uppercase',
        } as unknown as Shape,
        childLayers: [],
        parentX: 0,
        parentY: 0,
        getChildren: () => [] as Shape[],
        onShapeMouseDown: () => {},
        onHover: () => {},
      }),
    );
    const el = container.querySelector('[data-node-id="tt1"]') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.textTransform).toBe('uppercase');
    expect(el.textContent).toBe('Revenue'); // stored string stays sentence-case
  });

  it('pen_create_node accepts and persists textTransform', async () => {
    const r = await run('pen_create_node', {
      type: 'text', name: 'Table header', x: 0, y: 0, width: 160, height: 20,
      text: 'Customer', fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
      textColor: '#475569',
    });
    expect(r.isError).toBeFalsy();
    const created = h.doc.shapes.find((s) => s.name === 'Table header');
    expect(created?.textTransform).toBe('uppercase');
  });

  it('pen_update_node changes carry textTransform', async () => {
    const created = await run('pen_create_node', {
      type: 'text', name: 'Overline', x: 0, y: 0, width: 160, height: 20, text: 'Pricing',
    });
    expect(created.isError).toBeFalsy();
    const id = h.doc.shapes.find((s) => s.name === 'Overline')!.id;
    const r = await run('pen_update_node', {
      shapeId: id, changes: { textTransform: 'uppercase', letterSpacing: 0.6 },
    });
    expect(r.isError).toBeFalsy();
    const updated = h.doc.shapes.find((s) => s.id === id)!;
    expect(updated.textTransform).toBe('uppercase');
    expect(updated.letterSpacing).toBe(0.6);
  });

  it('pen_create_subtree children carry textTransform through .pen resolve', async () => {
    const r = await run('pen_create_subtree', {
      nodes: [{
        type: 'frame', name: 'KPI card', x: 0, y: 0, width: 300, height: 'fit_content',
        autoLayout: { direction: 'vertical', gap: 8, padding: 24 },
        children: [
          { type: 'text', name: 'KPI label', text: 'Revenue', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', textColor: '#475569' },
          { type: 'text', name: 'KPI value', text: '$128.4K', fontSize: 30, fontWeight: 700, textColor: '#0f172a' },
        ],
      }],
    });
    expect(r.isError).toBeFalsy();
    const label = h.doc.shapes.find((s) => s.name === 'KPI label');
    expect(label?.textTransform).toBe('uppercase');
  });

  it('invalid textTransform values are rejected by coercion (never stored)', async () => {
    const r = await run('pen_create_node', {
      type: 'text', name: 'Bad transform', x: 0, y: 0, width: 160, height: 20,
      text: 'X', textTransform: 'full-width',
    });
    expect(r.isError).toBeFalsy();
    const created = h.doc.shapes.find((s) => s.name === 'Bad transform');
    expect(created?.textTransform).toBeUndefined();
  });
});

// ---- 2. Contrast validator (rule 6) ------------------------------------------

describe('2026-09-05: textColor→fill mapping is TEXT-ONLY (fill-loss regression)', () => {
  // Live-observed: five bulk textColor passes repainted every rectangle's
  // fill (white button, flat screen). A textColor-only update on a non-text
  // node must NEVER touch the node's fill.
  it('bulk textColor update preserves a rectangle fill set by a prior update', async () => {
    const created = await run('pen_create_subtree', {
      nodes: [{
        type: 'frame', name: 'Screen', x: 0, y: 0, width: 375, height: 812, fill: '#f8fafc',
        children: [
          { type: 'rectangle', name: 'Sign In Button', fill: '#ffffff', width: 311, height: 48 },
          { type: 'text', name: 'Sign In Text', text: 'Sign In', fontSize: 16, textColor: '#0f172a' },
        ],
      }],
    });
    expect(created.isError).toBeFalsy();
    const btnId = h.doc.shapes.find((s) => s.name === 'Sign In Button')!.id;
    const textId = h.doc.shapes.find((s) => s.name === 'Sign In Text')!.id;

    await run('pen_update_node', { shapeId: btnId, changes: { fill: '#0ea5e9' } });
    expect(h.doc.shapes.find((s) => s.id === btnId)!.fill).toBe('#0ea5e9');

    // The agent's real-world pattern: bulk textColor pass over ALL shapes.
    const bulk = await run('pen_bulk_update_by_filter', { changes: { textColor: '#ffffff' } });
    expect(bulk.isError).toBeFalsy();

    const btn = h.doc.shapes.find((s) => s.id === btnId)!;
    const label = h.doc.shapes.find((s) => s.id === textId)!;
    expect(btn.fill).toBe('#0ea5e9'); // fill SURVIVES the textColor pass
    expect(label.textColor).toBe('#ffffff'); // text node color DID change
  });

  it('pen_update_node textColor on a rectangle is a no-op for fill', async () => {
    const created = await run('pen_create_node', {
      type: 'rectangle', name: 'Card', x: 0, y: 0, width: 300, height: 120, fill: '#ffffff',
    });
    expect(created.isError).toBeFalsy();
    const id = h.doc.shapes.find((s) => s.name === 'Card')!.id;
    await run('pen_update_node', { shapeId: id, changes: { textColor: '#ef4444' } });
    expect(h.doc.shapes.find((s) => s.id === id)!.fill).toBe('#ffffff');
  });

  it('pen_update_node textColor on a TEXT node still updates its color', async () => {
    const created = await run('pen_create_node', {
      type: 'text', name: 'Body', x: 0, y: 0, width: 200, height: 20, text: 'Hello',
    });
    expect(created.isError).toBeFalsy();
    const id = h.doc.shapes.find((s) => s.name === 'Body')!.id;
    await run('pen_update_node', { shapeId: id, changes: { textColor: '#0ea5e9' } });
    expect(h.doc.shapes.find((s) => s.id === id)!.textColor).toBe('#0ea5e9');
  });
});

describe('2026-09-05: deterministic contrast validator', () => {
  const baseText = (over: Record<string, unknown>) => ({
    id: 't', type: 'text', name: 'Body', x: 0, y: 0, width: 100, height: 20,
    fontSize: 16, fontWeight: 500, text: 'Hello', zIndex: 0, locked: false,
    visible: true, ...over,
  }) as unknown as Shape;

  it('flags near-invisible grey-on-grey text (< 2:1)', () => {
    const shapes = [
      { id: 'f1', type: 'frame', name: 'Screen', x: 0, y: 0, width: 375, height: 812, fill: '#ffffff', zIndex: 0, locked: false, visible: true } as unknown as Shape,
      baseText({ id: 't1', parentId: 'f1', textColor: '#e2e8f0' }), // 1.23:1 on white
    ];
    const r = validateCanvasBeforeComplete(shapes, { relaxMinCount: true });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.includes('nearly invisible'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('#e2e8f0'))).toBe(true);
  });

  it('flags text whose color equals the container fill exactly', () => {
    const shapes = [
      { id: 'f2', type: 'frame', name: 'Card', x: 0, y: 0, width: 300, height: 120, fill: '#f1f5f9', zIndex: 0, locked: false, visible: true } as unknown as Shape,
      baseText({ id: 't2', parentId: 'f2', textColor: '#f1f5f9' }), // 1:1
    ];
    const r = validateCanvasBeforeComplete(shapes, { relaxMinCount: true });
    expect(r.reasons.some((x) => x.includes('nearly invisible'))).toBe(true);
  });

  it('passes normal text (muted slate on white = 7.5:1) and token refs', () => {
    const shapes = [
      baseText({ id: 't3', textColor: '#475569' }),
      baseText({ id: 't4', textColor: '$color.text-muted' }), // token → skipped
    ];
    const r = validateCanvasBeforeComplete(shapes, { relaxMinCount: true });
    expect(r.reasons.some((x) => x.includes('nearly invisible'))).toBe(false);
  });

  it('design-system text-subtle (#94a3b8 on white, 2.5:1) is NOT flagged (intentional caption style)', () => {
    const shapes = [baseText({ id: 't5', textColor: '#94a3b8' })];
    const r = validateCanvasBeforeComplete(shapes, { relaxMinCount: true });
    expect(r.reasons.some((x) => x.includes('nearly invisible'))).toBe(false);
  });

  it('white text on a dark parent frame passes (dark-mode designs)', () => {
    const shapes = [
      { id: 'f3', type: 'frame', name: 'Dark hero', x: 0, y: 0, width: 1440, height: 400, fill: '#0b0f1a', zIndex: 0, locked: false, visible: true } as unknown as Shape,
      baseText({ id: 't6', parentId: 'f3', textColor: '#f1f5f9' }),
    ];
    const r = validateCanvasBeforeComplete(shapes, { relaxMinCount: true });
    expect(r.reasons.some((x) => x.includes('nearly invisible'))).toBe(false);
  });
});

// ---- 3. Wireframe palette + type-scale fixes ----------------------------------

describe('2026-09-05: pen_generate_wireframe palette parameterization', () => {
  beforeEach(() => h.reset());

  it('rebrands default Sky/Indigo template colors in the same call', async () => {
    const r = await run('pen_generate_wireframe', {
      template: 'mobile_login', x: 100, y: 100,
      palette: { primaryColor: '#7c3aed', accentColor: '#db2777' },
    });
    expect(r.isError).toBeFalsy();
    // The "Forgot password?" link ships #0ea5e9 in the template → must be violet now.
    const link = h.doc.shapes.find((s) => s.name === 'Forgot password');
    expect(link?.textColor).toBe('#7c3aed');
    // Result text reports the rebrand so the model knows it landed.
    expect(String(r.content)).toContain('rebranded');
  });

  it('without palette, template defaults are untouched', async () => {
    const r = await run('pen_generate_wireframe', { template: 'mobile_login', x: 100, y: 100 });
    expect(r.isError).toBeFalsy();
    const link = h.doc.shapes.find((s) => s.name === 'Forgot password');
    expect(link?.textColor).toBe('#0ea5e9');
  });

  it('mobile_login frame is 375×812 with a 24px heading (type-scale drift fixed)', async () => {
    const r = await run('pen_generate_wireframe', { template: 'mobile_login', x: 100, y: 100 });
    expect(r.isError).toBeFalsy();
    const frame = h.doc.shapes.find((s) => s.type === 'frame' && s.name === 'Mobile / Login');
    expect(frame?.width).toBe(375);
    expect(frame?.height).toBe(812);
    const heading = h.doc.shapes.find((s) => s.name === 'Heading');
    expect(heading?.fontSize).toBe(24);
  });
});

// ---- 4. System prompt doctrine + version stamp --------------------------------

describe('2026-09-05: system prompt optimization', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/agent/runner-legacy.ts'), 'utf-8');
  const templateStart = src.indexOf('SYSTEM_PROMPT_TEMPLATE = `');
  const template = src.slice(templateStart, src.indexOf('`;', templateStart));

  it('PROMPT_VERSION is stamped for this pass', async () => {
    const { PROMPT_VERSION } = await import('@/lib/agent/runner-legacy');
    expect(PROMPT_VERSION).toBe('2026-09-05.2');
  });

  it('one canonical construction hierarchy exists (subtree canonical, insert_html demoted)', () => {
    expect(template).toContain('CONSTRUCTION PATHS');
    expect(template).toContain('pen_create_subtree (CANONICAL)');
    // The old "PREFERRED for composite UI" doctrine is gone.
    expect(template).not.toContain('PREFERRED for composite UI');
    expect(template).toContain('for HTML you ALREADY have');
  });

  it('a worked pen_create_subtree example is embedded', () => {
    expect(template).toContain('CANONICAL EXAMPLE');
    expect(template).toContain('pen_create_subtree({ nodes: [');
    expect(template).toContain('height: "fit_content"');
    expect(template).toContain('textTransform: "uppercase"');
  });

  it('TURN FLOW is single-pass (tokens → build → finish), not scaffold-then-restyle', () => {
    expect(template).toContain('styled AT CREATION');
    expect(template).toContain('1. TOKENS');
    expect(template).toContain('2. BUILD');
    // The old "GENERATE THEN STYLE" restyle-chain doctrine is replaced.
    expect(template).not.toContain('GENERATE THEN STYLE');
    expect(template).toContain('STYLE AT CREATION');
  });

  it('screen skeleton + spacing relationships are taught', () => {
    expect(template).toContain('SCREEN SKELETON');
    expect(template).toContain('SPACING RELATIONSHIPS');
    expect(template).toContain('Container padding ≥ gap');
  });

  it('required audit anchors survive (critique loop, EDIT TURNS, plugin tools)', () => {
    expect(template).toContain('AUTOMATIC CRITIQUE');
    expect(template).toContain('do NOT call pen_self_critique yourself mid-turn');
    expect(template).toContain('EDIT TURNS');
    expect(template).toContain('DEFAULT-ON PLUGIN TOOLS');
  });
});

// ---- 5. Temperature wiring (source-level, resolver is network-facing) --------

describe('2026-09-05: temperature reaches the custom endpoint model', () => {
  it('buildCustomEndpointModel declares samplingParams and the resolver passes settings.temperature', () => {
    const resolverSrc = readFileSync(join(process.cwd(), 'src/lib/agent/pi-ai-model-resolver.ts'), 'utf-8');
    expect(resolverSrc).toContain('samplingParams: { temperature }');
    expect(resolverSrc).toContain('buildCustomEndpointModel(customBaseUrl, modelId, userTemperature)');
    // Temperature participates in the resolved-model cache key (no stale Model).
    expect(resolverSrc).toContain("::${userTemperature ?? 'default'}");
  });
});
