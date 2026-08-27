// probe-endpoints.ts — quick health probe of the two LLM endpoints.
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('/etc/.z-ai-config', 'utf8'));

async function probe(label: string, baseUrl: string, model: string, headers: Record<string, string>, withTools = false) {
  try {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: 'Reply with just: ok' }],
      max_tokens: 20,
    };
    if (withTools) {
      body.tools = [
        {
          type: 'function',
          function: {
            name: 'echo_test',
            description: 'Echo a message back.',
            parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
          },
        },
      ];
    }
    const res = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    let content = '';
    let toolCalls = 0;
    try {
      const j = JSON.parse(text);
      content = j.choices?.[0]?.message?.content ?? '';
      toolCalls = j.choices?.[0]?.message?.tool_calls?.length ?? 0;
    } catch { /* keep raw */ }
    console.log(`${label}${withTools ? ' (tools)' : ''}: HTTP ${res.status} · content="${String(content).slice(0, 40)}" · toolCalls=${toolCalls}`);
  } catch (e) {
    console.log(`${label}${withTools ? ' (tools)' : ''}: ERROR ${(e as Error).message.slice(0, 100)}`);
  }
}

// 1. Primary (kimi via pinggy)
await probe('kimi-primary', 'https://irhnglwoxe.a.pinggy.link/v1', 'kimi-k2-5', { Authorization: 'Bearer 123456' });
await probe('kimi-primary', 'https://irhnglwoxe.a.pinggy.link/v1', 'kimi-k2-5', { Authorization: 'Bearer 123456' }, true);

// 2. z.ai sandbox (glm-5.3) — same auth shape llm-bisect3 used
const zaiHeaders = {
  Authorization: `Bearer ${cfg.apiKey ?? 'Z.ai'}`,
  ...(cfg.token ? { 'X-Token': cfg.token, 'X-User-Id': cfg.userId ?? '', 'X-Chat-Id': cfg.chatId ?? '', 'X-Z-AI-From': 'Z' } : {}),
};
await probe('zai-sandbox', cfg.baseUrl, 'glm-5.3', zaiHeaders);
await probe('zai-sandbox', cfg.baseUrl, 'glm-5.3', zaiHeaders, true);
