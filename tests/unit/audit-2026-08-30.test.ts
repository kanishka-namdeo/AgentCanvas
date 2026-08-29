// Unit tests — the 2026-08-30 agent-audit implementation batch.
//
// Guards the specific regressions the audit found (see download/audit/):
//   A1/S1/T2 — runtime-authored prompt text (fix-message, validators) must
//              only name REGISTERED tools (the old text mandated
//              pen_update_shape/pen_create_shape — filtered-out aliases —
//              so every critique fix-turn hit "Tool not found").
//   T1       — every registered tool is reachable in >=1 skill category
//              (pen_visual_critique used to be dead).
//   S8/S10   — skill bodies + .pi/skills files never teach unregistered
//              tool spellings.
//   T7       — pen_set_variable accepts themedValues-only calls.
//   T5       — pen_set_explicit_modes / pen_mark_slot persist real payload.
//   P7       — canvasSnapshot caps full-detail lines on huge canvases.
//   C17      — sanitizer strips (not drops) a bad parentId on add.
//   C16      — checkpointSignature detects property-only turns.
//   C14      — nested $var chains resolve to concrete values.
//   C4/C6    — styleFor composes multi-shadow, backdrop-filter, blend mode,
//              and flip transforms.
//   T11      — notFoundResult includes candidates + the recovery call.
//   T8/S4    — subagent_worker returns an honest error; subagents plugin is
//              default-off; the live-canvas provider resolves.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvasTools, type CanvasToolContext } from '@/lib/agent/tools';
import { createPenTools, PEN_TOOL_NAMES } from '@/lib/agent/pen-tools';
import { createFigmaTools, FIGMA_TOOL_NAMES } from '@/lib/agent/figma-tools';
import { SKILLS, ALL_TOOL_NAMES, formatSkillBodyForPrompt, CORE_TOOL_NAMES } from '@/lib/agent/skills/registry';
import { validateCanvasBeforeComplete } from '@/lib/agent/validators';
import { canvasSnapshot } from '@/lib/agent/runner-legacy';
import { sanitizeAgentPatch } from '@/lib/canvas/patch-sanitizer';
import { checkpointSignature } from '@/lib/canvas/version-history';
import { styleFor } from '@/components/canvas/dom/styleFor';
import { notFoundResult } from '@/lib/agent/tool-errors';
import { getAllPlugins } from '@/lib/agent/plugins';
import { getActiveCanvas, setActiveCanvas } from '@/lib/agent/plugins/subagents';
import { resolvePenTree } from '@/lib/pen/resolve';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';

// ---- Fixtures ----------------------------------------------------------------

function emptyCanvas(): CanvasDocument {
  return {
    id: 'doc-test',
    name: 'Test',
    version: '2.17',
    background: '#ffffff',
    shapes: [],
    tokens: { colors: [], textStyles: [] },
    children: [],
  } as unknown as CanvasDocument;
}

function makeCtx(doc?: CanvasDocument): CanvasToolContext & { patches: unknown[] } {
  const canvas = doc ?? emptyCanvas();
  const patches: unknown[] = [];
  return {
    getShapes: () => canvas.shapes ?? [],
    getTokens: () => canvas.tokens ?? { colors: [], textStyles: [] },
    getDocument: () => canvas,
    applyPatch(p: any) {
      patches.push(p);
      const next = sanitizeAgentPatch(p, canvas);
      if (next.patch) {
        // Apply through the real applier so persistence claims are real.
        Object.assign(canvas, applyPatchToCanvas(canvas, next.patch));
      }
      return p;
    },
    // test-only capture
    patches,
  } as any;
}

function registeredToolNames(): Set<string> {
  const ctx = makeCtx();
  const names = new Set<string>();
  for (const t of createCanvasTools(ctx) as any[]) names.add(t.name);
  for (const t of createPenTools(ctx) as any[]) names.add(t.name);
  for (const t of createFigmaTools(ctx) as any[]) names.add(t.name);
  return names;
}

function visibleToolNamesFor(category: string): Set<string> {
  // Mirrors runner-native's allowedToolNames construction (post-T3 gating):
  // category allowlist + PEN/FIGMA unions when structural + no plugins.
  const set = new Set<string>(CORE_TOOL_NAMES);
  const skill = (SKILLS as any)[category];
  if (category === 'multi') {
    for (const n of ALL_TOOL_NAMES) set.add(n);
  } else if (skill?.allowedTools) {
    for (const n of skill.allowedTools) set.add(n);
  }
  if (category === 'wireframe' || category === 'multi') {
    for (const n of PEN_TOOL_NAMES) set.add(n);
    for (const n of FIGMA_TOOL_NAMES) set.add(n);
  }
  return set;
}

// ---- A1/S1/T2: runtime prompt text names registered tools --------------------

describe('audit A1/S1/T2 — runtime-authored prompt text only names registered tools', () => {
  const registered = registeredToolNames();

  it('the critique fix-message names only registered tools', () => {
    // Extract the fixMessage template literal from the runner source and
    // collect every pen_* token it mentions.
    const src = readFileSync(join(process.cwd(), 'src/lib/agent/runner-native.ts'), 'utf-8');
    const start = src.indexOf('const fixMessage = `');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('`;', start);
    const body = src.slice(start, end);
    const mentioned = [...body.matchAll(/\b(pen_[a-z_]+)\b/g)].map((m) => m[1]);
    expect(mentioned.length).toBeGreaterThan(3);
    for (const name of new Set(mentioned)) {
      expect(registered.has(name), `fix-message names unregistered tool "${name}"`).toBe(true);
    }
    // The old dead names must be gone.
    expect(body).not.toContain('pen_update_shape');
    expect(body).not.toContain('pen_create_shape');
  });

  it('validator messages name only registered tools', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/agent/validators.ts'), 'utf-8');
    const mentioned = [...src.matchAll(/\b(pen_[a-z_]+)\b/g)].map((m) => m[1]);
    for (const name of new Set(mentioned)) {
      expect(registered.has(name), `validator text names unregistered tool "${name}"`).toBe(true);
    }
  });

  it('the brief gate gates only registered tools', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/agent/runner-native.ts'), 'utf-8');
    const start = src.indexOf('const GATED_TOOL_NAMES = new Set<string>(');
    const end = src.indexOf(']);', start);
    const body = src.slice(start, end);
    const gated = [...body.matchAll(/'(pen_[a-z_]+)'/g)].map((m) => m[1]);
    expect(gated.length).toBeGreaterThanOrEqual(8);
    for (const name of gated) {
      expect(registered.has(name), `brief gate names unregistered tool "${name}"`).toBe(true);
    }
  });
});

// ---- T1: tool reachability -----------------------------------------------------

describe('audit T1 — every registered tool is reachable in >=1 category', () => {
  it('all base tools appear in some visible set', () => {
    const registered = registeredToolNames();
    const reachable = new Set<string>();
    for (const cat of ['wireframe', 'layout', 'styling', 'inspect', 'export', 'web_research', 'vector', 'multi']) {
      for (const n of visibleToolNamesFor(cat)) reachable.add(n);
    }
    for (const name of registered) {
      expect(reachable.has(name), `tool "${name}" is registered but reachable in NO category`).toBe(true);
    }
  });

  it('pen_visual_critique is reachable (was dead)', () => {
    expect(visibleToolNamesFor('inspect').has('pen_visual_critique')).toBe(true);
    expect(visibleToolNamesFor('wireframe').has('pen_visual_critique')).toBe(true);
  });

  it('composite tools are registered + reachable', () => {
    const registered = registeredToolNames();
    expect(registered.has('pen_apply_design_system')).toBe(true);
    expect(registered.has('pen_create_chart')).toBe(true);
    expect(registered.has('pen_apply_typography')).toBe(true);
    expect(visibleToolNamesFor('wireframe').has('pen_create_chart')).toBe(true);
    expect(visibleToolNamesFor('wireframe').has('pen_apply_typography')).toBe(true);
  });
});

// ---- S8/S10: skill bodies + file skills teach only registered tools -----------

describe('audit S8/S10 — skill bodies never name unregistered tools', () => {
  it('wireframe/styling/layout/etc. bodies only mention registered tools', () => {
    const registered = registeredToolNames();
    for (const [cat, skill] of Object.entries(SKILLS)) {
      if (!skill) continue;
      // pen_* tokens + the two exact web tool names (web_landing etc. are
      // TEMPLATE names, not tools).
      const mentioned = [...(skill.body.matchAll(/\b(pen_[a-z_]+)\b/g))].map((m) => m[1]);
      if (skill.body.includes('web_search')) mentioned.push('web_search');
      if (skill.body.includes('web_fetch')) mentioned.push('web_fetch');
      for (const name of new Set(mentioned)) {
        expect(registered.has(name), `${cat} skill body names unregistered tool "${name}"`).toBe(true);
      }
    }
  });

  it('the multi fallback now has a body (was empty)', () => {
    expect(formatSkillBodyForPrompt('multi').length).toBeGreaterThan(200);
    expect(formatSkillBodyForPrompt('multi')).toContain('pen_create_subtree');
  });

  it('.pi/skills legacy files only mention registered tools', () => {
    const registered = registeredToolNames();
    for (const file of ['design-system.md', 'wireframe-generator.md', 'design-audit.md']) {
      const src = readFileSync(join(process.cwd(), '.pi/skills', file), 'utf-8');
      const mentioned = [...src.matchAll(/\b(pen_[a-z_]+)\b/g)].map((m) => m[1]);
      expect(mentioned.length).toBeGreaterThan(0);
      for (const name of new Set(mentioned)) {
        expect(registered.has(name), `.pi/skills/${file} names unregistered tool "${name}"`).toBe(true);
      }
    }
  });
});

// ---- T7: pen_set_variable schema fix ------------------------------------------

describe('audit T7 — pen_set_variable accepts themedValues-only', () => {
  it('themedValues without value succeeds', async () => {
    const ctx = makeCtx();
    const tools = createPenTools(ctx) as any[];
    const tool = tools.find((t) => t.name === 'pen_set_variable');
    const res = await tool.execute('t1', { key: 'color.bg', themedValues: [
      { value: '#ffffff', theme: { mode: 'light' } },
      { value: '#0b0f1a', theme: { mode: 'dark' } },
    ] }, undefined, undefined, undefined);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('2 theme-conditional');
  });

  it('neither value nor themedValues → friendly error', async () => {
    const ctx = makeCtx();
    const tools = createPenTools(ctx) as any[];
    const tool = tools.find((t) => t.name === 'pen_set_variable');
    const res = await tool.execute('t2', { key: 'color.bg' }, undefined, undefined, undefined);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('themedValues');
  });

  it('both value and themedValues → XOR error', async () => {
    const ctx = makeCtx();
    const tools = createPenTools(ctx) as any[];
    const tool = tools.find((t) => t.name === 'pen_set_variable');
    const res = await tool.execute('t3', { key: 'color.bg', value: '#fff', themedValues: [{ value: '#000' }] }, undefined, undefined, undefined);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not both');
  });
});

// ---- T5: no-op tools persist real payload --------------------------------------

describe('audit T5 — pen_set_explicit_modes / pen_mark_slot persist', () => {
  it('pen_set_explicit_modes writes the theme payload (not shape:{})', async () => {
    const doc = emptyCanvas();
    const ctx = makeCtx(doc);
    // Seed a frame.
    const canvasTools = createCanvasTools(ctx) as any[];
    const create = canvasTools.find((t) => t.name === 'pen_create_node');
    await create!.execute('s1', { type: 'frame', name: 'Screen', x: 0, y: 0, width: 375, height: 812 }, undefined, undefined, undefined);
    const frameId = (ctx.getDocument!().shapes ?? [])[0].id;

    const tools = createPenTools(ctx) as any[];
    const setModes = tools.find((t) => t.name === 'pen_set_explicit_modes');
    const res = await setModes.execute('s2', { nodeId: frameId, explicitVariableModes: { mode: 'dark' } }, undefined, undefined, undefined);
    expect(res.isError).toBeFalsy();
    // The patch carried a REAL payload.
    const patch = (ctx as any).patches.at(-1);
    expect((patch?.shape as any)?.theme).toEqual({ mode: 'dark' });
  });

  it('pen_mark_slot writes the slot payload', async () => {
    const doc = emptyCanvas();
    const ctx = makeCtx(doc);
    const canvasTools = createCanvasTools(ctx) as any[];
    const create = canvasTools.find((t) => t.name === 'pen_create_node');
    await create!.execute('s1', { type: 'frame', name: 'Holder', x: 0, y: 0, width: 200, height: 200 }, undefined, undefined, undefined);
    const frameId = (ctx.getDocument!().shapes ?? [])[0].id;

    const tools = createPenTools(ctx) as any[];
    const markSlot = tools.find((t) => t.name === 'pen_mark_slot');
    const res = await markSlot.execute('s2', { shapeId: frameId, components: ['round-button'] }, undefined, undefined, undefined);
    expect(res.isError).toBeFalsy();
    const patch = (ctx as any).patches.at(-1);
    expect((patch?.shape as any)?.slot).toEqual(['round-button']);
  });
});

// ---- T8/S4: plugin honesty ------------------------------------------------------

describe('audit T8/S4 — subagents plugin honesty', () => {
  it('subagents plugin is default-OFF', () => {
    const subagents = getAllPlugins().find((p) => p.pluginId === 'subagents');
    expect(subagents?.defaultEnabled).toBe(false);
  });

  it('subagent_worker returns an honest error (no success theater)', async () => {
    const { tools } = await import('@/lib/agent/plugins/subagents');
    const worker = (tools as any[]).find((t) => t.name === 'subagent_worker');
    const res = await worker.execute('w1', { task: 'build a card' }, undefined, undefined, undefined);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not available');
  });

  it('getActiveCanvas resolves a live provider (not a stale snapshot)', () => {
    let canvas: any = { shapes: [], name: 'v1' } as any;
    setActiveCanvas(() => canvas);
    expect(getActiveCanvas()?.name).toBe('v1');
    canvas = { shapes: [], name: 'v2' } as any; // runner reassigned its closure
    expect(getActiveCanvas()?.name).toBe('v2');
    setActiveCanvas(null);
  });
});

// ---- T11: notFoundResult ---------------------------------------------------------

describe('audit T11 — notFoundResult is actionable', () => {
  it('includes candidates + the recovery call', () => {
    const ctx = makeCtx();
    const canvasTools = createCanvasTools(ctx) as any[];
    const create = canvasTools.find((t) => t.name === 'pen_create_node');
    void create;
    // Seed two shapes manually.
    const shapes = [
      { id: 'a1', name: 'Header', type: 'frame' },
      { id: 'a2', name: 'Card', type: 'rectangle' },
    ];
    const ctx2 = { getShapes: () => shapes } as any;
    const res = notFoundResult(ctx2, 'bogus-id', 'Set shadow');
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"bogus-id"');
    expect(res.content[0].text).toContain('"Header" (a1');
    expect(res.content[0].text).toContain('pen_get_metadata');
  });

  it('empty canvas → create hint', () => {
    const ctx = { getShapes: () => [] } as any;
    const res = notFoundResult(ctx, 'x', undefined);
    expect(res.content[0].text).toContain('EMPTY');
    expect(res.content[0].text).toContain('pen_create_node');
  });
});

// ---- P7: snapshot line cap --------------------------------------------------------

describe('audit P7 — canvasSnapshot caps full-detail lines', () => {
  it('a 500-layer canvas collapses past the cap', () => {
    const shapes: Shape[] = Array.from({ length: 500 }, (_, i) => ({
      id: `s${i}`,
      type: 'rectangle',
      name: `Rect ${i}`,
      x: (i % 20) * 120, y: Math.floor(i / 20) * 60,
      width: 100, height: 40,
      rotation: 0, opacity: 1,
      fill: '#cccccc', stroke: '', strokeWidth: 0,
      radius: 4, fontSize: 16, textColor: '#000',
      parentId: null, zIndex: i, locked: false, visible: true,
      autoLayout: null, tokenBinding: null, componentId: null,
    })) as unknown as Shape[];
    const doc = { ...emptyCanvas(), shapes };
    const snap = canvasSnapshot(doc as CanvasDocument);
    const lines = snap.split('\n');
    // Cap + slack for header/var/warning/placement lines.
    expect(lines.length).toBeLessThan(380);
    expect(snap).toContain('collapsed');
    expect(snap).toContain('pen_get_metadata');
  });
});

// ---- C17: sanitizer parentId ------------------------------------------------------

describe('audit C17 — bad parentId on add is stripped, not dropped', () => {
  it('add with unknown parentId lands at root', () => {
    const doc = emptyCanvas();
    doc.shapes = [{
      id: 'root-1', type: 'frame', name: 'Screen', x: 0, y: 0, width: 100, height: 100,
      rotation: 0, opacity: 1, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0,
      fontSize: 16, textColor: '#000', parentId: null, zIndex: 0, locked: false, visible: true,
      autoLayout: null, tokenBinding: null, componentId: null,
    }] as any;
    const res = sanitizeAgentPatch({
      op: 'add',
      shapeId: 'new-1',
      shape: { id: 'new-1', type: 'rectangle', parentId: 'nope', width: 10, height: 10 } as any,
      summary: 'test',
    } as CanvasPatch, doc);
    expect(res.patch).not.toBeNull();
    expect((res.patch!.shape as any).parentId).toBeUndefined();
    expect(res.warnings.some((w) => w.includes('nope'))).toBe(true);
  });
});

// ---- C16: checkpoint signature ----------------------------------------------------

describe('audit C16 — checkpointSignature catches property-only turns', () => {
  const base = () => ({
    ...emptyCanvas(),
    children: [
      { id: 'n1', type: 'rectangle', name: 'Card', fill: '#ffffff' },
      { id: 'n2', type: 'rectangle', name: 'Card', fill: '#ffffff' },
    ],
    shapes: [] as any[],
    variables: {},
  }) as any;

  it('same counts + different fills → different signature', () => {
    const a = base();
    const b = base();
    b.children = [
      { id: 'n1', type: 'rectangle', name: 'Card', fill: '#0ea5e9' },
      { id: 'n2', type: 'rectangle', name: 'Card', fill: '#0ea5e9' },
    ];
    expect(checkpointSignature(a)).not.toBe(checkpointSignature(b));
  });

  it('identical docs → identical signature (stable)', () => {
    expect(checkpointSignature(base())).toBe(checkpointSignature(base()));
  });
});

// ---- C14: nested $var --------------------------------------------------------------

describe('audit C14 — nested $var chains resolve', () => {
  it('$brand.primary → $color.primary → #hex resolves to the hex', () => {
    const doc: any = {
      ...emptyCanvas(),
      variables: {
        'brand.primary': { type: 'color', value: '$color.primary' },
        'color.primary': { type: 'color', value: '#0ea5e9' },
      },
      children: [
        { id: 'r1', type: 'rectangle', name: 'R', x: 0, y: 0, width: 10, height: 10, fill: '$brand.primary' },
      ],
    };
    const shapes = resolvePenTree(doc);
    const rect = shapes.find((s: any) => s.id === 'r1');
    expect(rect?.fill).toBe('#0ea5e9');
  });

  it('cycles do not hang and leak the literal', () => {
    const doc: any = {
      ...emptyCanvas(),
      variables: {
        a: { type: 'color', value: '$b' },
        b: { type: 'color', value: '$a' },
      },
      children: [
        { id: 'r1', type: 'rectangle', name: 'R', x: 0, y: 0, width: 10, height: 10, fill: '$a' },
      ],
    };
    const shapes = resolvePenTree(doc);
    const rect = shapes.find((s: any) => s.id === 'r1');
    expect(typeof rect?.fill).toBe('string');
  });
});

// ---- C4/C6: styleFor fidelity ------------------------------------------------------

describe('audit C4/C6 — styleFor fidelity features', () => {
  const baseShape = (over: Partial<Shape> = {}): Shape => ({
    id: 'x', type: 'rectangle', name: 'X',
    x: 0, y: 0, width: 100, height: 50,
    rotation: 0, opacity: 1, fill: '#fff', stroke: '', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0, locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    ...over,
  }) as Shape;

  it('composes multi-shadow as a comma list', () => {
    const s = baseShape({
      shadow: { x: 0, y: 1, blur: 2, color: '#0000000d' },
      shadows: [
        { x: 0, y: 1, blur: 2, color: '#0000000d' },
        { x: 0, y: 4, blur: 6, color: '#0000001a' },
      ],
    } as any);
    const css = styleFor(s, { relX: 0, relY: 0 });
    expect(String(css.boxShadow)).toContain(',');
    expect(String(css.boxShadow)).toContain('#0000001a');
  });

  it('backgroundBlur → backdrop-filter (not self blur)', () => {
    const s = baseShape({ backgroundBlur: 8 } as any);
    const css = styleFor(s, { relX: 0, relY: 0 });
    expect(css.backdropFilter).toBe('blur(8px)');
    expect(css.filter).toBeUndefined();
  });

  it('blendMode maps to mix-blend-mode; normal/pass_through do not', () => {
    expect(styleFor(baseShape({ blendMode: 'multiply' } as any), { relX: 0, relY: 0 }).mixBlendMode).toBe('multiply');
    expect(styleFor(baseShape({ blendMode: 'normal' } as any), { relX: 0, relY: 0 }).mixBlendMode).toBeUndefined();
  });

  it('flipX/flipY compose into the transform', () => {
    const css = styleFor(baseShape({ flipX: true } as any), { relX: 0, relY: 0 });
    expect(String(css.transform)).toContain('scaleX(-1)');
    const css2 = styleFor(baseShape({ flipY: true, rotation: 10 } as any), { relX: 0, relY: 0 });
    expect(String(css2.transform)).toContain('rotate(10deg)');
    expect(String(css2.transform)).toContain('scaleY(-1)');
  });
});

// ---- P5: prompt contradiction fixes --------------------------------------------------

describe('audit P5 — system prompt contradictions resolved', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/agent/runner-legacy.ts'), 'utf-8');
  const templateStart = src.indexOf('SYSTEM_PROMPT_TEMPLATE = `');
  const template = src.slice(templateStart, src.indexOf('`;', templateStart));

  it('no "You have NO vision" clause (images are attached for vision models)', () => {
    expect(template).not.toContain('You have NO vision');
  });

  it('no model-facing mandatory self-critique (runner loop owns critique)', () => {
    expect(template).not.toContain('SELF-CRITIQUE IS MANDATORY');
    expect(template).not.toContain('pen_self_critique to get a senior-designer review');
    expect(template).not.toContain('CRITIQUE — call pen_self_critique');
    // The replacement directive exists and is explicitly negative.
    expect(template).toContain('do NOT call pen_self_critique yourself mid-turn');
    expect(template).toContain('AUTOMATIC CRITIQUE');
  });

  it('no hardcoded (600, 400) focal point (snapshot placement line owns it)', () => {
    expect(template).not.toContain('(600, 400)');
  });

  it('EDIT TURNS + PLUGIN sections exist', () => {
    expect(template).toContain('EDIT TURNS');
    expect(template).toContain('DEFAULT-ON PLUGIN TOOLS');
  });
});
