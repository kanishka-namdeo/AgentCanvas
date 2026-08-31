// probe-vlm-quota.ts — check VLM availability for the deferred prompt-tuning critique.
//
// 1. z.ai sandbox VISION quota (the endpoint that HTTP-429'd for >4h on 2026-08-31):
//    one createVision call with a tiny 64x64 image, thinking disabled.
// 2. kimi-k2-5 custom endpoint (pinggy tunnel): GET /models + one chat call with an
//    image_url content part, to learn whether it can serve as the VLM fallback.
//
// Usage: bun scripts/vlm-inspect/probe-vlm-quota.ts
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const mod = require('z-ai-web-dev-sdk');
const ZAI = mod.default ?? mod;

const TINY = '/home/z/my-project/scripts/vlm-inspect/tiny-probe.png';
const KIMI_BASE = 'https://irhnglwoxe.a.pinggy.link/v1';
const KIMI_KEY = '123456';
const KIMI_MODEL = 'kimi-k2-5';

const dataUrl = `data:image/png;base64,${readFileSync(TINY).toString('base64')}`;

async function probeZaiVision() {
  const t0 = Date.now();
  try {
    const zai = await ZAI.create();
    const r = await (zai as any).chat.completions.createVision({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Health probe. Reply with exactly: OK' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      thinking: { type: 'disabled' },
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const content = r?.choices?.[0]?.message?.content ?? '';
    const usage = r?.usage ? ` · usage=${JSON.stringify(r.usage)}` : '';
    console.log(`[zai-vision] ${dt}s · model=${r?.model ?? '(default)'} · content=${JSON.stringify(String(content).slice(0, 60))}${usage}`);
    if (typeof content === 'string' && content.trim()) {
      console.log('[zai-vision] QUOTA OK — usable as VLM');
      return true;
    }
    console.log('[zai-vision] EMPTY response — likely still throttled');
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[zai-vision] ERROR after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${msg.slice(0, 300)}`);
    if (/429|too many/i.test(msg)) console.log('[zai-vision] still 429 quota-blocked');
    return false;
  }
}

async function probeKimi() {
  // models list (best-effort)
  try {
    const res = await fetch(`${KIMI_BASE}/models`, {
      headers: { Authorization: `Bearer ${KIMI_KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let ids: string[] = [];
    try {
      const j = JSON.parse(text);
      ids = (j.data ?? []).map((m: any) => m.id).filter(Boolean);
    } catch { /* raw */ }
    console.log(`[kimi] GET /models → HTTP ${res.status} · ${ids.length ? ids.join(', ') : text.slice(0, 200)}`);
  } catch (e) {
    console.log(`[kimi] GET /models → ERROR ${(e as Error).message.slice(0, 120)}`);
  }

  // text sanity
  try {
    const t0 = Date.now();
    const res = await fetch(`${KIMI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${KIMI_KEY}` },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let content = '';
    try { content = JSON.parse(text).choices?.[0]?.message?.content ?? ''; } catch { /* raw */ }
    console.log(`[kimi] text call → HTTP ${res.status} (${((Date.now() - t0) / 1000).toFixed(1)}s) · content=${JSON.stringify(String(content).slice(0, 40))}`);
  } catch (e) {
    console.log(`[kimi] text call → ERROR ${(e as Error).message.slice(0, 120)}`);
  }

  // image call — the decisive test
  try {
    const t0 = Date.now();
    const res = await fetch(`${KIMI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${KIMI_KEY}` },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is the dominant color of this image? One word.' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 32,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let content = '';
    try { content = JSON.parse(text).choices?.[0]?.message?.content ?? ''; } catch { /* raw */ }
    console.log(`[kimi] IMAGE call → HTTP ${res.status} (${((Date.now() - t0) / 1000).toFixed(1)}s) · content=${JSON.stringify(String(content).slice(0, 80))}`);
    if (res.ok && String(content).trim()) {
      console.log('[kimi] VISION-CAPABLE — usable as VLM fallback');
      return true;
    }
    console.log(`[kimi] image call rejected — ${res.ok ? 'empty content' : text.slice(0, 300)}`);
    return false;
  } catch (e) {
    console.log(`[kimi] IMAGE call → ERROR ${(e as Error).message.slice(0, 160)}`);
    return false;
  }
}

const zaiOk = await probeZaiVision();
const kimiOk = await probeKimi();
console.log(`\nVERDICT: zai-vision=${zaiOk ? 'OK' : 'BLOCKED'} · kimi-vision=${kimiOk ? 'OK' : 'NO'}`);
