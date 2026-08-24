// probe-zai-endpoint.ts — Discover the LLM model + endpoint the z.ai sandbox
// actually serves, so we can pin the app's default LLM settings to reality.
//
// Probes:
//  1. ZAI.create() config — baseUrl + credential shape (OAuth token vs API key)
//  2. Direct chat completion via the z-ai-web-dev-sdk with candidate models
//  3. pi-ai ModelRuntime zai catalog (what the native runner can select)
// Run: bun run scripts/probe-zai-endpoint.ts

import ZAI from 'z-ai-web-dev-sdk';

async function main() {
  // ---- 1. ZAI config ----
  const zai = await ZAI.create();
  const cfg = (zai as unknown as { config: Record<string, unknown> }).config;
  const safe = { ...cfg } as Record<string, unknown>;
  // Mask secrets — print shapes, not values.
  for (const k of Object.keys(safe)) {
    const v = safe[k];
    if (typeof v === 'string' && v.length > 12) safe[k] = `${v.slice(0, 6)}…(${v.length} chars)`;
  }
  console.log('[1] ZAI.create() config:', JSON.stringify(safe, null, 2));

  // ---- 2. Direct completion with candidate models ----
  const candidates = ['glm-4.6', 'glm-4.7', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash'];
  for (const model of candidates) {
    try {
      const res = (await zai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 16,
        temperature: 0,
      })) as { choices?: Array<{ message?: { content?: string } }> };
      const text = res.choices?.[0]?.message?.content?.trim().slice(0, 60);
      console.log(`[2] model=${model} -> OK: "${text}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[2] model=${model} -> FAIL: ${msg.slice(0, 160)}`);
    }
  }

  // ---- 3. pi-ai zai catalog (what the native runner sees) ----
  try {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const rt = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    const models = rt.getModels('zai');
    console.log(
      '[3] pi-ai zai catalog:',
      models.map((m) => `${m.id} (maxTokens=${m.maxTokens})`).join(', '),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[3] pi-ai catalog probe failed:', msg.slice(0, 160));
  }
}

main().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(1);
});
