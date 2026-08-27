// llm-bisect.ts — diagnose why glm-5.3 returns empty responses for the agent's
// full payload. Tests increasingly realistic requests against the sandbox
// endpoint: (a) tiny prompt, (b) big system prompt, (c) big prompt + N tools,
// (d) big prompt + tools with strict schemas.
//
// Usage: bun scripts/vlm-inspect/llm-bisect.ts

import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('/etc/.z-ai-config', 'utf8'));

async function call(label: string, body: Record<string, unknown>) {
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey ?? 'Z.ai'}`,
        ...(cfg.token ? { 'X-Token': cfg.token, 'X-User-Id': cfg.userId ?? '', 'X-Chat-Id': cfg.chatId ?? '', 'X-Z-AI-From': 'Z' } : {}),
      },
      body: JSON.stringify({ model: 'glm-5.3', stream: false, ...body }),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let content = '';
    let finish = '';
    try {
      const j = JSON.parse(text);
      content = j.choices?.[0]?.message?.content ?? '';
      finish = j.choices?.[0]?.finish_reason ?? '';
      if (j.error) content = `[error: ${JSON.stringify(j.error).slice(0, 200)}]`;
    } catch { content = `[non-JSON: ${text.slice(0, 150)}]`; }
    console.log(`${label}: HTTP ${res.status} · finish=${finish} · content[0..100]=${JSON.stringify(String(content).slice(0, 100))}`);
  } catch (e) {
    console.log(`${label}: FETCH ERROR ${(e as Error).message.slice(0, 120)}`);
  }
}

// A realistic ~30KB system prompt (the app's is roughly this size).
const bigSystem = ('You are an AI design agent operating a Figma-aligned canvas. ' +
  'SECTION: ' + 'x'.repeat(30000) + ' Use the tools to create the design.').slice(0, 30000);

const mkTool = (i: number) => ({
  type: 'function',
  function: {
    name: `pen_tool_${i}`,
    description: `Tool number ${i} that does something useful with parameters and returns a result. `.repeat(3),
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The target node id' },
        x: { type: 'number' }, y: { type: 'number' },
        width: { type: 'number' }, height: { type: 'number' },
        fill: { type: 'string', description: 'A fill color like #ffffff' },
        shadow: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, blur: { type: 'number' }, color: { type: 'string' } } },
      },
      required: ['nodeId'],
    },
  },
});

const user = { role: 'user', content: 'Create a landing page hero section with a headline and two buttons.' };

await call('a) tiny', { messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 16 });
await call('b) 30KB system, no tools', { messages: [{ role: 'system', content: bigSystem }, user], max_tokens: 200 });
await call('c) + 10 tools', { messages: [{ role: 'system', content: bigSystem }, user], tools: Array.from({ length: 10 }, (_, i) => mkTool(i)), max_tokens: 200 });
await call('d) + 60 tools', { messages: [{ role: 'system', content: bigSystem }, user], tools: Array.from({ length: 60 }, (_, i) => mkTool(i)), max_tokens: 200 });
await call('e) + 107 tools', { messages: [{ role: 'system', content: bigSystem }, user], tools: Array.from({ length: 107 }, (_, i) => mkTool(i)), max_tokens: 200 });
await call('f) 107 tools, tool_choice required', { messages: [{ role: 'system', content: bigSystem }, user], tools: Array.from({ length: 107 }, (_, i) => mkTool(i)), tool_choice: 'auto', max_tokens: 200 });
