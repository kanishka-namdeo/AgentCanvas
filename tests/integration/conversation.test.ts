// Conversation-level tests — multi-run flows through `runAgent` + the store.
//
// The runner is stateless across runs (each run rebuilds its own message
// history from the canvas state). Real conversations in the app are a
// sequence of `runAgent` calls, each seeded with the canvas state the
// previous run produced. The session store + canvas store live-reload
// between runs to maintain message + snapshot history.
//
// These tests cover:
//   - Multi-run flows where run 2 builds on run 1's output (the runner sees
//     the post-run-1 canvas state in its system snapshot).
//   - The full chain runner → useCanvasStore._onSync → session store
//     mirroring (run end-to-end through the actual UI store, not a mock).
//   - Undo/redo via the pen_undo / pen_redo tools — the runner emits
//     op=undo patches, the store intercepts them, the canvas reverts.
//   - Token binding propagation across runs (run 1 binds, run 2 re-themes
//     via token update, all bound shapes recolor).
//   - Error recovery across runs (run 1 fails, run 2 succeeds, the session
//     store records both runs correctly).

import { describe, it, expect, beforeEach } from 'vitest';
import { runAgent, type LLMClient } from '@/lib/agent/runner';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, CanvasPatch, Shape, SyncEvent } from '@/lib/canvas/types'
import type { PenChild } from '@/lib/pen/types';

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

// ---- Mock LLM ----------------------------------------------------------------

interface ScriptEntry {
  content?: string;
  tool_calls?: Array<{ name: string; args: any }>;
  throw?: string;
}

class MockLLM implements LLMClient {
  private script: ScriptEntry[];
  private callCount = 0;
  capturedCalls: Array<{ messages: any[]; tools: any[]; tool_choice: string }> = [];

  constructor(script: ScriptEntry[]) {
    this.script = script;
  }

  chat = {
    completions: {
      create: async (params: {
        messages: any[];
        tools?: any[];
        tool_choice?: string;
        temperature?: number;
      }) => {
        this.capturedCalls.push({
          messages: JSON.parse(JSON.stringify(params.messages)),
          tools: params.tools ?? [],
          tool_choice: params.tool_choice as string,
        });

        const entry = this.script[this.callCount++];
        if (!entry) {
          return { choices: [{ message: { content: 'Done.', tool_calls: undefined } }] };
        }
        if (entry.throw) throw new Error(entry.throw);

        const toolCalls = entry.tool_calls?.map((tc, i) => ({
          id: `call-${this.callCount - 1}-${i}`,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args ?? {}),
          },
        }));

        return {
          choices: [{ message: { content: entry.content ?? null, tool_calls: toolCalls } }],
        };
      },
    },
  };
}

// ---- Run helpers -------------------------------------------------------------

/// Drive `runAgent` and forward every emitted event through the canvas
/// store's `_onSync` (the same path WebSocket events take in production).
/// This mirrors what `promptAgent` does in the HTTP fallback path: each
/// patch is applied via `applyPatchToCanvas` AND mirrored to `_onSync` so
/// the undo/redo stacks + session mirroring fire.
///
/// Also seeds a session + run + user message + assistant placeholder turn
/// (mirrors what `promptAgent` does) so the session store has somewhere to
/// record tool calls + snapshots.
///
/// Returns the runner's final canvas state (after applying all patches).
async function runThroughStore(
  prompt: string,
  llm: LLMClient,
  options: { seedSession?: boolean } = {},
): Promise<{ finalCanvas: CanvasDocument; events: SyncEvent[]; patches: CanvasPatch[] }> {
  const { seedSession = true } = options;
  const canvas = useCanvasStore.getState().document;

  // Seed the session + run + messages + live turns, mirroring promptAgent.
  let sessionId: string | null = null;
  let runId: string | null = null;
  let assistantMessageId: string | null = null;

  if (seedSession) {
    const ss = useSessionStore.getState();
    let sid = useCanvasStore.getState().activeSessionId;
    if (!sid) {
      const sess = ss.createSession('test-doc', { title: prompt.slice(0, 48) });
      sid = sess.id;
      useCanvasStore.setState({ activeSessionId: sid });
    }
    sessionId = sid;
    const run = ss.startRun(sid, prompt, 'user_message');
    runId = run.id;
    ss.autoTitleFromPrompt(sid, prompt);
    const userMsg = ss.appendUserMessage(sid, run.id, prompt);
    const assistantMsg = ss.appendAssistantMessage(sid, run.id);
    assistantMessageId = assistantMsg.id;

    useCanvasStore.setState((s) => ({
      turns: [
        ...s.turns,
        {
          id: userMsg.id, role: 'user', text: prompt, toolCalls: [],
          streaming: false, sessionId: sid, runId: run.id, messageId: userMsg.id,
        },
        {
          id: assistantMsg.id, role: 'assistant', text: '', toolCalls: [],
          streaming: true, sessionId: sid, runId: run.id, messageId: assistantMsg.id,
        },
      ],
      agentBusy: true,
    }));
  }

  const patches: CanvasPatch[] = [];
  const events: SyncEvent[] = [];

  for await (const ev of runAgent({
    documentId: 'test-doc',
    prompt,
    canvas, // runner deep-clones this; safe to pass by reference
    llm,
  })) {
    if (ev.kind === 'patch') {
      patches.push(ev.patch);
      // Mirror into the store — this fires undo stack push + session mirroring.
      // The store is the source of truth in this test, so we DON'T also apply
      // the patch to a local canvas variable. (op=undo/redo are intercepted
      // by the store before applyPatchToCanvas; if we applied them locally
      // we'd get a no-op and our local canvas would diverge from the store.)
      useCanvasStore.getState()._onSync({
        type: 'canvas:patch',
        patch: ev.patch,
        toolCallId: ev.toolCallId,
      });
    } else {
      events.push(ev.event);
      useCanvasStore.getState()._onSync(ev.event);
    }
  }

  // Flush any pending microtasks/timers before returning. The runner's
  // turn_end handler is synchronous, but the async generator machinery may
  // leave a microtask in the queue. Without this flush, a subsequent run's
  // turn_end could see a stale run status (the previous run's endRun hadn't
  // propagated yet) and skip the snapshot capture via the duplicate guard.
  // Empirically: without this, the "snapshot accumulation" test fails ~20%
  // of the time.
  await new Promise((r) => setTimeout(r, 0));

  // Read the final canvas from the store — it reflects every patch AND every
  // undo/redo interception. The store is the single source of truth here.
  const finalCanvas = useCanvasStore.getState().document;

  return { finalCanvas, events, patches };
}

/// Extract the first shape id from a tool's text response.
function firstShapeId(content: string): string {
  const m = content.match(/id[:\s]+([a-f0-9-]{8,})/i)
    ?? content.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return m ? m[1] : '';
}

// ---- Tests: multi-run conversation flows ------------------------------------

describe('conversation: multi-run flow — run 2 sees run 1 output', () => {
  beforeEach(() => resetStore());

  it('run 1 creates a shape, run 2 updates it (LLM sees prior canvas in system snapshot)', async () => {
    // Run 1: create a shape.
    const llm1 = new MockLLM([
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'Hero', x: 0, y: 0, width: 400, height: 200, fill: '#ff0000' } }] },
      { content: 'Created a Hero shape.' },
    ]);
    const run1 = await runThroughStore('create a hero shape', llm1);
    expect(run1.finalCanvas.shapes).toHaveLength(1);
    expect(run1.finalCanvas.shapes[0].name).toBe('Hero');
    const heroId = run1.finalCanvas.shapes[0].id;

    // The store should now reflect run 1's canvas state.
    expect(useCanvasStore.getState().document.shapes).toHaveLength(1);

    // Run 2: update the shape — the LLM script references the heroId via a
    // dynamic lookup in the system snapshot.
    const llm2 = new MockLLM([
      {
        tool_calls: [{
          name: 'pen_update_shape',
          args: { shapeId: '__DYNAMIC__', changes: { fill: '#00ff00' } },
        }],
      },
      { content: 'Recolored the Hero.' },
    ]);

    // Patch the script: replace __DYNAMIC__ with the real heroId from run 1.
    // The MockLLM's create() will be called with the scripted args; we
    // intercept the first call to substitute the id.
    const originalCreate = llm2.chat.completions.create.bind(llm2);
    (llm2 as any).chat.completions.create = async (params: any) => {
      const callIdx = (llm2 as any).capturedCalls.length;
      if (callIdx === 0) {
        // Replace __DYNAMIC__ in the first tool call's args.
        const entry = (llm2 as any).script[0] as ScriptEntry;
        if (entry.tool_calls) {
          for (const tc of entry.tool_calls) {
            if (tc.args && tc.args.shapeId === '__DYNAMIC__') {
              tc.args.shapeId = heroId;
            }
          }
        }
      }
      return originalCreate(params);
    };

    const run2 = await runThroughStore('make the hero green', llm2);
    expect(run2.finalCanvas.shapes).toHaveLength(1);
    expect(run2.finalCanvas.shapes[0].fill.toLowerCase()).toBe('#00ff00');

    // Critical: run 2's system snapshot (sent to the LLM in iteration 1)
    // MUST reflect run 1's output. The LLM saw the Hero shape and could
    // reference its id.
    const run2SystemMsg = llm2.capturedCalls[0].messages[0].content;
    expect(run2SystemMsg).toContain('Hero');
    expect(run2SystemMsg.toLowerCase()).toContain(heroId.toLowerCase());

    // Session store: two runs recorded, both completed.
    const ss = useSessionStore.getState();
    const sessionId = useCanvasStore.getState().activeSessionId!;
    const runs = ss.listRuns(sessionId);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);

    // Two snapshots captured (one per turn_end) — document-scoped (shared
    // canvas: the timeline is keyed by documentId, with sessionId provenance).
    const snaps = ss.listSnapshots('test-doc');
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    expect(snaps.every((s) => s.sessionId === sessionId || s.sessionId === null)).toBe(true);
  });
});

describe('conversation: undo/redo via tools', () => {
  beforeEach(() => resetStore());

  it('pen_undo tool emits op=undo patch — store intercepts + reverts canvas', async () => {
    // Seed the canvas with two shapes via direct store manipulation.
    resetStore(makeDoc([
      makeShape('a', { fill: '#ff0000' }),
      makeShape('b', { fill: '#00ff00' }),
    ]));

    // Run: create a third shape, then call pen_undo.
    const llm = new MockLLM([
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'C', x: 0, y: 0, width: 50, height: 50, fill: '#0000ff' } }] },
      { tool_calls: [{ name: 'pen_undo', args: {} }] },
      { content: 'Created and then undid.' },
    ]);

    const { finalCanvas } = await runThroughStore('create then undo', llm);

    // After the undo, the canvas should be back to 2 shapes (the create was reverted).
    expect(finalCanvas.shapes).toHaveLength(2);
    expect(finalCanvas.shapes.map((s) => s.name)).not.toContain('C');

    // The store's document should match.
    expect(useCanvasStore.getState().document.shapes).toHaveLength(2);

    // Undo stack: the create pushed one entry; the undo popped it.
    // (The undo itself does NOT push to the undo stack — _onSync intercepts it.)
    expect(useCanvasStore.getState().undoStack).toHaveLength(0);
    // And the redo stack now has the post-create state.
    expect(useCanvasStore.getState().redoStack).toHaveLength(1);
    expect(useCanvasStore.getState().redoStack[0].shapes).toHaveLength(3);
  });

  it('pen_redo after pen_undo restores the change', async () => {
    resetStore(makeDoc([makeShape('a')]));

    const llm = new MockLLM([
      // Create a shape (pushes undo stack).
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'B', x: 0, y: 0, width: 50, height: 50 } }] },
      // Undo it (pops undo, pushes redo).
      { tool_calls: [{ name: 'pen_undo', args: {} }] },
      // Redo it (pops redo, pushes undo).
      { tool_calls: [{ name: 'pen_redo', args: {} }] },
      { content: 'Done.' },
    ]);

    const { finalCanvas } = await runThroughStore('create, undo, redo', llm);

    // Final state: 2 shapes (the original + the redo-restored B).
    expect(finalCanvas.shapes).toHaveLength(2);
    expect(finalCanvas.shapes.map((s) => s.name)).toContain('B');

    // Undo stack has one entry (the pre-create state).
    expect(useCanvasStore.getState().undoStack).toHaveLength(1);
    // Redo stack is empty (the redo consumed it).
    expect(useCanvasStore.getState().redoStack).toHaveLength(0);
  });
});

describe('conversation: token binding across runs', () => {
  beforeEach(() => resetStore());

  it('run 1 binds shape to token; run 2 re-themes via token update', async () => {
    // Run 1: define token, create shape, bind it.
    const llm1 = new MockLLM([
      { tool_calls: [{ name: 'pen_update_tokens', args: { colors: [{ name: 'Brand', key: 'brand', value: '#3b82f6' }] } }] },
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'Btn', x: 0, y: 0, width: 100, height: 40, fill: '#cccccc' } }] },
      { content: 'Set up a brand token + button.' },
    ]);
    const run1 = await runThroughStore('set up a brand button', llm1);
    const btnId = run1.finalCanvas.shapes.find((s) => s.name === 'Btn')!.id;

    // Bind the button to the token (separate run for clarity).
    const llm1b = new MockLLM([
      { tool_calls: [{ name: 'pen_bind_shape_to_token', args: { shapeId: '__DYNAMIC__', tokenKey: 'brand', property: 'fill' } }] },
      { content: 'Bound.' },
    ]);
    const originalCreate = llm1b.chat.completions.create.bind(llm1b);
    (llm1b as any).chat.completions.create = async (params: any) => {
      const callIdx = (llm1b as any).capturedCalls.length;
      if (callIdx === 0) {
        const entry = (llm1b as any).script[0] as ScriptEntry;
        if (entry.tool_calls) {
          for (const tc of entry.tool_calls) {
            if (tc.args && tc.args.shapeId === '__DYNAMIC__') {
              tc.args.shapeId = btnId;
            }
          }
        }
      }
      return originalCreate(params);
    };
    await runThroughStore('bind the button to the brand token', llm1b);

    // Verify the binding took.
    const afterBind = useCanvasStore.getState().document;
    expect(afterBind.shapes.find((s) => s.id === btnId)!.fill.toLowerCase()).toBe('#3b82f6');
    expect(afterBind.shapes.find((s) => s.id === btnId)!.tokenBinding?.fillToken).toBe('brand');

    // Run 2: re-theme by updating the token.
    const llm2 = new MockLLM([
      { tool_calls: [{ name: 'pen_update_tokens', args: { colors: [{ name: 'Brand', key: 'brand', value: '#ef4444' }] } }] },
      { content: 'Re-themed to red.' },
    ]);
    await runThroughStore('re-theme to red', llm2);

    // The button should now be red — the tokens-patch re-application in
    // patch.ts propagated the change to the bound shape.
    const afterTheme = useCanvasStore.getState().document;
    expect(afterTheme.shapes.find((s) => s.id === btnId)!.fill.toLowerCase()).toBe('#ef4444');
    // Binding still in place.
    expect(afterTheme.shapes.find((s) => s.id === btnId)!.tokenBinding?.fillToken).toBe('brand');
  });
});

describe('conversation: error recovery across runs', () => {
  beforeEach(() => resetStore());

  it('run 1 fails (LLM throws), run 2 succeeds — session store records both correctly', async () => {
    // Run 1: LLM throws an error.
    const llm1 = new MockLLM([{ throw: 'upstream timeout' }]);
    await runThroughStore('do something that fails', llm1);

    // The session store should have recorded run 1 as failed.
    const ss = useSessionStore.getState();
    const sessionId = useCanvasStore.getState().activeSessionId!;
    const runs1 = ss.listRuns(sessionId);
    expect(runs1).toHaveLength(1);
    expect(runs1[0].status).toBe('failed');
    expect(runs1[0].errorMessage).toContain('upstream timeout');

    // The assistant message should be marked erroring.
    const msgs1 = ss.listMessages(sessionId);
    const assistant1 = msgs1.find((m) => m.role === 'assistant');
    expect(assistant1?.status).toBe('error');
    expect(assistant1?.error).toContain('upstream timeout');

    // Run 2: succeeds.
    const llm2 = new MockLLM([
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'Recovery', x: 0, y: 0, width: 100, height: 50 } }] },
      { content: 'Recovered.' },
    ]);
    await runThroughStore('try again', llm2);

    // Session store now has 2 runs: 1 failed, 1 completed.
    const runs2 = ss.listRuns(sessionId);
    expect(runs2).toHaveLength(2);
    expect(runs2[0].status).toBe('failed');
    expect(runs2[1].status).toBe('completed');

    // Canvas reflects run 2's output.
    expect(useCanvasStore.getState().document.shapes.map((s) => s.name)).toContain('Recovery');

    // 4 messages total: user1 + assistant1 (error) + user2 + assistant2 (complete).
    const msgs2 = ss.listMessages(sessionId);
    expect(msgs2).toHaveLength(4);
    expect(msgs2[1].status).toBe('error');
    expect(msgs2[3].status).toBe('complete');
  });
});

describe('conversation: snapshot accumulation across runs', () => {
  beforeEach(() => resetStore());

  it('each run captures exactly one snapshot at turn_end — no duplicates, no missing', async () => {
    const llm1 = new MockLLM([
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'A', x: 0, y: 0, width: 50, height: 50 } }] },
      { content: 'done' },
    ]);
    await runThroughStore('create A', llm1);

    const llm2 = new MockLLM([
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'B', x: 60, y: 0, width: 50, height: 50 } }] },
      { content: 'done' },
    ]);
    await runThroughStore('create B', llm2);

    const llm3 = new MockLLM([
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'C', x: 120, y: 0, width: 50, height: 50 } }] },
      { content: 'done' },
    ]);
    await runThroughStore('create C', llm3);

    const ss = useSessionStore.getState();
    const sessionId = useCanvasStore.getState().activeSessionId!;
    // Document-scoped timeline (shared canvas model).
    const snaps = ss.listSnapshots('test-doc');

    // 3 runs → 3 snapshots (one per turn_end).
    expect(snaps).toHaveLength(3);

    // listSnapshots returns newest-first (descending by createdAt) — this is
    // the conventional display order for a history panel. So snaps[0] is the
    // most recent (3 shapes) and snaps[2] is the oldest (1 shape).
    expect(snaps[0].document.shapes).toHaveLength(3);
    expect(snaps[0].document.shapes.map((s) => s.name)).toContain('C');
    expect(snaps[1].document.shapes).toHaveLength(2);
    expect(snaps[2].document.shapes).toHaveLength(1);
    expect(snaps[2].document.shapes[0].name).toBe('A');

    // Each is createdBy='agent' (turn_end path).
    expect(snaps.every((s) => s.createdBy === 'agent')).toBe(true);
    expect(snaps.every((s) => s.source === 'turn_end')).toBe(true);

    // 3 runs all completed.
    const runs = ss.listRuns(sessionId);
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
  });
});

describe('conversation: full chat history across runs', () => {
  beforeEach(() => resetStore());

  it('three consecutive runs accumulate user + assistant messages in order', async () => {
    const prompts = [
      'create a red square',
      'create a blue square next to it',
      'create a green square below them',
    ];

    const colors = ['#ff0000', '#0000ff', '#00ff00'];
    const names = ['Red', 'Blue', 'Green'];

    for (let i = 0; i < 3; i++) {
      const llm = new MockLLM([
        {
          tool_calls: [{
            name: 'pen_create_shape',
            args: { type: 'rectangle', name: names[i], x: i * 60, y: 0, width: 50, height: 50, fill: colors[i] },
          }],
        },
        { content: `Created ${names[i]}.` },
      ]);
      await runThroughStore(prompts[i], llm);
    }

    const ss = useSessionStore.getState();
    const sessionId = useCanvasStore.getState().activeSessionId!;
    const messages = ss.listMessages(sessionId);

    // 3 runs × 2 messages each = 6 messages, alternating user/assistant.
    expect(messages).toHaveLength(6);
    for (let i = 0; i < 3; i++) {
      const userMsg = messages[i * 2];
      const assistantMsg = messages[i * 2 + 1];
      expect(userMsg.role).toBe('user');
      expect(userMsg.text).toBe(prompts[i]);
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.text).toContain(names[i]);
      expect(assistantMsg.status).toBe('complete');
    }

    // Canvas has all 3 shapes.
    const doc = useCanvasStore.getState().document;
    expect(doc.shapes.map((s) => s.name)).toEqual(['Red', 'Blue', 'Green']);
    expect(doc.shapes.map((s) => s.fill)).toEqual(colors);

    // Live turns buffer rebuilt from session messages via _syncTurnsFromSession.
    useCanvasStore.getState()._syncTurnsFromSession();
    const turns = useCanvasStore.getState().turns;
    expect(turns).toHaveLength(6);
    expect(turns.every((t) => t.streaming === false)).toBe(true);
    // Each assistant turn has exactly one tool call recorded.
    expect(turns[1].toolCalls).toHaveLength(1);
    expect(turns[3].toolCalls).toHaveLength(1);
    expect(turns[5].toolCalls).toHaveLength(1);
  });
});
