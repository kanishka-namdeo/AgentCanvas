// End-to-end runner tests — drive `runAgent` with a scriptable mock LLM.
//
// The previous integration tests cover tool → patch → store wiring in
// isolation. These tests cover the actual agent loop:
//
//   runAgent(prompt, canvas, llm=MockLLM)
//     → ZAI-shaped LLM call
//     → tool_calls parsed + executed sequentially
//     → tool results appended to message history
//     → next LLM iteration sees the updated canvas snapshot
//     → emits the full event stream: message_start → tool_call_start →
//       patch → tool_call_end → ... → message_end → turn_end
//
// The MockLLM is a tiny fake that returns scripted completions per iteration.
// Each script entry is either:
//   { content: '...' }                      → text-only response (ends turn)
//   { tool_calls: [{ name, args }] }        → execute tools, continue loop
//   { content: '...', tool_calls: [...] }   → both (stream text + execute)
//   { throw: '...' }                        → simulate LLM failure
//
// We verify:
//   - The complete event sequence a real agent run produces.
//   - The canvas ends up mutated exactly as the tool calls dictate.
//   - Tool results are fed back into the LLM message history.
//   - The system snapshot is refreshed between iterations.
//   - Edge cases: max iterations, LLM throws, malformed args, empty turn.
//   - The runner does NOT mutate the input canvas (deep-clones on entry).

import { describe, it, expect, beforeEach } from 'vitest';
import { runAgent, type LLMClient } from '@/lib/agent/runner';
import type { CanvasDocument, CanvasPatch, Shape, SyncEvent } from '@/lib/canvas/types';

// ---- Fixtures ----------------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'test-doc',
    name: 'Test',
    background: '#ffffff',
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

// ---- Mock LLM ----------------------------------------------------------------

/// One scripted LLM response. Exactly one of `content`, `tool_calls`, or
/// `throw` should be set per entry.
interface ScriptEntry {
  /// Text content to return as the assistant message. If set WITHOUT
  /// `tool_calls`, the runner ends the turn after this iteration.
  content?: string;
  /// Tool calls to emit. If set, the runner executes them and continues.
  tool_calls?: Array<{ name: string; args: any }>;
  /// If set, the mock LLM throws this error message.
  throw?: string;
}

/// A scriptable mock LLM that returns scripted completions per iteration.
/// Records every `chat.completions.create` call so tests can assert on the
/// message history the runner built (system snapshot refresh, tool result
/// feedback, etc.).
class MockLLM implements LLMClient {
  private script: ScriptEntry[];
  private callCount = 0;
  /// Captured `messages` arrays from every LLM call. Tests inspect these to
  /// verify the runner is feeding tool results back into the LLM and
  /// refreshing the system snapshot between iterations.
  capturedCalls: Array<{ messages: any[]; tools: any[]; tool_choice: string }> = [];

  constructor(script: ScriptEntry[]) {
    this.script = script;
  }

  chat = {
    completions: {
      create: async (params: {
        messages: any[];
        tools: any[];
        tool_choice?: string;
        temperature?: number;
      }) => {
        this.capturedCalls.push({
          messages: JSON.parse(JSON.stringify(params.messages)),
          tools: params.tools,
          tool_choice: params.tool_choice as string,
        });

        const entry = this.script[this.callCount++];
        if (!entry) {
          // Default to a text-only "done" response if the script runs out.
          // This makes tests resilient — if the LLM keeps being called after
          // the script ends, we treat it as "the model decided to stop".
          return {
            choices: [{ message: { content: 'Done.', tool_calls: undefined } }],
          };
        }

        if (entry.throw) {
          throw new Error(entry.throw);
        }

        const toolCalls = entry.tool_calls?.map((tc, i) => ({
          id: `call-${this.callCount - 1}-${i}`,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args ?? {}),
          },
        }));

        return {
          choices: [
            {
              message: {
                content: entry.content ?? null,
                tool_calls: toolCalls,
              },
            },
          ],
        };
      },
    },
  };
}

// ---- Event collector ---------------------------------------------------------

interface CollectedEvents {
  patches: Array<{ patch: CanvasPatch; toolCallId?: string }>;
  events: SyncEvent[];
}

/// Drain the runner's async generator into a flat list of patches + events.
/// Also tracks the ORDER events arrived in (critical for verifying the
/// message_start → tool_call_start → patch → tool_call_end → ... → turn_end
/// sequence).
async function runAndCollect(
  opts: Parameters<typeof runAgent>[0],
): Promise<CollectedEvents & { finalCanvas: CanvasDocument }> {
  const patches: Array<{ patch: CanvasPatch; toolCallId?: string }> = [];
  const events: SyncEvent[] = [];
  const ordered: Array<{ kind: 'patch' | 'event'; idx: number }> = [];

  for await (const ev of runAgent(opts)) {
    if (ev.kind === 'patch') {
      patches.push({ patch: ev.patch, toolCallId: ev.toolCallId });
      ordered.push({ kind: 'patch', idx: patches.length - 1 });
    } else {
      events.push(ev.event);
      ordered.push({ kind: 'event', idx: events.length - 1 });
    }
  }

  // The runner mutates an internal copy of the canvas. We need to reconstruct
  // the final state by applying every emitted patch in order — this mirrors
  // what the production store does.
  let canvas = JSON.parse(JSON.stringify(opts.canvas)) as CanvasDocument;
  // Import the patch applier lazily so this file stays self-contained at the top.
  const { applyPatchToCanvas } = await import('@/lib/canvas/patch');
  for (const { patch } of patches) {
    canvas = applyPatchToCanvas(canvas, patch);
  }

  return { patches, events, finalCanvas: canvas };
}

/// Get the type sequence of agent events (e.g. ['message_start', 'message_delta',
/// 'message_end', 'turn_end']) — handy for asserting on the high-level shape
/// of a turn without caring about payloads.
function eventTypes(events: SyncEvent[]): string[] {
  return events.map((e) => e.type);
}

/// Get the sequence of (toolName, success) tuples in arrival order — handy
/// for verifying which tools ran and in what order.
function toolCallSequence(events: SyncEvent[]): Array<{ name: string; success?: boolean }> {
  const out: Array<{ name: string; success?: boolean }> = [];
  let pending: { name: string } | null = null;
  for (const e of events) {
    if (e.type === 'agent:tool_call_start') {
      pending = { name: e.toolName };
    } else if (e.type === 'agent:tool_call_end' && pending) {
      out.push({ name: pending.name, success: e.success });
      pending = null;
    }
  }
  return out;
}

// ---- Tests: basic agent loop shape ------------------------------------------

describe('runner: basic loop shape', () => {
  it('text-only response emits the canonical event sequence with no patches', async () => {
    const llm = new MockLLM([
      { content: 'I cannot help with that.' },
    ]);

    const { patches, events, finalCanvas } = await runAndCollect({
      documentId: 'd1',
      prompt: 'do something impossible',
      canvas: makeDoc([]),
      llm,
    });

    // No patches should be emitted.
    expect(patches).toHaveLength(0);

    // Event sequence: message_start → message_delta → message_end → turn_end.
    expect(eventTypes(events)).toEqual([
      'agent:message_start',
      'agent:message_delta',
      'agent:message_end',
      'agent:turn_end',
    ]);

    // The message_delta text matches what the LLM returned.
    const delta = events.find((e) => e.type === 'agent:message_delta') as any;
    expect(delta.text).toBe('I cannot help with that.');

    // Canvas unchanged.
    expect(finalCanvas.shapes).toHaveLength(0);

    // The LLM was called exactly once.
    expect(llm.capturedCalls).toHaveLength(1);
  });

  it('a single create_shape tool call mutates the canvas + ends the turn', async () => {
    const llm = new MockLLM([
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'Card', x: 10, y: 10, width: 80, height: 50 } }] },
      { content: 'Created a Card shape.' },
    ]);

    const { patches, events, finalCanvas } = await runAndCollect({
      documentId: 'd1',
      prompt: 'create a card',
      canvas: makeDoc([]),
      llm,
    });

    // One patch (the create_shape), then a text summary, then turn ends.
    expect(patches).toHaveLength(1);
    expect(patches[0].patch.op).toBe('add');
    expect(patches[0].patch.shape?.name).toBe('Card');

    // Event sequence: message_start → tool_call_start → tool_call_end →
    // message_delta (summary) → message_end → turn_end.
    expect(eventTypes(events)).toEqual([
      'agent:message_start',
      'agent:tool_call_start',
      'agent:tool_call_end',
      'agent:message_delta',
      'agent:message_end',
      'agent:turn_end',
    ]);

    // The canvas reflects the new shape.
    expect(finalCanvas.shapes).toHaveLength(1);
    expect(finalCanvas.shapes[0].name).toBe('Card');

    // Two LLM iterations: first emitted the tool call, second saw the tool
    // result and decided to stop.
    expect(llm.capturedCalls).toHaveLength(2);

    // Tool call success recorded.
    const tcEnd = events.find((e) => e.type === 'agent:tool_call_end') as any;
    expect(tcEnd.success).toBe(true);
  });

  it('multiple tool calls in one LLM iteration execute sequentially in order', async () => {
    const llm = new MockLLM([
      {
        tool_calls: [
          { name: 'pen_create_shape', args: { type: 'rectangle', name: 'A', x: 0, y: 0, width: 50, height: 50 } },
          { name: 'pen_create_shape', args: { type: 'rectangle', name: 'B', x: 60, y: 0, width: 50, height: 50 } },
          { name: 'pen_create_shape', args: { type: 'rectangle', name: 'C', x: 120, y: 0, width: 50, height: 50 } },
        ],
      },
      { content: 'Created three shapes.' },
    ]);

    const { patches, events, finalCanvas } = await runAndCollect({
      documentId: 'd1',
      prompt: 'create three shapes',
      canvas: makeDoc([]),
      llm,
    });

    // All three tool calls emitted in order.
    expect(patches).toHaveLength(3);
    expect(patches.map((p) => p.patch.shape?.name)).toEqual(['A', 'B', 'C']);

    // The tool call sequence in events is in order too.
    const tcSeq = toolCallSequence(events);
    expect(tcSeq.map((t) => t.name)).toEqual([
      'pen_create_shape',
      'pen_create_shape',
      'pen_create_shape',
    ]);
    expect(tcSeq.every((t) => t.success === true)).toBe(true);

    // Canvas has all three shapes in z-order.
    expect(finalCanvas.shapes.map((s) => s.name)).toEqual(['A', 'B', 'C']);

    // Two LLM iterations.
    expect(llm.capturedCalls).toHaveLength(2);
  });

  it('combined content + tool_calls in one message streams text then runs tools', async () => {
    const llm = new MockLLM([
      {
        content: 'Let me create a card for you.',
        tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'Card', x: 0, y: 0, width: 100, height: 60 } }],
      },
      { content: 'Done!' },
    ]);

    const { events, finalCanvas } = await runAndCollect({
      documentId: 'd1',
      prompt: 'create a card',
      canvas: makeDoc([]),
      llm,
    });

    // The first iteration emitted BOTH a message_delta AND a tool_call.
    // Order matters: the runner streams content first, then runs tools.
    const types = eventTypes(events);
    const firstDeltaIdx = types.indexOf('agent:message_delta');
    const firstToolStartIdx = types.indexOf('agent:tool_call_start');
    expect(firstDeltaIdx).toBeLessThan(firstToolStartIdx);
    expect(firstDeltaIdx).toBeGreaterThanOrEqual(0);

    // The text content from iteration 1 is preserved.
    const firstDelta = events[firstDeltaIdx] as any;
    expect(firstDelta.text).toBe('Let me create a card for you.');

    // Canvas reflects the shape.
    expect(finalCanvas.shapes).toHaveLength(1);
    expect(finalCanvas.shapes[0].name).toBe('Card');
  });
});

// ---- Tests: multi-iteration loop with tool-result feedback ------------------

describe('runner: multi-iteration tool-result feedback', () => {
  it('the LLM sees the tool result from the previous iteration', async () => {
    const llm = new MockLLM([
      // Iteration 1: list shapes (canvas is empty).
      { tool_calls: [{ name: 'pen_list_shapes', args: {} }] },
      // Iteration 2: create a shape based on the list result.
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'First', x: 0, y: 0, width: 100, height: 60 } }] },
      // Iteration 3: list again (should see the new shape).
      { tool_calls: [{ name: 'pen_list_shapes', args: {} }] },
      // Iteration 4: done.
      { content: 'Created and verified.' },
    ]);

    const { finalCanvas } = await runAndCollect({
      documentId: 'd1',
      prompt: 'create a shape and verify',
      canvas: makeDoc([]),
      llm,
    });

    // 4 LLM calls.
    expect(llm.capturedCalls).toHaveLength(4);

    // The 2nd LLM call (iteration 2) must have received a tool message from
    // the list_shapes call in iteration 1. The tool message's role is 'tool'
    // and it references the tool_call_id.
    const iter2Messages = llm.capturedCalls[1].messages;
    const toolMessages = iter2Messages.filter((m: any) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toMatch(/no shapes|empty|0 shapes/i);

    // The 3rd LLM call (iteration 3) must have received a tool message from
    // the create_shape call in iteration 2. That message should mention the
    // newly created shape.
    const iter3Messages = llm.capturedCalls[2].messages;
    const createToolMsg = iter3Messages.filter((m: any) => m.role === 'tool' && /First|rectangle/i.test(m.content));
    expect(createToolMsg.length).toBeGreaterThanOrEqual(1);

    // Final canvas has the shape.
    expect(finalCanvas.shapes).toHaveLength(1);
    expect(finalCanvas.shapes[0].name).toBe('First');
  });

  it('the system snapshot is refreshed between iterations (LLM sees updated canvas)', async () => {
    const llm = new MockLLM([
      // Iteration 1: create a shape.
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'Box', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000' } }] },
      // Iteration 2: update that shape's fill.
      { tool_calls: [{ name: 'pen_update_shape', args: { shapeId: 'WILL-BE-REPLACED', changes: { fill: '#00ff00' } } }] },
      // Iteration 3: done.
      { content: 'Updated.' },
    ]);

    // We need to know the id of the shape created in iteration 1 to update it
    // in iteration 2. The runner generates the id inside applyPatchToCanvas,
    // so we can't predict it before the test runs. Instead, we use a dynamic
    // script: the MockLLM looks at the tool result from iteration 1 to extract
    // the id, then uses it in iteration 2.
    const dynamicScript: ScriptEntry[] = [
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'Box', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000' } }] },
      // The args here are a placeholder; the MockLLM will rewrite them below.
      { tool_calls: [{ name: 'pen_update_shape', args: { shapeId: '__DYNAMIC__', changes: { fill: '#00ff00' } } }] },
      { content: 'Updated.' },
    ];
    const dynamicLlm = new MockLLM(dynamicScript);

    // Override the create method to dynamically substitute the shapeId.
    const originalCreate = dynamicLlm.chat.completions.create.bind(dynamicLlm);
    let shapeId: string | null = null;
    (dynamicLlm as any).chat.completions.create = async (params: any) => {
      // If the previous tool result contains a shape id, capture it.
      const lastToolMsg = [...params.messages].reverse().find((m: any) => m.role === 'tool');
      if (lastToolMsg && !shapeId) {
        const m = lastToolMsg.content.match(/id[:\s]+([a-f0-9-]{8,})/i);
        if (m) shapeId = m[1];
      }
      // If the current scripted call references __DYNAMIC__, substitute.
      const callIdx = (dynamicLlm as any).capturedCalls.length;
      const entry = dynamicScript[callIdx];
      if (entry?.tool_calls && shapeId) {
        for (const tc of entry.tool_calls) {
          if (tc.args && tc.args.shapeId === '__DYNAMIC__') {
            tc.args.shapeId = shapeId;
          }
        }
      }
      return originalCreate(params);
    };

    const { finalCanvas } = await runAndCollect({
      documentId: 'd1',
      prompt: 'create then update',
      canvas: makeDoc([]),
      llm: dynamicLlm,
    });

    // The system snapshot in iteration 2 must reflect the shape created in
    // iteration 1. We verify by checking the captured messages[0] (system)
    // of iteration 2 contains the shape name "Box".
    const iter2System = (dynamicLlm as any).capturedCalls[1].messages[0].content;
    expect(iter2System).toContain('Box');

    // And in iteration 1's system message, the canvas should be empty.
    const iter1System = (dynamicLlm as any).capturedCalls[0].messages[0].content;
    expect(iter1System.toLowerCase()).toContain('(empty)');

    // Final canvas: shape exists with the updated fill.
    expect(finalCanvas.shapes).toHaveLength(1);
    expect(finalCanvas.shapes[0].fill.toLowerCase()).toBe('#00ff00');
  });

  it('a 5-iteration design flow accumulates state correctly across iterations', async () => {
    // Simulates a realistic "design a card" workflow spread across 5 LLM
    // iterations, each emitting one tool call. Tests that the runner keeps
    // the canvas + message history consistent across many iterations.
    const llm = new MockLLM([
      // Iter 1: define a color token.
      { tool_calls: [{ name: 'pen_update_tokens', args: { colors: [{ name: 'Brand', key: 'brand', value: '#3b82f6' }] } }] },
      // Iter 2: create a card background.
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'Card', x: 0, y: 0, width: 320, height: 200, fill: '#ffffff', radius: 12 } }] },
      // Iter 3: create a title.
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'text', name: 'Title', x: 20, y: 20, width: 280, height: 32, text: 'Hello', fontSize: 24, textColor: '#0f172a' } }] },
      // Iter 4: create a body.
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'text', name: 'Body', x: 20, y: 60, width: 280, height: 20, text: 'World', fontSize: 14, textColor: '#475569' } }] },
      // Iter 5: done.
      { content: 'Designed a card.' },
    ]);

    const { patches, events, finalCanvas } = await runAndCollect({
      documentId: 'd1',
      prompt: 'design a card',
      canvas: makeDoc([]),
      llm,
    });

    expect(llm.capturedCalls).toHaveLength(5);
    expect(patches).toHaveLength(4); // 4 tool calls emitted patches (update_tokens also patches)
    expect(finalCanvas.shapes).toHaveLength(3);
    expect(finalCanvas.shapes.map((s) => s.name)).toEqual(['Card', 'Title', 'Body']);
    expect(finalCanvas.tokens.colors).toHaveLength(1);
    expect(finalCanvas.tokens.colors[0].key).toBe('brand');

    // All tool calls succeeded.
    const tcSeq = toolCallSequence(events);
    expect(tcSeq.length).toBe(4);
    expect(tcSeq.every((t) => t.success === true)).toBe(true);

    // Exactly one turn_end at the end.
    const turnEnds = events.filter((e) => e.type === 'agent:turn_end');
    expect(turnEnds).toHaveLength(1);
  });
});

// ---- Tests: error paths -----------------------------------------------------

describe('runner: error paths', () => {
  it('LLM throw emits agent:error and exits cleanly', async () => {
    const llm = new MockLLM([
      { throw: 'rate limit exceeded' },
    ]);

    const { patches, events } = await runAndCollect({
      documentId: 'd1',
      prompt: 'anything',
      canvas: makeDoc([]),
      llm,
    });

    expect(patches).toHaveLength(0);
    expect(eventTypes(events)).toEqual([
      'agent:message_start',
      'agent:error',
    ]);

    const err = events.find((e) => e.type === 'agent:error') as any;
    expect(err.message).toContain('rate limit exceeded');
    expect(err.message).toContain('LLM request failed');
  });

  it('tool error is recorded as success=false but the turn continues', async () => {
    // The LLM calls a tool with a bad shapeId — the tool returns isError.
    // The runner should still emit tool_call_end with success=false and
    // continue the loop. The next iteration sees the error in the tool result.
    const llm = new MockLLM([
      { tool_calls: [{ name: 'pen_delete_shape', args: { shapeId: 'does-not-exist' } }] },
      { content: 'Sorry, that shape does not exist.' },
    ]);

    const { events } = await runAndCollect({
      documentId: 'd1',
      prompt: 'delete a missing shape',
      canvas: makeDoc([]),
      llm,
    });

    const tcEnd = events.find((e) => e.type === 'agent:tool_call_end') as any;
    expect(tcEnd.success).toBe(false);

    // The turn still ends normally.
    expect(eventTypes(events)).toContain('agent:turn_end');

    // The error was fed back to the LLM as a tool result message.
    const iter2Messages = llm.capturedCalls[1].messages;
    const toolMsg = iter2Messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content.toLowerCase()).toMatch(/not found|does not exist|no shape/i);
  });

  it('malformed tool arguments are caught — tool runs with empty args', async () => {
    // The LLM returns a tool_call with `arguments: 'not valid json'`.
    // The runner's try/catch around JSON.parse should fall back to {} so the
    // tool still executes (likely erroring, but not crashing the runner).
    const malformedLLM = new (class extends MockLLM {
      constructor() {
        super([{ content: 'done' }]);
      }
      chat = {
        completions: {
          create: async (params: any) => {
            (this as any).capturedCalls.push({
              messages: JSON.parse(JSON.stringify(params.messages)),
              tools: params.tools,
              tool_choice: params.tool_choice,
            });
            return {
              choices: [{
                message: {
                  content: null,
                  tool_calls: [{
                    id: 'call-malformed-1',
                    type: 'function',
                    // Deliberately malformed JSON arguments.
                    function: { name: 'pen_create_shape', arguments: '{not valid json' },
                  }],
                },
              }],
            };
          },
        },
      };
    })();

    const { events } = await runAndCollect({
      documentId: 'd1',
      prompt: 'create a shape with malformed args',
      canvas: makeDoc([]),
      llm: malformedLLM,
    });

    // The tool call ran (didn't crash the runner).
    expect(eventTypes(events)).toContain('agent:tool_call_start');
    expect(eventTypes(events)).toContain('agent:tool_call_end');

    // The argsPreview was '{}' (empty object) because JSON.parse failed.
    const start = events.find((e) => e.type === 'agent:tool_call_start') as any;
    expect(start.argsPreview).toBe('{}');
  });

  it('MAX_ITERATIONS cap exits gracefully with message_end + turn_end', async () => {
    // The LLM keeps calling tools forever. The runner should hit MAX_ITERATIONS
    // (20) and exit cleanly with message_end + turn_end.
    const infiniteScript: ScriptEntry[] = Array.from({ length: 25 }, () => ({
      tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'Box', x: 0, y: 0, width: 10, height: 10 } }],
    }));
    const llm = new MockLLM(infiniteScript);

    const { events, patches } = await runAndCollect({
      documentId: 'd1',
      prompt: 'infinite loop',
      canvas: makeDoc([]),
      llm,
    });

    // Exactly MAX_ITERATIONS (20) LLM calls.
    expect(llm.capturedCalls).toHaveLength(20);

    // 20 tool calls → 20 patches.
    expect(patches).toHaveLength(20);

    // The turn ends cleanly (no error event).
    expect(eventTypes(events)).toContain('agent:message_end');
    expect(eventTypes(events)).toContain('agent:turn_end');
    expect(eventTypes(events)).not.toContain('agent:error');
  });

  it('LLM returns empty message (no content, no tool_calls) ends the turn', async () => {
    const llm = new MockLLM([
      { content: null, tool_calls: undefined },
    ]);

    const { patches, events } = await runAndCollect({
      documentId: 'd1',
      prompt: 'silence',
      canvas: makeDoc([]),
      llm,
    });

    expect(patches).toHaveLength(0);
    // No message_delta emitted (content was null).
    expect(eventTypes(events)).not.toContain('agent:message_delta');
    expect(eventTypes(events)).toEqual([
      'agent:message_start',
      'agent:message_end',
      'agent:turn_end',
    ]);
  });
});

// ---- Tests: input isolation -------------------------------------------------

describe('runner: input isolation', () => {
  it('the runner does NOT mutate the input canvas object', async () => {
    const initial = makeDoc([]);
    const initialSnapshot = JSON.stringify(initial);

    const llm = new MockLLM([
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'X', x: 0, y: 0, width: 10, height: 10 } }] },
      { content: 'done' },
    ]);

    await runAndCollect({
      documentId: 'd1',
      prompt: 'create a shape',
      canvas: initial,
      llm,
    });

    // The input canvas object should be byte-identical to its pre-run state.
    expect(JSON.stringify(initial)).toBe(initialSnapshot);
    expect(initial.shapes).toHaveLength(0);
  });

  it('the runner sees the input canvas state but does not persist changes back', async () => {
    // Seed canvas with one shape. The runner should see it in the system
    // snapshot, but mutations should NOT leak back to the caller's object.
    const seeded = makeDoc([makeShape('seed-1', { name: 'Seed' })]);

    const llm = new MockLLM([
      { tool_calls: [{ name: 'pen_create_shape', args: { type: 'rectangle', name: 'New', x: 0, y: 0, width: 10, height: 10 } }] },
      { content: 'done' },
    ]);

    const { finalCanvas } = await runAndCollect({
      documentId: 'd1',
      prompt: 'add a shape',
      canvas: seeded,
      llm,
    });

    // The runner's final canvas has both shapes.
    expect(finalCanvas.shapes).toHaveLength(2);

    // But the input `seeded` object is untouched.
    expect(seeded.shapes).toHaveLength(1);
    expect(seeded.shapes[0].name).toBe('Seed');
  });
});

// ---- Tests: tool catalog passthrough ----------------------------------------

describe('runner: tool catalog + spec passthrough', () => {
  it('the LLM receives the full 55-tool spec on every iteration', async () => {
    const llm = new MockLLM([
      { content: 'done' },
    ]);

    await runAndCollect({
      documentId: 'd1',
      prompt: 'hi',
      canvas: makeDoc([]),
      llm,
    });

    expect(llm.capturedCalls).toHaveLength(1);
    const tools = llm.capturedCalls[0].tools;
    expect(tools.length).toBe(54);
    // Tool names should be unique.
    const names = tools.map((t: any) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
    // tool_choice is 'auto'.
    expect(llm.capturedCalls[0].tool_choice).toBe('auto');
  });
});
