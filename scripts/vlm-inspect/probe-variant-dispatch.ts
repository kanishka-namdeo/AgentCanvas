// Dispatch-only probe (no raw single completion) — fits the 10-min bash cap.
const KIMI_BASE = 'https://irhnglwoxe.a.pinggy.link/v1';
const KIMI_KEY = '123456';

const llm = {
  chat: {
    completions: {
      create: async (req: any) => {
        const res = await fetch(`${KIMI_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${KIMI_KEY}` },
          body: JSON.stringify({ model: 'kimi-k2-5', ...req }),
          signal: AbortSignal.timeout(280_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return res.json();
      },
    },
  },
} as any;

async function main() {
  const { dispatchVariantGeneration } = await import('/home/z/my-project/src/lib/agent/subagents/variant-generator.ts');
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
    const spec = result.variants[result.judge.winnerIndex]?.spec as any;
    if (spec) console.log('winner spec root:', JSON.stringify({ type: spec.type, name: spec.name, children: spec.children?.length }));
  }
}

main();
