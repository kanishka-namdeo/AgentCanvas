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
  // ---- complex-scenario suite (2026-09-07 round 3) ----
  {
    name: 'analytics-chart',
    prompt:
      "Design a high-fidelity analytics dashboard card titled 'Monthly Revenue' containing a bar chart of Jan through Jun revenue — $42K, $48K, $45K, $56K, $61K, $68K — with a month label under each bar.",
  },
  {
    name: 'data-table',
    prompt:
      "Design a high-fidelity 'Recent Orders' table card with columns Order, Customer, Date, Status, Amount and 4 data rows with realistic values, status shown as color-coded text or badges.",
  },
  {
    name: 'ecommerce-grid',
    prompt:
      'Design a high-fidelity e-commerce product grid, 4 product cards in a 2x2 layout, each card with a product image area, product name, price, and an Add to Cart button. Products: Aurora Lamp at $89, Drift Speaker at $129, Lumen Desk at $249, Arc Charger at $45.',
  },
  {
    name: 'marketing-landing',
    prompt:
      "Design a high-fidelity SaaS landing page for 'Nimbus', a cloud monitoring tool: a navbar with the Nimbus logo, a hero section with the headline 'Monitor your cloud in real time', a short subheadline, and a Start Free Trial primary button, a features section with 3 feature cards, and a footer with a copyright line.",
  },
  // ---- held-out generalization set ----
  {
    name: 'pricing-cards',
    prompt:
      "Design a pricing section with 3 plan cards side by side: Starter at $9/mo, Pro at $29/mo highlighted as 'Most Popular', and Enterprise at $99/mo. Each card lists at least 3 features.",
  },
  {
    name: 'profile-settings',
    prompt:
      "Design an account settings panel: a round avatar, the name 'Ada Lovelace', an email field showing ada@example.org, a timezone selector, and Save and Cancel buttons.",
  },
  {
    name: 'kanban-board',
    prompt:
      'Create a kanban board with three columns — To Do, In Progress, Done — each column with a header and two task cards with realistic task titles.',
  },
];

const INSTRUCTION =
  'You are a strict but fair senior product designer judging an AI-generated design screenshot. ' +
  'The screenshot shows a design tool app; judge the GENERATED CANVAS DESIGN (the artwork), ignoring app chrome. ' +
  'EVIDENCE RULE: every defect you list must describe something you can POINT TO in the image (which element, where). ' +
  'If you cannot cite the visible evidence, do not list it — invented defects are worse than missed ones. ' +
  'CHART RULE: before claiming bar heights misrepresent values, compare the bars against the printed value labels ' +
  'relative to the axis/gridline scale; only flag a mismatch you can demonstrate. ' +
  'ANCHORS: 10 = a senior human designer would ship it as-is; 8 = polished, shippable, minor polish nits only; ' +
  '6 = solid structure but visibly AI-generic (flat hierarchy, bland color, unstyled details); ' +
  '4 = prompt elements missing or broken layout; 2 = structurally broken. ' +
  'A clean, complete, well-typed design scores 8+ — do not dock points to seem strict. ' +
  'Score JSON only, no fences: {"prompt_fidelity":1-10, "layout_structure":1-10, "typography":1-10, ' +
  '"color_cohesion":1-10, "component_polish":1-10, "overall_polish":1-10, "overall":1-10, ' +
  '"defects":[strings], "top_fixes":[strings]}.';

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
  const imgDirArg = process.argv.find((a) => a.startsWith('--img-dir='));
  const imgDir = imgDirArg ? imgDirArg.slice(10) : IMG_DIR;
  const targets = only ? TARGETS.filter((t) => only.some((o) => t.name.includes(o))) : TARGETS;
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const outJson = outArg ? outArg.slice(6) : OUT_JSON;
  const results: any[] = [];

  for (const t of targets) {
    // Image lookup: prefer <name>.png, fall back to <name>-r1.png (run-eval
    // dumps name canvases as <id>-r<repeat>.png via render-dumped-canvas.ts).
    const candidates = [join(imgDir, `${t.name}.png`), join(imgDir, `${t.name}-r1.png`)];
    const img = candidates.find((p) => existsSync(p));
    console.log(`> ${t.name}`);
    if (!img) {
      console.log(`  FAIL image missing: ${candidates.join(' | ')}`);
      results.push({ target: t.name, error: `image missing: ${candidates.join(' | ')}` });
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

  writeFileSync(outJson, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${outJson}`);
  const ok = results.filter((x) => x.scores).length;
  console.log(`scored ${ok}/${results.length} targets`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
