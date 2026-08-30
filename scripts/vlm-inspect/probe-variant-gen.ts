// Direct probe of dispatchVariantGeneration against the kimi endpoint —
// surfaces the REAL error behind "generation failed (...)".
// Usage: bun scripts/vlm-inspect/probe-variant-gen.ts

const KIMI_BASE = 'https://irhnglwoxe.a.pinggy.link/v1';
const KIMI_KEY = '123456';

// Minimal OpenAI-shaped client matching LLMClientLike.
const llm = {
  chat: {
    completions: {
      create: async (req: any) => {
        const res = await fetch(`${KIMI_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${KIMI_KEY}` },
          body: JSON.stringify({ model: 'kimi-k2-5', ...req }),
          signal: AbortSignal.timeout(300_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return res.json();
      },
    },
  },
} as any;

async function main() {
  const { dispatchVariantGeneration } = await import('/home/z/my-project/src/lib/agent/subagents/variant-generator.ts');

  // 1. Raw single completion first — is the endpoint + prompt OK?
  console.log('--- raw single spec generation probe ---');
  const t0 = Date.now();
  try {
    const { SPEC_SYSTEM_PROMPT } = await import('/home/z/my-project/src/lib/agent/subagents/variant-generator.ts') as any;
    const completion = await llm.chat.completions.create({
      model: 'kimi-k2-5',
      messages: [
        { role: 'system', content: SPEC_SYSTEM_PROMPT },
        { role: 'user', content: 'Design request:\nCreate a pricing page for our SaaS product.\n\nDesign direction for THIS variant (follow it decisively):\nAiry light theme, one restrained brand accent.\n\nReturn the JSON object now.' },
      ],
      temperature: 0.8,
    });
    const content = completion?.choices?.[0]?.message?.content ?? '';
    console.log(`raw probe: ${Date.now() - t0}ms, content length=${content.length}`);
    console.log('first 200 chars:', content.slice(0, 200));
    const { extractSpecJson } = await import('/home/z/my-project/src/lib/agent/subagents/variant-generator.ts');
    const spec = extractSpecJson(content);
    console.log('parsed spec?', spec ? `YES (${JSON.stringify(spec).length} chars)` : 'NO');
    if (!spec) console.log('FULL CONTENT:\n', content.slice(0, 3000));
  } catch (err: any) {
    console.log(`raw probe FAILED after ${Date.now() - t0}ms:`, String(err?.message ?? err).slice(0, 500));
  }

  // 2. Full dispatch (3 staggered-parallel, no render callback).
  console.log('\n--- full dispatchVariantGeneration ---');
  const t1 = Date.now();
  const result = await dispatchVariantGeneration({
    request: 'Create a pricing page for our SaaS product.',
    llm,
  });
  console.log(`dispatch: ${Date.now() - t1}ms, variants=${result.variants.length}, error=${result.error ?? 'none'}`);
  console.log('notes:', result.notes);
  if (result.judge) {
    console.log('judge:', JSON.stringify({ method: result.judge.method, winnerIndex: result.judge.winnerIndex, scores: result.judge.scores, reason: result.judge.reason }));
    console.log('winner direction:', result.variants[result.judge.winnerIndex]?.direction);
    console.log('winner nodeCount:', result.variants[result.judge.winnerIndex]?.nodeCount);
  }
}

main();
