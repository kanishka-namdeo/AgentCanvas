// Measure the token cost of the pi agent's tool registry + system prompt.
//
// Estimates tokens as chars/4 (industry-standard heuristic for English text).
// The real cost is higher because JSON schemas have more punctuation, but this
// gives a ballpark for the "every LLM call pays this" overhead.

import { createCanvasTools, toolsToOpenAISpec, type CanvasToolContext } from '../src/lib/agent/tools.ts';
import { createPenTools } from '../src/lib/agent/pen-tools';
import { readFileSync } from 'node:fs';

async function main() {
  const ctx: CanvasToolContext = {
    getShapes: () => [],
    getTokens: () => ({ colors: [], textStyles: [] }),
    getDocument: () => ({
      id: 'x', name: 'x', version: '2.17',
      children: [], variables: undefined, themes: undefined,
      background: '#fff',
      viewport: { zoom: 1, panX: 0, panY: 0 },
      shapes: [], tokens: { colors: [], textStyles: [] },
    } as any),
    applyPatch: () => ({ op: 'noop' }),
  };

  const tools = [...createCanvasTools(ctx), ...createPenTools(ctx)] as ReturnType<typeof createCanvasTools>;
  const specs = toolsToOpenAISpec(tools);

  console.log(`Tool count: ${specs.length}`);
  console.log('');

  const specsJson = JSON.stringify(specs);
  console.log(`Tool specs JSON size: ${specsJson.length.toLocaleString()} chars`);
  console.log(`Tool specs est. tokens: ~${Math.round(specsJson.length / 4).toLocaleString()}`);
  console.log('');

  // Per-tool breakdown, sorted by token cost (biggest first)
  console.log('Per-tool definition sizes (est tokens):');
  const sizes = specs.map((s: any) => ({
    name: s.function.name,
    chars: JSON.stringify(s).length,
    tokens: Math.round(JSON.stringify(s).length / 4),
  })).sort((a, b) => b.tokens - a.tokens);

  sizes.forEach((s: any) => {
    console.log(`  ${s.tokens.toString().padStart(5)} tok  ${s.name}`);
  });

  const totalChars = sizes.reduce((a: number, s: any) => a + s.chars, 0);
  const totalTokens = sizes.reduce((a: number, s: any) => a + s.tokens, 0);
  console.log('');
  console.log(`TOTAL tool definitions: ${totalChars.toLocaleString()} chars → ~${totalTokens.toLocaleString()} tokens`);
  console.log(`Average per tool: ${Math.round(totalTokens / specs.length)} tokens`);

  // System prompt
  const runnerSrc = readFileSync('./src/lib/agent/runner.ts', 'utf-8');
  const promptMatch = runnerSrc.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
  if (promptMatch) {
    const prompt = promptMatch[1];
    const promptTokens = Math.round(prompt.length / 4);
    console.log('');
    console.log(`System prompt size: ${prompt.length.toLocaleString()} chars → ~${promptTokens.toLocaleString()} tokens`);
    console.log(`Combined (system prompt + tool specs): ~${(promptTokens + totalTokens).toLocaleString()} tokens`);
    console.log('');
    console.log(`This is paid on EVERY LLM iteration (up to 20 iterations/turn).`);
    console.log(`A 10-iteration turn pays: ~${(10 * (promptTokens + totalTokens)).toLocaleString()} tokens just for definitions.`);
  }

  // Category analysis — group by prefix
  console.log('');
  console.log('Tools grouped by category prefix:');
  const categories: Record<string, number> = {};
  sizes.forEach((s: any) => {
    const prefix = s.name.split('_').slice(0, 2).join('_');
    // All tools now use the `pen_` prefix (renamed from `canvas_`).
    const cat = s.name.split('_')[1] + '_tools';
    categories[cat] = (categories[cat] || 0) + 1;
  });
  Object.entries(categories).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
    console.log(`  ${count.toString().padStart(3)}  ${cat}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
