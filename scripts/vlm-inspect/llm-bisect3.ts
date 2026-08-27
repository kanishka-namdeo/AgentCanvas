// llm-bisect3.ts — replay the app's REAL tool catalog against the sandbox
// endpoint. Builds the actual tools via createCanvasTools (same factory the
// runner uses), converts to OpenAI spec, then:
//   1. sends the full catalog (streaming, like pi-ai does)
//   2. bisects to find the offending tool(s) if it fails
//
// Usage: bun scripts/vlm-inspect/llm-bisect3.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { createCanvasTools, toolsToOpenAISpec } from '../../src/lib/agent/tools';
import type { CanvasToolContext } from '../../src/lib/agent/tools';
import { createEmptyCanvasDocument } from '../../src/lib/canvas/types';

const cfg = JSON.parse(readFileSync('/etc/.z-ai-config', 'utf8'));

const doc = createEmptyCanvasDocument('bisect', 'Bisect');
const ctx: CanvasToolContext = {
  getShapes: () => doc.shapes,
  getTokens: () => doc.tokens,
  getDocument: () => doc,
  applyPatch: (p: unknown) => p,
} as unknown as CanvasToolContext;

const tools = createCanvasTools(ctx);
const specs = toolsToOpenAISpec(tools);
console.log(`tool count: ${specs.length}`);
writeFileSync('/home/z/my-project/scripts/vlm-inspect/real-tools.json', JSON.stringify(specs, null, 2));
const bytes = JSON.stringify(specs).length;
console.log(`spec bytes: ${(bytes / 1024).toFixed(1)}KB`);

const SYSTEM = 'You are an AI design agent operating a Figma-aligned canvas. Create what the user asks using the tools.';
const USER = 'Create a landing page hero section with a headline and two buttons.';

async function streamCall(label: string, tools: unknown[]): Promise<{ ok: boolean; contentChars: number; toolCallChunks: number }> {
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
          { role: 'system', content: SYSTEM },
          { role: 'user', content: USER },
        ],
        tools,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) {
      console.log(`${label}: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
      return { ok: false, contentChars: 0, toolCallChunks: 0 };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let contentChars = 0;
    let toolCallChunks = 0;
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
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0];
          if (d?.delta?.content) contentChars += d.delta.content.length;
          if (d?.delta?.tool_calls) toolCallChunks++;
        } catch { /* keep */ }
      }
    }
    const ok = contentChars > 0 || toolCallChunks > 0;
    console.log(`${label}: ${ok ? 'OK' : 'EMPTY'} · contentChars=${contentChars} · toolCallChunks=${toolCallChunks}`);
    return { ok, contentChars, toolCallChunks };
  } catch (e) {
    console.log(`${label}: ERROR ${(e as Error).message.slice(0, 150)}`);
    return { ok: false, contentChars: 0, toolCallChunks: 0 };
  }
}

// 1) Full catalog.
const full = await streamCall('full catalog', specs as unknown as unknown[]);
if (full.ok) {
  console.log('\nFull catalog works — the failure is elsewhere (pi-ai request shape, not the tools).');
  process.exit(0);
}

// 2) Bisect: find the smallest failing prefix/suffix subsets.
console.log('\nBisecting…');
let lo = 0;
let hi = specs.length;
// First: does an empty tools array work?
await streamCall('no tools', []);
while (hi - lo > 1) {
  const mid = Math.floor((lo + hi) / 2);
  const r = await streamCall(`tools[0..${mid})`, specs.slice(0, mid) as unknown as unknown[]);
  if (r.ok) lo = mid; else hi = mid;
}
console.log(`\nFirst failing prefix boundary at index ${lo} (tools[0..${lo}) ok, tools[0..${hi}) fails)`);
console.log(`Suspect tool: ${JSON.stringify(specs[lo]?.function?.name)}`);
// Confirm: full set minus the suspect
const suspect = specs[lo];
const rest = specs.filter((t: any) => t?.function?.name !== suspect?.function?.name);
await streamCall(`all minus ${suspect?.function?.name}`, rest as unknown as unknown[]);
await streamCall(`suspect alone`, [suspect] as unknown as unknown[]);
