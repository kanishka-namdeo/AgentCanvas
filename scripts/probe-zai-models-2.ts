// probe-zai-models-2.ts — Second-pass probe: glm-5.x availability + function
// calling through the z.ai sandbox endpoint (spaced to dodge 429s).
// Run: bun run scripts/probe-zai-models-2.ts

import ZAI from 'z-ai-web-dev-sdk';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const zai = await ZAI.create();

  // ---- 1. glm-5.x availability (spaced 3s) ----
  for (const model of ['glm-5.3', 'glm-5.2', 'glm-5-turbo']) {
    try {
      const res = (await zai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 16,
        temperature: 0,
      })) as { choices?: Array<{ message?: { content?: string } }> };
      console.log(`[1] ${model} -> OK: "${res.choices?.[0]?.message?.content?.trim().slice(0, 40)}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[1] ${model} -> FAIL: ${msg.slice(0, 140)}`);
    }
    await sleep(3000);
  }

  // ---- 2. Function calling with the two candidates that matter ----
  const tools = [
    {
      type: 'function',
      function: {
        name: 'create_rect',
        description: 'Create a rectangle on the canvas',
        parameters: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
      },
    },
  ];
  for (const model of ['glm-4.7', 'glm-5.3']) {
    try {
      const res = (await zai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Create a rectangle at x=10 y=20. Use the tool.' }],
        tools,
        tool_choice: 'auto',
        max_tokens: 200,
        temperature: 0,
      })) as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string } }> } }> };
      const call = res.choices?.[0]?.message?.tool_calls?.[0]?.function?.name;
      console.log(`[2] ${model} -> tool_call: ${call ?? '(none)'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[2] ${model} -> FAIL: ${msg.slice(0, 140)}`);
    }
    await sleep(3000);
  }
}

main().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(1);
});
