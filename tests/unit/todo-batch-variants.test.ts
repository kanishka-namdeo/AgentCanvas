// Tests for the two noise-reduction / quality features from the VLM-exercise:
//   1. todo plugin batch updates (13-of-31 bookkeeping calls finding)
//   2. variant-generator spec extraction + coercion (multi-variant parallel
//      generation for ambiguous prompts)
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setActiveSession,
  getTodos,
  tools as todoTools,
} from '@/lib/agent/plugins/todo';
import {
  extractSpecJson,
  extractJsonBlock,
  DEFAULT_VARIANT_DIRECTIONS,
  compositeVariantPngs,
  dispatchVariantGeneration,
} from '@/lib/agent/subagents/variant-generator';

// ---- helpers ----------------------------------------------------------------

const SESSION = 'test-todo-batch';

function tool(name: string) {
  const t = todoTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t as any;
}

async function run(name: string, params: any) {
  const t = tool(name);
  return t.execute(`call-${Math.random()}`, params, undefined, undefined, undefined);
}

// ---- todo plugin: batch updates -----------------------------------------------

describe('todo plugin — batch updates (noise fix)', () => {
  beforeEach(() => {
    setActiveSession(SESSION);
    // Reset by creating a fresh list each test.
  });

  it('todo_create returns the full list + ids', async () => {
    const r = await run('todo_create', {
      items: [
        { text: 'Create the header' },
        { text: 'Apply color palette' },
        { text: 'Add shadows to cards' },
      ],
    });
    const text = r.content[0].text as string;
    expect(text).toContain('Created 3-item todo list');
    expect(text).toContain('Create the header');
    expect(text).toContain('Apply color palette');
    expect(r.details.todoIds).toHaveLength(3);
  });

  it('todo_update applies a BATCH of transitions in one call', async () => {
    await run('todo_create', {
      items: [
        { text: 'Step A', id: 'a' },
        { text: 'Step B', id: 'b' },
        { text: 'Step C', id: 'c' },
      ],
    });
    const r = await run('todo_update', {
      updates: [
        { id: 'a', status: 'completed' },
        { id: 'b', status: 'completed' },
        { id: 'c', status: 'in_progress' },
      ],
    });
    const text = r.content[0].text as string;
    expect(text).toContain('Updated 3 todo(s)');
    expect(text).toContain('[completed  ] [a] Step A');
    expect(text).toContain('[in_progress] [c] Step C');
    expect(r.details.applied).toBe(3);
  });

  it('WIP=1 auto-advance: setting a step in_progress completes the previous one', async () => {
    await run('todo_create', {
      items: [
        { text: 'Step A', id: 'a' },
        { text: 'Step B', id: 'b' },
      ],
    });
    await run('todo_update', { updates: [{ id: 'a', status: 'in_progress' }] });
    // Now advance to B — A must auto-complete WITHOUT an explicit transition.
    const r = await run('todo_update', { updates: [{ id: 'b', status: 'in_progress' }] });
    const todos = getTodos(SESSION);
    expect(todos.find((t) => t.id === 'a')?.status).toBe('completed');
    expect(todos.find((t) => t.id === 'b')?.status).toBe('in_progress');
    expect(r.details.autoCompleted).toContain('a');
    const text = r.content[0].text as string;
    expect(text).toContain('auto-advance: completed a');
  });

  it('auto-advance does NOT complete items the batch explicitly set', async () => {
    await run('todo_create', {
      items: [
        { text: 'Step A', id: 'a' },
        { text: 'Step B', id: 'b' },
      ],
    });
    await run('todo_update', { updates: [{ id: 'a', status: 'in_progress' }] });
    // Explicitly keep A in_progress while starting B — explicit wins.
    await run('todo_update', {
      updates: [
        { id: 'a', status: 'in_progress' },
        { id: 'b', status: 'in_progress' },
      ],
    });
    const todos = getTodos(SESSION);
    expect(todos.find((t) => t.id === 'a')?.status).toBe('in_progress');
    expect(todos.find((t) => t.id === 'b')?.status).toBe('in_progress');
  });

  it('legacy single-item {id, status} form is normalized into a batch', async () => {
    await run('todo_create', { items: [{ text: 'Only', id: 'only' }] });
    const r = await run('todo_update', { id: 'only', status: 'in_progress' });
    expect(r.details.applied).toBe(1);
    expect(getTodos(SESSION)[0].status).toBe('in_progress');
  });

  it('todo_update errors when no list exists', async () => {
    setActiveSession('no-list-session');
    const r = await run('todo_update', { updates: [{ id: 'x', status: 'completed' }] });
    expect(r.content[0].text).toContain('no todo list exists');
    expect(r.details.error).toBe('no_list');
  });

  it('todo_update reports unknown ids as errors (with valid ids in the result)', async () => {
    await run('todo_create', { items: [{ text: 'Real', id: 'real' }] });
    const r = await run('todo_update', {
      updates: [
        { id: 'real', status: 'completed' },
        { id: 'ghost', status: 'in_progress' },
      ],
    });
    expect(r.details.errors).toContain('no todo with id "ghost"');
    const text = r.content[0].text as string;
    expect(text).toContain('ERRORS: no todo with id "ghost"');
    // The valid transition still applied.
    expect(getTodos(SESSION)[0].status).toBe('completed');
  });

  it('todo_update rejects an empty batch', async () => {
    await run('todo_create', { items: [{ text: 'X', id: 'x' }] });
    const r = await run('todo_update', { updates: [] });
    expect(r.details.error).toBe('no_updates');
  });

  it('todo_add appends and returns the full list', async () => {
    await run('todo_create', { items: [{ text: 'First', id: 'first' }] });
    const r = await run('todo_add', { text: 'Second', id: 'second' });
    const text = r.content[0].text as string;
    expect(text).toContain('Added: [second] Second');
    expect(text).toContain('[first]');
    expect(getTodos(SESSION)).toHaveLength(2);
  });

  it('todo_remove deletes by id and reports not-found errors', async () => {
    await run('todo_create', { items: [{ text: 'Doomed', id: 'doomed' }] });
    const ok = await run('todo_remove', { id: 'doomed' });
    expect(ok.content[0].text).toContain('Removed: [doomed]');
    expect(getTodos(SESSION)).toHaveLength(0);
    const missing = await run('todo_remove', { id: 'doomed' });
    expect(missing.details.error).toBe('not_found');
  });

  it('blocked status accepts a note', async () => {
    await run('todo_create', { items: [{ text: 'Blocked step', id: 'b1' }] });
    await run('todo_update', { updates: [{ id: 'b1', status: 'blocked', note: 'waiting on copy' }] });
    const t = getTodos(SESSION)[0];
    expect(t.status).toBe('blocked');
    expect(t.note).toBe('waiting on copy');
  });
});

// ---- variant generator: JSON extraction ----------------------------------------

describe('variant-generator — spec extraction', () => {
  it('extracts the wrapped {direction, spec} form', () => {
    const content = '```json\n{"direction": "Minimal Light", "spec": {"type": "frame", "children": [{"type": "text", "text": "Hi"}]}}\n```';
    const spec = extractSpecJson(content);
    expect(spec).not.toBeNull();
    expect((spec as any).type).toBe('frame');
    expect(Array.isArray((spec as any).children)).toBe(true);
  });

  it('extracts a bare spec root (no wrapper)', () => {
    const content = '{"type": "frame", "children": []}';
    const spec = extractSpecJson(content);
    expect(spec).not.toBeNull();
    expect((spec as any).type).toBe('frame');
  });

  it('returns null for non-spec JSON', () => {
    expect(extractSpecJson('{"foo": 1}')).toBeNull();
  });

  it('extracts a balanced JSON block with nested braces + strings containing braces', () => {
    const content = 'prelude text {"a": {"b": "value with } brace"}, "c": [1,2]} trailing';
    const obj = extractJsonBlock(content);
    expect(obj).toEqual({ a: { b: 'value with } brace' }, c: [1, 2] });
  });

  it('returns null when no balanced block exists', () => {
    expect(extractJsonBlock('no json here')).toBeNull();
    expect(extractJsonBlock('{"unclosed": true')).toBeNull();
  });

  it('ships 3 maximally-distinct default directions', () => {
    expect(DEFAULT_VARIANT_DIRECTIONS).toHaveLength(3);
    const labels = DEFAULT_VARIANT_DIRECTIONS.map((d) => d.label);
    expect(labels).toContain('Minimal Light');
    expect(labels).toContain('Bold Vibrant');
    expect(labels).toContain('Dark Premium');
  });

  // ---- coercion of near-miss schemas (kimi-k2-5 live finding) -------------

  it('coerces a ui_components array into a wrapped frame tree', () => {
    // The EXACT failure shape observed live from kimi-k2-5: it invents a
    // ui_components schema with layout/positioning descriptors instead of
    // the node tree. After coercion: components with invented types become
    // frames, descriptor keys are dropped, children survive.
    const content = JSON.stringify({
      ui_components: [
        { type: 'navbar', layout: { structure: 'flex_row', max_width: '1280px' }, children: [{ type: 'text', text: 'Logo' }] },
        { type: 'card', positioning: { logo: 'left' }, children: [{ type: 'text', text: 'Price' }] },
      ],
    });
    const spec = extractSpecJson(content);
    expect(spec).not.toBeNull();
    expect((spec as any).type).toBe('frame');
    const kids = (spec as any).children as any[];
    expect(kids).toHaveLength(2);
    expect(kids[0].type).toBe('frame'); // invented 'navbar' degraded to frame
    expect(kids[0].layout).toBeUndefined(); // descriptor dropped
    expect(kids[0].children[0].type).toBe('text');
    expect(kids[1].positioning).toBeUndefined();
  });

  it('coerces a bare array of nodes into a wrapped frame', () => {
    const content = '[{"type": "text", "text": "A"}, {"type": "rectangle", "width": 10}]';
    const spec = extractSpecJson(content);
    expect(spec).not.toBeNull();
    expect((spec as any).type).toBe('frame');
    expect(((spec as any).children as any[])).toHaveLength(2);
  });

  it('degrades unknown node types to frame throughout the tree', () => {
    const content = JSON.stringify({
      spec: { type: 'hero', children: [{ type: 'button', children: [{ type: 'text', text: 'Go' }] }] },
    });
    const spec = extractSpecJson(content);
    expect((spec as any).type).toBe('frame');
    expect((spec as any).children[0].type).toBe('frame');
    expect((spec as any).children[0].children[0].type).toBe('text'); // known types survive
  });

  it('still rejects fully non-visual JSON', () => {
    expect(extractSpecJson('{"ui_components": [{"layout": "flex"}]}')).toBeNull(); // no node-shaped items
    expect(extractSpecJson('{"summary": "a nice design"}')).toBeNull();
  });
});

// ---- variant generator: composite render ----------------------------------------

describe('variant-generator — composite judge image', () => {
  it('composites 3 labeled variant PNGs side by side', async () => {
    // 1x1 red / green / blue PNGs — the composite just needs valid buffers.
    const sharp = (await import('sharp')).default;
    const pngs = await Promise.all(
      ['#ff0000', '#00ff00', '#0000ff'].map((color) =>
        sharp({ create: { width: 100, height: 80, channels: 3, background: color } }).png().toBuffer(),
      ),
    );
    const composite = await compositeVariantPngs([
      { label: 'Minimal Light', png: pngs[0] },
      { label: 'Bold Vibrant', png: pngs[1] },
      { label: 'Dark Premium', png: pngs[2] },
    ]);
    const meta = await sharp(composite).metadata();
    expect(meta.format).toBe('png');
    // 3 columns × 760px + 2 gutters × 24 + 2 margins × 16 = 2344px wide.
    expect(meta.width).toBe(3 * 760 + 2 * 24 + 2 * 16);
    expect((meta.height ?? 0)).toBeGreaterThan(0);
  });

  it('composites 2 variants (judge supports A/B too)', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#123456' } }).png().toBuffer();
    const composite = await compositeVariantPngs([
      { label: 'A', png },
      { label: 'B', png },
    ]);
    const meta = await sharp(composite).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(2 * 760 + 1 * 24 + 2 * 16);
  });
});

// ---- variant generator: wall-clock budget ---------------------------------------
//
// Live finding: retry multiplication (300s client timeout x callLLMWithRetry
// attempts x sequential retry wave x repairs) stalled ONE tool call past 19
// minutes. The dispatch must now resolve within its budget no matter what the
// endpoint does.

describe('variant-generator — wall-clock budget', () => {
  const GOOD_SPEC_JSON = JSON.stringify({
    direction: 'Minimal Light',
    spec: {
      type: 'frame',
      name: 'Pricing',
      children: [
        { type: 'text', text: 'Pro plan' },
        { type: 'text', text: '$12/mo' },
        { type: 'frame', children: [{ type: 'text', text: 'Choose' }] },
      ],
    },
  });

  const NEVER = new Promise<never>(() => {}); // hangs forever

  function hangAll(): any {
    return { chat: { completions: { create: () => NEVER } } };
  }

  it('a fully-hanging endpoint returns within the budget (fallback error), never hangs', async () => {
    const t0 = Date.now();
    const result = await dispatchVariantGeneration({
      request: 'a pricing page',
      llm: hangAll(),
      budgetMs: 1_200,
    });
    const elapsed = Date.now() - t0;
    // Budget 1.2s + scheduling slop — the pre-fix code would still be running.
    expect(elapsed).toBeLessThan(5_000);
    expect(result.variants).toHaveLength(0);
    expect(result.error).toBeTruthy();
    expect(result.notes.some((n: string) => n.includes('generation failed'))).toBe(true);
  });

  it('one fast variant + two hanging calls → single-candidate result within budget', async () => {
    let call = 0;
    const llm = {
      chat: {
        completions: {
          create: async () => {
            call++;
            if (call === 1) {
              return { choices: [{ message: { content: GOOD_SPEC_JSON } }] };
            }
            return NEVER; // variants 2 and 3 starve
          },
        },
      },
    } as any;
    const t0 = Date.now();
    const result = await dispatchVariantGeneration({
      request: 'a pricing page',
      llm,
      budgetMs: 1_500,
    });
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(result.variants).toHaveLength(1);
    expect(result.judge?.method).toBe('single-candidate');
    expect(result.judge?.winnerIndex).toBe(0);
    expect(result.error).toBeFalsy();
  });

  it('judge timeout → heuristic fallback, still within budget', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#abcdef' } }).png().toBuffer();
    const llm = {
      chat: {
        completions: {
          create: (req: any) => {
            const sys = req?.messages?.[0]?.content ?? '';
            if (typeof sys === 'string' && sys.includes('design lead')) return NEVER; // judge hangs
            return Promise.resolve({ choices: [{ message: { content: GOOD_SPEC_JSON } }] });
          },
        },
      },
    } as any;
    const t0 = Date.now();
    const result = await dispatchVariantGeneration({
      request: 'a pricing page',
      llm,
      budgetMs: 2_500,
      renderVariant: async () => ({ png, warningCount: 0, nodeCount: 5 }),
    });
    expect(Date.now() - t0).toBeLessThan(8_000);
    // All 3 specs parse; the judge hangs and is raced → heuristic pick.
    expect(result.variants.length).toBeGreaterThanOrEqual(2);
    expect(result.judge?.method).toBe('heuristic');
    expect(result.notes.some((n: string) => n.includes('heuristic'))).toBe(true);
  });
});
