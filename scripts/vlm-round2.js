// /home/z/my-project/scripts/vlm-round2.js
// Round-2 critical UI audit: run VLM critique on a screenshot with a per-image prompt.
// Usage: node scripts/vlm-round2.js <imagePath> <outJsonName> <promptFile>
import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
let ZAI;
try { ZAI = require('z-ai-web-dev-sdk').default; } catch (e) { ZAI = require('z-ai-web-dev-sdk'); }

const [imgPath, outName, promptPath] = process.argv.slice(2);
if (!imgPath || !outName || !promptPath) {
  console.error('usage: node vlm-round2.js <imagePath> <outJsonName> <promptFile>');
  process.exit(2);
}
const OUT = `/home/z/my-project/download/ui-audit/round2/${outName}`;
const promptText = readFileSync(promptPath, 'utf-8');
const imgB64 = readFileSync(imgPath).toString('base64');

async function attempt(model) {
  const zai = await ZAI.create();
  return zai.chat.completions.createVision({
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgB64}` } },
      ],
    }],
  });
}

async function main() {
  for (let i = 1; i <= 4; i++) {
    for (const model of ['glm-4v-flash', 'glm-5v-turbo']) {
      try {
        const r = await attempt(model);
        writeFileSync(OUT, JSON.stringify(r, null, 2));
        const content = r?.choices?.[0]?.message?.content || '';
        console.log(`=== VLM (${model}) → ${outName} ===`);
        console.log(content);
        return;
      } catch (e) {
        console.error(`[vlm-r2] ${model} attempt ${i} failed: ${e?.message || e}`);
      }
    }
    await sleep(15000 * i);
  }
  console.error('all attempts failed');
  process.exit(1);
}
main().catch((e) => { console.error('fatal:', e); process.exit(2); });
