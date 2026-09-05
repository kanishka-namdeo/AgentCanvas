// Design-consistency pass (2026-09-06) — VLM visual defect check on the
// E2E screenshots (light + dark). Same createRequire pattern as
// vlm-critique-after.js.
//
// Usage: node scripts/research/design-std/vlm-check.js
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let ZAI;
try {
  ZAI = require('z-ai-web-dev-sdk').default;
} catch (e) {
  ZAI = require('z-ai-web-dev-sdk');
}

const zai = await ZAI.create();
const shots = [
  ['download/design-verify-2026-09-06/01-light-canvas.png', 'LIGHT mode main canvas'],
  ['download/design-verify-2026-09-06/03-dark-canvas.png', 'DARK mode main canvas'],
  ['download/design-verify-2026-09-06/04-dark-shortcuts.png', 'DARK mode keyboard shortcuts dialog'],
  ['download/design-verify-2026-09-06/05-dark-settings.png', 'DARK mode settings dialog'],
];
for (const [path, desc] of shots) {
  try {
    const b64 = readFileSync(path).toString('base64');
    const res = await zai.chat.completions.createVision({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are auditing a design-tool web app (${desc}). Check: (1) any glaring visual defects — broken chips, unreadable text, misaligned controls, white boxes on a dark background; (2) do keyboard key chips (e.g. shortcuts like Cmd+K) look consistent and legible? (3) does the palette feel coherent between panels? Answer in <=80 words. Report only DEFECTS; if none, say "no defects".`,
            },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        },
      ],
    });
    console.log(`=== ${desc} ===`);
    console.log(res.choices[0].message.content.trim(), '\n');
  } catch (e) {
    console.error(`FAIL ${desc}: ${e.message}`);
  }
}
