// Integration tests — full pipeline: tool → ctx.applyPatch → store._onSync → undo/redo.
//
// These tests cross module boundaries that the unit tests cover in isolation:
//   - `tools.ts` calls `ctx.applyPatch` (which calls `applyPatchToCanvas`)
//   - The same patch, when fed through `useCanvasStore._onSync({type:'canvas:patch', patch})`,
//     must mutate the store's `document` AND push the prior document to the undo stack.
//   - `undo()` / `redo()` on the store must then reverse / re-apply the exact
//     mutation the tool made.
//
// We also test the agent-event orchestration: a simulated agent turn that emits
// `agent:message_start` → `agent:tool_call_start` → `canvas:patch` →
// `agent:tool_call_end` → `agent:turn_end` must leave the store in the same
// state as a real agent run would (minus the LLM call).

import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { createCanvasTools, executeTool } from '@/lib/agent/tools';
import type { CanvasToolContext } from '@/lib/agent/tools';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';

// ---- Fixtures ----------------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'test-doc',
    name: 'Test',
    background: '#ffffff',
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
    heatmap: null,
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
    activeRunBySession: {},
    _hydrated: true,
  });
}

/// Build a tool context that mirrors what `runAgent` uses internally: every
/// `applyPatch` mutates the live `canvas` so subsequent tool calls see the
/// updated state, AND also forwards the patch through `useCanvasStore._onSync`
/// so the store's undo/redo stacks + session mirroring fire.
function makeIntegrationCtx(): {
  canvas: CanvasDocument;
  ctx: CanvasToolContext;
  patches: CanvasPatch[];
} {
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
      // Mirror into the store — this is what the WebSocket / HTTP fallback
      // does in production. _onSync will push the prior doc to undoStack.
      useCanvasStore.getState()._onSync({ type: 'canvas:patch', patch });
      return patch;
    },
  };

  return { canvas, ctx, patches };
}

/// Run a single tool by name and return its result + emitted patches.
async function runTool(
  ctx: CanvasToolContext,
  name: string,
  args: any,
): Promise<{ content: string; patch?: CanvasPatch; isError?: boolean }> {
  const tools = createCanvasTools(ctx);
  return executeTool(tools, name, args);
}

/// Extract the first shape id from a tool's text response.
function firstShapeId(content: string): string {
  const m = content.match(/id[:\s]+([a-f0-9-]{8,})/i);
  if (m) return m[1];
  // Fallback — UUIDs anywhere in the text.
  const m2 = content.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return m2 ? m2[1] : '';
}

// ---- Tests -------------------------------------------------------------------

describe('integration: tool → store._onSync → undo/redo', () => {
  beforeEach(() => resetStore());

  it('pen_create_shape → undo reverts the shape', async () => {
    const { ctx } = makeIntegrationCtx();
    // Shape fields are at the top level of the args (ShapeInputSchema is the
    // tool's parameter schema).
    const r = await runTool(ctx, 'pen_create_shape', {
      type: 'rectangle',
      name: 'Card',
      x: 10,
      y: 10,
      width: 80,
      height: 50,
    });
    expect(r.isError).toBeFalsy();

    const afterCreate = useCanvasStore.getState().document;
    expect(afterCreate.shapes).toHaveLength(1);
    expect(afterCreate.shapes[0].name).toBe('Card');
    expect(afterCreate.shapes[0].width).toBe(80);
    expect(useCanvasStore.getState().undoStack).toHaveLength(1);

    useCanvasStore.getState().undo();
    const afterUndo = useCanvasStore.getState().document;
    expect(afterUndo.shapes).toHaveLength(0);
    expect(useCanvasStore.getState().redoStack).toHaveLength(1);

    useCanvasStore.getState().redo();
    const afterRedo = useCanvasStore.getState().document;
    expect(afterRedo.shapes).toHaveLength(1);
    expect(afterRedo.shapes[0].name).toBe('Card');
  });

  it('z-order bring_to_front is undoable', async () => {
    // Seed three shapes with explicit zIndices.
    resetStore(makeDoc([
      makeShape('a', { zIndex: 0, fill: '#f00' }),
      makeShape('b', { zIndex: 1, fill: '#0f0' }),
      makeShape('c', { zIndex: 2, fill: '#00f' }),
    ]));
    const { ctx } = makeIntegrationCtx();

    // Bring 'a' to the front.
    await runTool(ctx, 'pen_bring_to_front', { shapeIds: ['a'] });

    const after = useCanvasStore.getState().document;
    expect(after.shapes.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(useCanvasStore.getState().undoStack).toHaveLength(1);

    useCanvasStore.getState().undo();
    const afterUndo = useCanvasStore.getState().document;
    expect(afterUndo.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c']);

    useCanvasStore.getState().redo();
    const afterRedo = useCanvasStore.getState().document;
    expect(afterRedo.shapes.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('token binding propagates after token update — full chain through store', async () => {
    const { ctx } = makeIntegrationCtx();

    // 1. Define a token — `colors` is at the top level of the tool's params.
    await runTool(ctx, 'pen_update_tokens', {
      colors: [{ name: 'Primary', key: 'primary', value: '#ff0000' }],
    });

    // 2. Create a shape.
    const createRes = await runTool(ctx, 'pen_create_shape', {
      type: 'rectangle',
      name: 'Btn',
      x: 0, y: 0, width: 100, height: 40,
    });
    const shapeId = firstShapeId(createRes.content);
    expect(shapeId).not.toBe('');

    // 3. Bind it to the token — this immediately applies the token's value.
    const bindRes = await runTool(ctx, 'pen_bind_shape_to_token', {
      shapeId,
      tokenKey: 'primary',
      property: 'fill',
    });
    expect(bindRes.isError).toBeFalsy();

    const afterBind = useCanvasStore.getState().document;
    const bound = afterBind.shapes.find((s) => s.id === shapeId)!;
    expect(bound.tokenBinding?.fillToken).toBe('primary');
    expect(bound.fill.toLowerCase()).toBe('#ff0000');

    // 4. Update the token value.
    await runTool(ctx, 'pen_update_tokens', {
      colors: [{ name: 'Primary', key: 'primary', value: '#00ff00' }],
    });

    const doc = useCanvasStore.getState().document;
    const rebound = doc.shapes.find((s) => s.id === shapeId)!;
    expect(rebound.fill.toLowerCase()).toBe('#00ff00');
    expect(rebound.tokenBinding?.fillToken).toBe('primary');
  });

  it('bulk_update_by_filter mutates multiple shapes in one patch — undo reverts all atomically', async () => {
    resetStore(makeDoc([
      makeShape('r1', { fill: '#ff0000' }),
      makeShape('r2', { fill: '#ff0000' }),
      makeShape('b1', { fill: '#0000ff' }),
    ]));
    const { ctx } = makeIntegrationCtx();

    // Filter is at the top level — not nested under `filter:`.
    const r = await runTool(ctx, 'pen_bulk_update_by_filter', {
      fill: '#ff0000',
      changes: { fill: '#00ff00' },
    });
    expect(r.isError).toBeFalsy();

    const after = useCanvasStore.getState().document;
    expect(after.shapes.find((s) => s.id === 'r1')!.fill).toBe('#00ff00');
    expect(after.shapes.find((s) => s.id === 'r2')!.fill).toBe('#00ff00');
    expect(after.shapes.find((s) => s.id === 'b1')!.fill).toBe('#0000ff');
    expect(useCanvasStore.getState().undoStack).toHaveLength(1);

    useCanvasStore.getState().undo();
    const afterUndo = useCanvasStore.getState().document;
    expect(afterUndo.shapes.find((s) => s.id === 'r1')!.fill).toBe('#ff0000');
    expect(afterUndo.shapes.find((s) => s.id === 'r2')!.fill).toBe('#ff0000');
    expect(afterUndo.shapes.find((s) => s.id === 'b1')!.fill).toBe('#0000ff');
  });

  it('reorder moves a shape to a specific z-index — undo reverts', async () => {
    resetStore(makeDoc([
      makeShape('a', { zIndex: 0 }),
      makeShape('b', { zIndex: 1 }),
      makeShape('c', { zIndex: 2 }),
      makeShape('d', { zIndex: 3 }),
    ]));
    const { ctx } = makeIntegrationCtx();

    await runTool(ctx, 'pen_reorder_shape', { shapeId: 'd', zIndex: 0 });

    const after = useCanvasStore.getState().document;
    expect(after.shapes.map((s) => s.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(after.shapes.map((s) => s.zIndex)).toEqual([0, 1, 2, 3]);

    useCanvasStore.getState().undo();
    const afterUndo = useCanvasStore.getState().document;
    expect(afterUndo.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('export_json round-trip: export → clear → re-import restores shapes', async () => {
    resetStore(makeDoc([
      makeShape('a', { fill: '#ff0000', name: 'Red' }),
      makeShape('b', { fill: '#00ff00', name: 'Green' }),
    ]));
    const { ctx } = makeIntegrationCtx();

    const exportResult = await runTool(ctx, 'pen_export_json', {});
    expect(exportResult.isError).toBeFalsy();
    expect(exportResult.content).toContain('Red');
    expect(exportResult.content).toContain('Green');

    // The export tool wraps JSON in ```json ... ``` fences. Extract it.
    const jsonMatch = exportResult.content.match(/```json\n([\s\S]+?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.shapes).toHaveLength(2);

    // Clear the canvas, then re-import.
    await runTool(ctx, 'pen_clear', {});
    expect(useCanvasStore.getState().document.shapes).toHaveLength(0);

    // Re-import via a bulk_add patch (simulating a future "import_json" tool).
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: {
        op: 'bulk_add',
        shapes: parsed.shapes.map((s: any) => ({ ...s })),
        summary: 'import',
      },
    });
    const restored = useCanvasStore.getState().document;
    expect(restored.shapes).toHaveLength(2);
    expect(restored.shapes.find((s) => s.name === 'Red')).toBeDefined();
    expect(restored.shapes.find((s) => s.name === 'Green')).toBeDefined();
  });
});

// ---- Simulated agent turn ---------------------------------------------------

describe('integration: simulated agent turn through _onSync', () => {
  beforeEach(() => resetStore());

  /// Drive a synthetic agent turn through the store's _onSync — the exact
  /// same event sequence a real `runAgent` generator yields. Verifies the
  /// store ends up with: one assistant turn, one tool call recorded, the
  /// patch applied, and the undo stack pushed exactly once.
  async function simulateTurn(toolName: string, toolArgs: any, patch: CanvasPatch | null) {
    // Seed a session + run so the turn has somewhere to land.
    const ss = useSessionStore.getState();
    const session = ss.createSession('test-doc', { title: 'Simulated' });
    useCanvasStore.setState({ activeSessionId: session.id });
    const run = ss.startRun(session.id, 'do the thing', 'user_message');
    const userMsg = ss.appendUserMessage(session.id, run.id, 'do the thing');
    const assistantMsg = ss.appendAssistantMessage(session.id, run.id);

    // Mirror into turns (mirrors what promptAgent does).
    useCanvasStore.setState((s) => ({
      turns: [
        ...s.turns,
        {
          id: userMsg.id, role: 'user', text: 'do the thing', toolCalls: [],
          streaming: false, sessionId: session.id, runId: run.id, messageId: userMsg.id,
        },
        {
          id: assistantMsg.id, role: 'assistant', text: '', toolCalls: [],
          streaming: true, sessionId: session.id, runId: run.id, messageId: assistantMsg.id,
        },
      ],
      agentBusy: true,
    }));

    // Drive the agent event sequence.
    const toolCallId = `call-${Date.now()}`;
    useCanvasStore.getState()._onSync({ type: 'agent:message_start', role: 'assistant' });
    useCanvasStore.getState()._onSync({
      type: 'agent:tool_call_start',
      toolCallId,
      toolName,
      argsPreview: JSON.stringify(toolArgs).slice(0, 120),
    });
    if (patch) {
      useCanvasStore.getState()._onSync({ type: 'canvas:patch', patch, toolCallId });
    }
    useCanvasStore.getState()._onSync({
      type: 'agent:tool_call_end',
      toolCallId,
      success: true,
      summary: patch?.summary ?? 'ok',
    });
    useCanvasStore.getState()._onSync({ type: 'agent:message_end' });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });

    return { sessionId: session.id, runId: run.id, assistantMessageId: assistantMsg.id };
  }

  it('a single create_shape turn leaves the store + session store consistent', async () => {
    const { sessionId, runId, assistantMessageId } = await simulateTurn(
      'pen_create_shape',
      { type: 'rectangle', name: 'Hero', x: 0, y: 0, width: 200, height: 100 },
      {
        op: 'add',
        shape: { type: 'rectangle', name: 'Hero', x: 0, y: 0, width: 200, height: 100, id: 'hero-1' },
        summary: 'Created rectangle "Hero"',
      },
    );

    // Store: document has the shape, undo stack has one entry, agentBusy false.
    const s = useCanvasStore.getState();
    expect(s.document.shapes).toHaveLength(1);
    expect(s.document.shapes[0].id).toBe('hero-1');
    expect(s.undoStack).toHaveLength(1);
    expect(s.agentBusy).toBe(false);
    expect(s.turns).toHaveLength(2);
    expect(s.turns[1].toolCalls).toHaveLength(1);
    expect(s.turns[1].toolCalls[0].name).toBe('pen_create_shape');
    expect(s.turns[1].toolCalls[0].success).toBe(true);

    // Session store: run completed, tool call recorded, snapshot captured.
    const ss = useSessionStore.getState();
    const run = ss.getRun(runId);
    expect(run?.status).toBe('completed');

    const toolCalls = ss.listToolCalls(runId);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('pen_create_shape');
    expect(toolCalls[0].status).toBe('success');

    const messages = ss.listMessages(sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[1].status).toBe('complete');

    const snapshots = ss.listSnapshots(sessionId);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[snapshots.length - 1].source).toBe('turn_end');
  });

  it('a turn with an error leaves the run failed + assistant message erroring', async () => {
    // Manually drive an error event (not via simulateTurn, since we want
    // to test the error path directly).
    const ss = useSessionStore.getState();
    const session = ss.createSession('test-doc', { title: 'Err' });
    useCanvasStore.setState({ activeSessionId: session.id });
    const run = ss.startRun(session.id, 'fail', 'user_message');
    const userMsg = ss.appendUserMessage(session.id, run.id, 'fail');
    const assistantMsg = ss.appendAssistantMessage(session.id, run.id);
    useCanvasStore.setState((s) => ({
      turns: [
        ...s.turns,
        { id: userMsg.id, role: 'user', text: 'fail', toolCalls: [], streaming: false, sessionId: session.id, runId: run.id, messageId: userMsg.id },
        { id: assistantMsg.id, role: 'assistant', text: '', toolCalls: [], streaming: true, sessionId: session.id, runId: run.id, messageId: assistantMsg.id },
      ],
      agentBusy: true,
    }));

    useCanvasStore.getState()._onSync({
      type: 'agent:error',
      message: 'LLM rate-limited',
    });

    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(false);
    expect(s.turns[1].error).toBe('LLM rate-limited');
    expect(s.turns[1].streaming).toBe(false);

    const run2 = ss.getRun(run.id);
    expect(run2?.status).toBe('failed');
    expect(run2?.errorMessage).toBe('LLM rate-limited');
  });

  it('undo patch intercepted before applyPatchToCanvas — does not pollute undoStack', async () => {
    // Seed: doc with one shape, undo stack with one prior doc.
    const prior = makeDoc([]);
    resetStore(makeDoc([makeShape('a')]));
    useCanvasStore.setState({ undoStack: [prior], redoStack: [] });

    // Emit an undo patch (as pen_undo tool would).
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'undo', summary: 'undo last' },
    });

    const s = useCanvasStore.getState();
    expect(s.document.shapes).toHaveLength(0); // prior doc restored
    expect(s.undoStack).toHaveLength(0); // popped
    expect(s.redoStack).toHaveLength(1); // pushed
    // The undo op itself must NOT push another entry to the undo stack —
    // _onSync intercepts op=undo and calls undo() before any pushing happens.
    expect(s.redoStack[0].shapes).toHaveLength(1); // the doc-with-shape
  });

  it('select patch does not push to undo stack', async () => {
    resetStore(makeDoc([makeShape('a')]));
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'select', shapeIds: ['a'], summary: 'select a' },
    });
    expect(useCanvasStore.getState().undoStack).toHaveLength(0);
    // Highlight state set.
    expect(useCanvasStore.getState().agentHighlightIds).toEqual(['a']);
  });
});
