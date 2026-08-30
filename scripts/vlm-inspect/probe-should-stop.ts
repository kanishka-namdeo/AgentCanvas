// Empirical verification: does post-construction assignment of
// `shouldStopAfterTurn` on the pi-agent-core Agent actually bound the loop?
// Uses a fake streamFn (no network) that always emits one tool call per turn.
import { Agent } from '@earendil-works/pi-agent-core';

// The loop consumes an AssistantMessageEventStream: async-iterable events
// ('start' → partial, 'toolcall_*' → partial, 'done') plus a result() method.
function fakeStream(toolCallId: string) {
  const finalMessage: any = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolCallId, name: 'pen_probe_tool', arguments: {} }],
    stopReason: 'stop',
  };
  const events = [
    { type: 'start', partial: { role: 'assistant', content: [], stopReason: null } },
    { type: 'toolcall_start', partial: finalMessage },
    { type: 'done' },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    async result() {
      return finalMessage;
    },
  };
}

const tool = {
  name: 'pen_probe_tool',
  label: 'Probe',
  parameters: { type: 'object', properties: {} },
  async execute() {
    return { content: [{ type: 'text', text: 'ok' }] };
  },
};

let callCounter = 0;
const agent = new (Agent as any)({
  initialState: {
    systemPrompt: 'probe',
    model: {
      id: 'fake', name: 'fake', api: 'openai-completions', provider: 'x',
      baseUrl: 'http://x', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000, maxTokens: 4096,
    },
    thinkingLevel: 'off',
    tools: [tool],
  },
  streamFn: async () => fakeStream(`call-${++callCounter}`),
} as any);

// ---- The exact probe + hook the runner uses --------------------------------
let hookWired = false;
try {
  const target = agent as any;
  if (target && typeof target === 'object' && 'shouldStopAfterTurn' in target) {
    let toolCallBudget = 5;
    target.shouldStopAfterTurn = (turnCtx: any) => {
      const calls = turnCtx?.message?.content?.filter?.((c: any) => c?.type === 'toolCall') ?? [];
      toolCallBudget -= calls.length;
      console.log(`  hook fired: ${calls.length} call(s) this turn, budget now ${toolCallBudget}`);
      return toolCallBudget <= 0;
    };
    hookWired = true;
  }
} catch {}
console.log('hook wired:', hookWired);

// One prompt() run: the fake stream ALWAYS wants another tool call, so without
// the hook the loop runs until some internal cap (or forever).
await agent.prompt([{ role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: Date.now() }]);

// Count tool executions from the assistant messages in state.
const msgs = agent.state?.messages ?? [];
let assistantMsgs = 0;
let toolCalls = 0;
for (const m of msgs) {
  if (m.role === 'assistant') {
    assistantMsgs += 1;
    toolCalls += (m.content ?? []).filter((c: any) => c.type === 'toolCall').length;
  }
}
console.log(`assistant messages: ${assistantMsgs}, tool calls: ${toolCalls}`);
console.log(
  toolCalls <= 5
    ? `PASS: budget (${5}) bounded the loop — ${toolCalls} calls executed`
    : `FAIL: budget (${5}) did NOT bound the loop — ${toolCalls} calls executed`,
);
