// Multi-shot visual test: VLM critique of a stage screenshot.
// Usage: node scripts/vlm-ms-critique.js <image-path> <out-json> <stage-note>
import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ZAI = require('z-ai-web-dev-sdk').default;

const IMG = process.argv[2];
const OUT = process.argv[3];
const STAGE = process.argv[4] || 'screen';
const MODE = process.argv[5] || 'single'; // 'single' screen or 'multi' screen

const PROMPT = MODE === 'multi'
  ? `You are a senior UI/UX designer with 15 years shipping production mobile apps. This screenshot shows ${STAGE} of an AI design agent's multi-shot session: multiple screens on one canvas (a Figma-style workflow). Critique harshly.

For EACH dimension, list concrete defects with fixes:
1. VISUAL HIERARCHY per screen
2. SPACING & PADDING consistency
3. COLOR PALETTE — CRITICALLY: do the screens share ONE coherent design system (same bg/surface/primary colors, same type scale)? Multi-screen consistency is the core Figma-alternative standard here. Any screen that looks like it came from a different design system is a MAJOR defect.
4. TYPOGRAPHY consistency across screens
5. COMPONENT POLISH (shadows, radii, borders, buttons)
6. ALIGNMENT & grid
7. SCREEN PLACEMENT — are screens side-by-side without overlap?
8. OVERALL PROFESSIONALISM vs Figma quality bar

Then JSON output:
{ "dimensions": { "1_hierarchy": [{"defect":"...","fix":"..."}], "2_spacing": [...], "3_palette_consistency": [...], "4_typography": [...], "5_polish": [...], "6_alignment": [...], "7_placement": [...], "8_professionalism": [...] }, "overall_score": <1-10>, "top_5_fixes": [{"priority":1,"fix":"...","impact":"high|med|low"}] }`
  : `You are a senior UI/UX designer with 15 years shipping production mobile apps. This screenshot shows ${STAGE} of an AI design agent's work (a mobile login screen for a fintech app). Critique harshly.

For EACH dimension, list concrete defects with fixes:
1. VISUAL HIERARCHY — is the wordmark/brand the anchor? Headings vs body scale?
2. SPACING & PADDING — 8px-grid rhythm, gutters, breathing room?
3. COLOR PALETTE — coherent primary/accent/neutral system? Sufficient contrast?
4. TYPOGRAPHY — weights, sizes, alignment?
5. COMPONENT POLISH — input fields have borders/placeholders? Primary button clearly primary? Radius/shadow consistency?
6. ALIGNMENT — edges line up? Single column rhythm?
7. CONTENT FIDELITY — brand name "Vaultly", email field, password field, Sign In button, Forgot password link all present and correctly spelled?
8. OVERALL PROFESSIONALISM — Figma top-tier or wireframe-grade?

Then JSON output:
{ "dimensions": { "1_hierarchy": [{"defect":"...","fix":"..."}], "2_spacing": [...], "3_palette": [...], "4_typography": [...], "5_polish": [...], "6_alignment": [...], "7_content_fidelity": [...], "8_professionalism": [...] }, "overall_score": <1-10>, "top_5_fixes": [{"priority":1,"fix":"...","impact":"high|med|low"}] }`;

const imgB64 = readFileSync(IMG).toString('base64');
const dataUrl = `data:image/png;base64,${imgB64}`;

for (let attempt = 1; attempt <= 6; attempt++) {
  try {
    const zai = await ZAI.create();
    const r = await zai.chat.completions.createVision({
      model: 'glm-4v-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    });
    writeFileSync(OUT, JSON.stringify(r, null, 2));
    const content = r?.choices?.[0]?.message?.content;
    const m = typeof content === 'string' ? content.match(/"overall_score"\s*:\s*([0-9.]+)/) : null;
    console.log(`SUCCESS attempt ${attempt} → ${OUT}`);
    console.log(`OVERALL_SCORE: ${m ? m[1] : 'parse-in-json'}`);
    process.exit(0);
  } catch (e) {
    console.log(`attempt ${attempt} failed: ${e.message?.slice(0, 120)}`);
    await new Promise((r2) => setTimeout(r2, 4000));
  }
}
console.error('ALL ATTEMPTS FAILED');
process.exit(1);
