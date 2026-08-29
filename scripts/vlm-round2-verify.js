// /home/z/my-project/scripts/vlm-round2-verify.js
// Round-2 verification: run VLM critique on a screenshot with a targeted prompt.
// Usage: node scripts/vlm-round2-verify.js <image-path> <prompt-file> <out-json>
import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let ZAI;
try { ZAI = require('z-ai-web-dev-sdk').default; } catch { ZAI = require('z-ai-web-dev-sdk'); }

const [imgPath, promptPath, outPath] = process.argv.slice(2);
const promptText = readFileSync(promptPath, 'utf-8');
const imgB64 = readFileSync(imgPath).toString('base64');

async function main() {
  const zai = await ZAI.create();
  const r = await zai.chat.completions.createVision({
    model: 'glm-4v-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgB64}` } },
      ],
    }],
  });
  writeFileSync(outPath, JSON.stringify(r, null, 2));
  console.log(`=== VLM ANALYSIS: ${imgPath} ===`);
  console.log(r?.choices?.[0]?.message?.content || '(no content)');
}

main().catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1); });
