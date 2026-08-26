// Lightweight z.ai sandbox health probe — ONE chat completion (no tools).
// Usage: bun scripts/zai-sandbox-probe.ts
const { createRequire } = await import('module');
const require = createRequire(import.meta.url);
const mod = require('z-ai-web-dev-sdk');
const ZAI = mod.default ?? mod;

async function main() {
  console.log('[probe] ZAI.create() ...');
  const zai = await ZAI.create();
  console.log('[probe] calling chat.completions.create (glm-5.3? use default) ...');
  const t0 = Date.now();
  try {
    const r = await zai.chat.completions.create({
      // note: default model when omitted; the runner uses glm-5.3 via pi-ai
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const content = r?.choices?.[0]?.message?.content;
    console.log(`[probe] ${dt}s | model=${r?.model} | content=${JSON.stringify(content)}`);
    if (!content || content.trim() === '') {
      console.log('[probe] EMPTY RESPONSE — provider rate-limited or unavailable');
      process.exit(1);
    }
    console.log('[probe] HEALTHY');
    process.exit(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[probe] ERROR after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${msg}`);
    process.exit(2);
  }
}
main();
