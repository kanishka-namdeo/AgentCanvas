// vlm-score-oneshot.ts — task 5-d: VLM scoring of one-shot AI-generated
// design screenshots (login-hifi, dashboard-hifi) via z.ai sandbox vision.
// Mirrors the zai branch of vlm-critique-pt.ts:
// require('z-ai-web-dev-sdk') -> ZAI.create() -> zai.chat.completions.createVision

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const IMG_DIR = '/home/z/my-project/download/agent-eval';
const OUT_JSON = join(IMG_DIR, 'vlm-scores.json');

interface Target { name: string; prompt: string }

const TARGETS: Target[] = [
  {
    name: 'login-hifi',
    prompt:
      "Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.",
  },
  {
    name: 'dashboard-hifi',
    prompt:
      'Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.',
  },
];

const INSTRUCTION =
  'You are a strict senior product designer judging an AI-generated design screenshot. The screenshot shows a design tool app; judge the GENERATED CANVAS DESIGN (the artwork), ignoring app chrome. Score JSON only, no fences: {"prompt_fidelity":1-10, "layout_structure":1-10, "typography":1-10, "color_cohesion":1-10, "component_polish":1-10, "overall_polish":1-10, "overall":1-10, "defects":[strings], "top_fixes":[strings]}. 10 = a senior human designer\'s polished output; 5 = passable but clearly AI-generic; be honest and strict.';

const DIMS = [
  'prompt_fidelity',
  'layout_structure',
  'typography',
  'color_cohesion',
  'component_polish',
  'overall_polish',
  'overall',
] as const;

function parseJson(content: string): any | undefined {
  let s = content.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return undefined;
  try { return JSON.parse(s.slice(start, end)); } catch { return undefined; }
}

async function callZai(messages: any[]): Promise<{ text: string; model: string }> {
  const mod = require('z-ai-web-dev-sdk');
  const ZAI = mod.default ?? mod;
  const zai = await ZAI.create();
  const r = await (zai as any).chat.completions.createVision({
    messages,
    thinking: { type: 'disabled' },
  });
  const content = r?.choices?.[0]?.message?.content ?? '';
  if (typeof content !== 'string' || !content.trim()) throw new Error('zai empty response');
  return { text: content, model: r?.model ?? 'zai-default-vision' };
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice(7).split(',') : null;
  const targets = only ? TARGETS.filter((t) => only.some((o) => t.name.includes(o))) : TARGETS;
  const results: any[] = [];

  for (const t of targets) {
    const img = join(IMG_DIR, `${t.name}.png`);
    console.log(`> ${t.name}`);
    if (!existsSync(img)) {
      console.log(`  FAIL image missing: ${img}`);
      results.push({ target: t.name, error: `image missing: ${img}` });
      continue;
    }
    const dataUrl = `data:image/png;base64,${readFileSync(img).toString('base64')}`;
    const messages: any[] = [
      { role: 'system', content: INSTRUCTION },
      {
        role: 'user',
        content: [
          { type: 'text', text: `The user's one-shot prompt:\n"${t.prompt}"\n\nScore the generated canvas design shown in the image against this prompt.` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ];
    // ONE vision call per target — no internal retry loop (per task rules).
    try {
      const r = await callZai(messages);
      console.log(`  ok model=${r.model}`);
      const obj = parseJson(r.text);
      if (obj) {
        const scores: Record<string, number> = {};
        for (const d of DIMS) {
          const v = obj[d] ?? obj.scores?.[d];
          scores[d] = typeof v === 'number' ? Math.max(1, Math.min(10, v)) : 5;
        }
        const defects = Array.isArray(obj.defects)
          ? obj.defects.map((x: any) => (typeof x === 'string' ? x : typeof x?.description === 'string' ? x.description : null)).filter(Boolean)
          : [];
        const topFixes = Array.isArray(obj.top_fixes)
          ? obj.top_fixes.filter((x: any) => typeof x === 'string')
          : [];
        results.push({ target: t.name, model: r.model, scores, defects, top_fixes: topFixes, raw: r.text });
        console.log(`  ${DIMS.map((d) => `${d}=${scores[d]}`).join(' ')}`);
        for (const d of defects) console.log(`  - defect: ${String(d).slice(0, 150)}`);
        for (const f of topFixes) console.log(`  - fix: ${String(f).slice(0, 150)}`);
      } else {
        results.push({ target: t.name, error: 'unparseable JSON response', raw: r.text.slice(0, 1500) });
        console.log('  FAIL unparseable JSON response');
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      results.push({ target: t.name, error: msg });
      console.log(`  FAIL error: ${msg.slice(0, 250)}`);
    }
  }

  writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${OUT_JSON}`);
  const ok = results.filter((x) => x.scores).length;
  console.log(`scored ${ok}/${results.length} targets`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
