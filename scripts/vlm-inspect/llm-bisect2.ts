// llm-bisect2.ts — streaming variant. The app's pi-ai runtime streams SSE;
// test whether the sandbox endpoint's STREAMING path breaks with tools.
//
// Usage: bun scripts/vlm-inspect/llm-bisect2.ts

import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('/etc/.z-ai-config', 'utf8'));

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
      },
      required: ['nodeId'],
    },
  },
});

async function streamCall(label: string, tools: unknown[], extra: Record<string, unknown> = {}) {
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey ?? 'Z.ai'}`,
        ...(cfg.token ? { 'X-Token': cfg.token, 'X-User-Id': cfg.userId ?? '', 'X-Chat-Id': cfg.chatId ?? '', 'X-Z-AI-From': 'Z' } : {}),
      },
      body: JSON.stringify({
        model: 'glm-5.3',
        stream: true,
        messages: [
          { role: 'system', content: bigSystem },
          { role: 'user', content: 'Create a landing page hero section with a headline and two buttons.' },
        ],
        tools,
        ...extra,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) {
      console.log(`${label}: HTTP ${res.status} ${res.statusText}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let contentChars = 0;
    let toolCallChunks = 0;
    let finish = '';
    let chunkCount = 0;
    let firstChunkMs = -1;
    const t0 = Date.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        chunkCount++;
        if (firstChunkMs < 0) firstChunkMs = Date.now() - t0;
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0];
          if (d?.delta?.content) contentChars += d.delta.content.length;
          if (d?.delta?.tool_calls) toolCallChunks++;
          if (d?.finish_reason) finish = d.finish_reason;
        } catch { /* keep scanning */ }
      }
    }
    console.log(`${label}: HTTP 200 · chunks=${chunkCount} · firstChunk=${firstChunkMs}ms · contentChars=${contentChars} · toolCallChunks=${toolCallChunks} · finish=${finish} · total=${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`${label}: ERROR ${(e as Error).message.slice(0, 150)}`);
  }
}

await streamCall('s1) stream + 10 tools', Array.from({ length: 10 }, (_, i) => mkTool(i)));
await streamCall('s2) stream + 107 tools', Array.from({ length: 107 }, (_, i) => mkTool(i)));
await streamCall('s3) stream + 107 tools + parallel_tool_calls=false', Array.from({ length: 107 }, (_, i) => mkTool(i)), { parallel_tool_calls: false });
