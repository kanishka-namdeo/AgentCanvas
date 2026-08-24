// /home/z/my-project/scripts/vlm-critique-after.js
// Task 7-d: Run VLM critique on the after screenshot using the SAME prompt as Task 7-a baseline.
// Uses the z-ai-web-dev-sdk with createChatCompletionVision (the underlying call the CLI wraps),
// with a longer per-call timeout to dodge "context deadline exceeded" errors.
//
// Usage: node scripts/vlm-critique-after.js
// Output: /home/z/my-project/download/vaultly-after-critique.json
import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
let ZAI;
try {
  ZAI = require('z-ai-web-dev-sdk').default;
} catch (e) {
  console.error('z-ai-web-dev-sdk not found, trying alternative import:', e.message);
  ZAI = require('z-ai-web-dev-sdk');
}

const IMG_PATH = '/home/z/my-project/download/vaultly-after2.png';
const PROMPT_PATH = '/home/z/my-project/scripts/vlm-critique-prompt.txt';
const OUT_PATH = '/home/z/my-project/download/vaultly-after2-critique.json';

const promptText = readFileSync(PROMPT_PATH, 'utf-8');
const imgBuf = readFileSync(IMG_PATH);
const imgB64 = imgBuf.toString('base64');
const dataUrl = `data:image/png;base64,${imgB64}`;

async function tryOnce(attempt) {
  console.log(`[vlm-after] attempt ${attempt}: ZAI.create() ...`);
  const zai = await ZAI.create();
  console.log(`[vlm-after] attempt ${attempt}: calling chat.completions.createVision ...`);
  const response = await zai.chat.completions.createVision({
    model: 'glm-4v-flash',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  return response;
}

async function main() {
  const MAX = 6;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const r = await tryOnce(attempt);
      writeFileSync(OUT_PATH, JSON.stringify(r, null, 2));
      console.log(`[vlm-after] attempt ${attempt}: SUCCESS → ${OUT_PATH}`);
      console.log(`[vlm-after] response model: ${r?.model || 'unknown'}`);
      const content = r?.choices?.[0]?.message?.content;
      console.log(`[vlm-after] content length: ${typeof content === 'string' ? content.length : Array.isArray(content) ? content.length : '?'}`);
      return;
    } catch (e) {
      console.error(`[vlm-after] attempt ${attempt} FAILED: ${e?.message || e}`);
      if (attempt < MAX) {
        const backoff = 30000 * attempt; // 30s, 60s, 90s, 120s, 150s
        console.log(`[vlm-after] backing off ${backoff / 1000}s before retry ...`);
        await sleep(backoff);
      }
    }
  }
  console.error(`[vlm-after] all ${MAX} attempts failed; no output written`);
  process.exit(1);
}

main().catch((e) => {
  console.error('[vlm-after] fatal:', e);
  process.exit(2);
});
