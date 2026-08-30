// Probe: does the primary kimi endpoint tolerate OpenAI cache hint fields
// (prompt_cache_key / prompt_cache_retention) in the chat-completions body?
// Decides whether pi-ai's supportsLongCacheRetention compat flag is safe.
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('/etc/.z-ai-config', 'utf-8'));

const kimiBase = 'https://irhnglwoxe.a.pinggy.link/v1';

async function probe(base: string, key: string, label: string) {
  const body = {
    model: label === 'kimi' ? 'kimi-k2-5' : (cfg.model ?? 'glm-5.3'),
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    max_tokens: 8,
    stream: false,
    prompt_cache_key: 'agentcanvas-probe-1',
    prompt_cache_retention: '24h',
  };
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    console.log(`[${label}] status=${res.status} body[0..200]=${text.slice(0, 200)}`);
  } catch (e: any) {
    console.log(`[${label}] ERROR ${e?.message ?? e}`);
  }
}

await probe(kimiBase, '123456', 'kimi');
// zai sandbox (fallback model) — same probe
await probe(`${cfg.baseUrl.replace(/\/$/, '')}`, cfg.apiKey, 'zai');
