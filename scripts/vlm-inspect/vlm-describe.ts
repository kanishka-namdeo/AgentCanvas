// vlm-describe.ts — ask the VLM to describe precisely what IS visible in
// given screenshots (free-form, not the rubric). Used to diagnose the
// "missing text" findings: are the elements truly absent, or off-viewport?
import ZAI from 'z-ai-web-dev-sdk';
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: bun vlm-describe.ts <img1> [img2...]');
  process.exit(2);
}

const zai = await ZAI.create();

for (const f of files) {
  const b64 = readFileSync(f).toString('base64');
  const res = await (zai as any).chat.completions.createVision({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this design-tool screenshot precisely: (1) list EVERY piece of text you can see on the canvas (exact strings), (2) describe the visible components and their vertical extent (roughly what fraction of the canvas height each occupies), (3) state whether any content appears cut off at the bottom or right edge of the canvas area. Be terse and factual.',
          },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' } },
        ],
      },
    ],
    thinking: { type: 'disabled' },
  });
  console.log(`\n=== ${f} ===`);
  console.log(res?.choices?.[0]?.message?.content ?? '(empty)');
}
