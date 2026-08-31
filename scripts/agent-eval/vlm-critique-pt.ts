// vlm-critique-pt.ts — DEFERRED task 12-a of the prompt-tuning exercise:
// external VLM critique of the 3 multi-shot final canvases
// (ms-pricing-iterate, ms-login-refine, ms-dashboard-edit).
//
// Original plan: z.ai sandbox vision (createVision). That endpoint was
// HTTP-429 quota-blocked for >4h on 2026-08-31 and remains blocked on
// re-probe — per operator directive the kimi-k2-5 custom endpoint
// (vision-capable, verified by probe-vlm-quota.ts) serves as the VLM.
//
// Rubric = exactly the 6 dimensions promised in final-report.md §7:
// prompt_fidelity, layout_structure, typography, color_cohesion,
// component_polish, overall_polish (+ overall + defects/missing/top_fixes).
//
// The images are canvas-only renders (render-ms-canvas.ts): frame-fitted to
// the content bbox with a 24px margin, 2x scale, NO app chrome.
//
// Usage:
//   bun scripts/agent-eval/vlm-critique-pt.ts [--provider=kimi|zai|auto]
//                                             [--repeats=N] [--only=a,b]
//   provider=auto: try zai first (in case its quota clears), fall back to
//   kimi on 429/empty per call. Default: kimi (the verified-working path).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const OUT_DIR = '/home/z/my-project/download/prompt-tuning';
const IMG_DIR = OUT_DIR;

const KIMI_BASE = 'https://irhnglwoxe.a.pinggy.link/v1';
const KIMI_KEY = '123456';
const KIMI_MODEL = 'kimi-k2-5';

// ---- CLI ----------------------------------------------------------------------

const PROVIDER_ARG = process.argv.find((a) => a.startsWith('--provider='));
const PROVIDER = PROVIDER_ARG ? PROVIDER_ARG.split('=').slice(1).join('=') : 'kimi';
const REPEATS_ARG = process.argv.find((a) => a.startsWith('--repeats='));
const REPEATS = REPEATS_ARG ? Math.max(1, parseInt(REPEATS_ARG.split('=')[1], 10) || 1) : 1;
const ONLY_ARG = process.argv.find((a) => a.startsWith('--only='));
const ONLY = ONLY_ARG ? ONLY_ARG.slice(7).split(',') : null;

// ---- targets ------------------------------------------------------------------

interface Target {
  name: string;
  image: string;
  blurb: string;
  prompts: string[];
}

const TARGETS: Target[] = [
  {
    name: 'ms-pricing-iterate',
    image: join(IMG_DIR, 'ms-pricing-iterate.png'),
    blurb: 'Iterative refinement: build a 3-tier pricing page, visually emphasize the Pro tier, then add a billing toggle.',
    prompts: [
      "Design a pricing page for a SaaS called 'Flowly' with 3 tiers: Starter $9/month, Pro $29/month, Enterprise $99/month. Include feature lists and CTA buttons for each tier.",
      'Make the Pro tier visually highlighted as the most popular option.',
      'Add a monthly/yearly billing toggle at the top of the page.',
    ],
  },
  {
    name: 'ms-login-refine',
    image: join(IMG_DIR, 'ms-login-refine.png'),
    blurb: 'Additive edits + layout tweaks: mobile banking login → social sign-in row → tighter spacing with a full-width sign-in button.',
    prompts: [
      "Create a mobile login screen for a banking app called 'Vaultly' with email and password fields, a sign-in button, and a 'Forgot password?' link.",
      'Add social sign-in buttons for Google and Apple below the sign-in button.',
      'Tighten the spacing and make the sign-in button full-width.',
    ],
  },
  {
    name: 'ms-dashboard-edit',
    image: join(IMG_DIR, 'ms-dashboard-edit.png'),
    blurb: "Copy edits + style application: dashboard header → 4 KPI cards → retitle to 'Growth Metrics' + shadows on the KPI cards.",
    prompts: [
      "Design a simple analytics dashboard header with the title 'Metrics' and a date-range selector.",
      'Add a row of 4 KPI cards below the header: Revenue $128.4K, Active Users 12,840, Churn 2.1%, NPS 62.',
      "Change the dashboard title to 'Growth Metrics' and give the KPI cards a subtle shadow.",
    ],
  },
];

// ---- rubric (6 dimensions, exactly as promised in final-report.md §7) ----------

const DIMENSIONS = [
  'prompt_fidelity',
  'layout_structure',
  'typography',
  'color_cohesion',
  'component_polish',
  'overall_polish',
] as const;

const SYSTEM_PROMPT = `You are an impartial, exacting senior product designer reviewing the output of an AI design agent. The image is a render of the design canvas ONLY (white background outside the content, small margin) — there is no application chrome, so everything visible belongs to the design under review.

You will be told what the user asked for across a short multi-turn conversation. The image shows the FINAL canvas after ALL requests were handled. Judge the final state strictly against the full conversation (later requests must not have damaged earlier work), then score each dimension 1-10 (10 = flawless professional work, 5 = mediocre, 1 = broken):

1. prompt_fidelity — every element, string, and arrangement the user asked for across ALL turns is present and correct in the final state
2. layout_structure — sensible composition; elements grouped, aligned and proportioned like real UI; nothing scattered or floating randomly
3. typography — clear size/weight hierarchy, readable, no clipped or awkwardly wrapped text
4. color_cohesion — coherent palette, sensible background/surface/accent distribution, adequate contrast
5. component_polish — cards/buttons/inputs/toggles look like finished components (radii, shadows, borders, states)
6. overall_polish — would this pass as a real designer's mockup in a portfolio?

Also report:
- defects: EVERY visual defect you can see: {"dimension" (one of the six), "severity" ("high"|"medium"|"low"), "description", "location"} — be specific and visual, name where it is
- missing_elements: things the user explicitly asked for that are absent or wrong in the final state
- top_fixes: the 3-5 highest-leverage concrete fixes

Respond with ONLY a JSON object, no markdown fences, no commentary:
{"scores": {"prompt_fidelity": n, "layout_structure": n, "typography": n, "color_cohesion": n, "component_polish": n, "overall_polish": n}, "overall": n, "defects": [{"dimension": "...", "severity": "...", "description": "...", "location": "..."}], "missing_elements": ["..."], "top_fixes": ["..."]}`;

// ---- types --------------------------------------------------------------------

interface Defect {
  dimension: string;
  severity: string;
  description: string;
  location?: string;
}
interface Critique {
  scores: Record<string, number>;
  overall: number;
  defects: Defect[];
  missing_elements: string[];
  top_fixes: string[];
  provider: string;
  model: string;
  raw: string;
}

// ---- defensive JSON parsing (LLM output) ----------------------------------------

function parseCritique(content: string, provider: string, model: string): Critique | undefined {
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
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return undefined;
  let obj: any;
  try {
    obj = JSON.parse(s.slice(start, end));
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;

  const scores: Record<string, number> = {};
  for (const d of DIMENSIONS) {
    const v = obj.scores?.[d];
    scores[d] = typeof v === 'number' ? Math.max(1, Math.min(10, v)) : 5;
  }
  const clamp = (v: unknown) => (typeof v === 'number' ? Math.max(1, Math.min(10, v)) : 5);

  return {
    scores,
    overall: clamp(obj.overall),
    defects: Array.isArray(obj.defects)
      ? obj.defects
          .filter((d: any) => d && typeof d === 'object' && typeof d.description === 'string')
          .map((d: any) => ({
            dimension: typeof d.dimension === 'string' ? d.dimension : 'unknown',
            severity: ['high', 'medium', 'low'].includes(d.severity) ? d.severity : 'medium',
            description: d.description,
            location: typeof d.location === 'string' ? d.location : undefined,
          }))
      : [],
    missing_elements: Array.isArray(obj.missing_elements)
      ? obj.missing_elements.filter((x: unknown): x is string => typeof x === 'string')
      : [],
    top_fixes: Array.isArray(obj.top_fixes)
      ? obj.top_fixes.filter((x: unknown): x is string => typeof x === 'string')
      : [],
    provider,
    model,
    raw: content,
  };
}

// ---- providers ------------------------------------------------------------------

function toDataUrl(path: string): string | null {
  if (!existsSync(path)) return null;
  const b64 = readFileSync(path).toString('base64');
  return `data:image/png;base64,${b64}`;
}

function buildMessages(target: Target, dataUrl: string): any[] {
  const contextLines = [
    `The image below shows the FINAL canvas of a design-tool AI agent after it handled the user's requests.`,
    ``,
    `Scenario: ${target.blurb}`,
    ``,
    `The user's requests, in order:`,
    ...target.prompts.map((p, i) => `${i + 1}. ${p}`),
    ``,
    `Score the final canvas shown in the image against the full conversation.`,
  ];
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: contextLines.join('\n') },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ];
}

async function callKimi(messages: any[]): Promise<{ text: string; model: string }> {
  const res = await fetch(`${KIMI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${KIMI_KEY}` },
    body: JSON.stringify({ model: KIMI_MODEL, messages, max_tokens: 4000 }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`kimi HTTP ${res.status}: ${text.slice(0, 200)}`);
  let content = '';
  try {
    content = JSON.parse(text).choices?.[0]?.message?.content ?? '';
  } catch {
    /* raw below */
  }
  if (typeof content !== 'string' || !content.trim()) throw new Error('kimi empty response');
  return { text: content, model: KIMI_MODEL };
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

async function callOnce(provider: string, messages: any[]): Promise<{ text: string; model: string; provider: string }> {
  if (provider === 'zai') {
    const r = await callZai(messages);
    return { ...r, provider: 'zai' };
  }
  if (provider === 'kimi') {
    const r = await callKimi(messages);
    return { ...r, provider: 'kimi' };
  }
  // auto: zai first, kimi on failure
  try {
    const r = await callZai(messages);
    return { ...r, provider: 'zai' };
  } catch (e) {
    console.log(`  … zai failed (${(e as Error).message.slice(0, 80)}) — falling back to kimi`);
    const r = await callKimi(messages);
    return { ...r, provider: 'kimi (zai fallback)' };
  }
}

async function critiqueTarget(provider: string, target: Target): Promise<Critique | undefined> {
  const dataUrl = toDataUrl(target.image);
  if (!dataUrl) {
    console.log(`  ⚠ image missing: ${target.image}`);
    return undefined;
  }
  const messages = buildMessages(target, dataUrl);
  let lastText = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await callOnce(provider, messages);
      lastText = r.text;
      const parsed = parseCritique(r.text, r.provider, r.model);
      if (parsed) return parsed;
      // format-repair round-trip
      messages.push({ role: 'assistant', content: r.text });
      messages.push({
        role: 'user',
        content: 'Your previous response did not parse as JSON. Reply with ONLY the JSON object.',
      });
    } catch (err) {
      console.log(`  ⚠ attempt ${attempt + 1} failed: ${(err as Error).message.slice(0, 120)}`);
      await new Promise((r2) => setTimeout(r2, 5000));
    }
  }
  if (lastText) {
    return {
      scores: Object.fromEntries(DIMENSIONS.map((d) => [d, 5])),
      overall: 5,
      defects: [],
      missing_elements: [],
      top_fixes: [],
      provider: 'unparsed',
      model: 'n/a',
      raw: `UNPARSED after retries:\n${lastText.slice(0, 2000)}`,
    };
  }
  return undefined;
}

// ---- aggregation -----------------------------------------------------------------

interface RunRow {
  name: string;
  run: number;
  critique?: Critique;
}

function aggregate(rows: RunRow[]) {
  const scored = rows.filter((r) => r.critique && r.critique.provider !== 'unparsed');
  const dimMeans: Record<string, number> = {};
  for (const d of DIMENSIONS) {
    const xs = scored.map((r) => r.critique!.scores[d] ?? 5);
    dimMeans[d] = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  }
  const overallMean = scored.length
    ? scored.reduce((a, r) => a + r.critique!.overall, 0) / scored.length
    : 0;

  const severity = { high: 0, medium: 0, low: 0 };
  for (const r of scored) for (const d of r.critique!.defects) severity[d.severity as 'high']++;

  const byTarget = new Map<string, Critique[]>();
  for (const r of scored) {
    const list = byTarget.get(r.name) ?? [];
    list.push(r.critique!);
    byTarget.set(r.name, list);
  }
  const perTarget = [...byTarget.entries()].map(([name, cs]) => ({
    name,
    runs: cs.length,
    overall: cs.reduce((a, c) => a + c.overall, 0) / cs.length,
    overallValues: cs.map((c) => c.overall),
    dimMeans: Object.fromEntries(
      DIMENSIONS.map((d) => [d, cs.reduce((a, c) => a + (c.scores[d] ?? 5), 0) / cs.length]),
    ),
    missing_elements: [...new Set(cs.flatMap((c) => c.missing_elements))],
    defects: cs.flatMap((c) => c.defects),
    top_fixes: [...new Set(cs.flatMap((c) => c.top_fixes))],
    providers: [...new Set(cs.map((c) => c.provider))],
  }));

  return { dimMeans, overallMean, severity, perTarget, scoredCount: scored.length, rowCount: rows.length };
}

function renderMarkdown(rows: RunRow[], agg: ReturnType<typeof aggregate>): string {
  const L: string[] = [];
  L.push(`# Prompt-Tuning VLM Critique (deferred task 12-a, completed)`, ``);
  L.push(`- Generated: ${new Date().toISOString()}`);
  L.push(`- Provider: ${PROVIDER} (z.ai vision was HTTP-429 quota-blocked at completion time)`);
  L.push(`- Repeats per image: ${REPEATS}`);
  L.push(`- Images scored: ${agg.scoredCount}/${agg.rowCount} runs`);
  L.push(`- Mean overall: ${agg.overallMean.toFixed(2)}/10`);
  L.push('');
  L.push(`## Dimension means`, ``);
  L.push(`| dimension | mean |`);
  L.push(`| --- | --- |`);
  for (const d of DIMENSIONS) L.push(`| ${d} | ${agg.dimMeans[d].toFixed(2)} |`);
  L.push('');
  L.push(`## Per-run scores`, ``);
  L.push(`| scenario | run | provider | overall | fidelity | layout | typography | color | polish | finishing |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of rows) {
    const c = r.critique;
    L.push(
      `| ${r.name} | ${r.run} | ${c ? c.provider : '—'} | ${c ? c.overall : '—'} | ${c ? c.scores.prompt_fidelity : '—'} | ${c ? c.scores.layout_structure : '—'} | ${c ? c.scores.typography : '—'} | ${c ? c.scores.color_cohesion : '—'} | ${c ? c.scores.component_polish : '—'} | ${c ? c.scores.overall_polish : '—'} |`,
    );
  }
  L.push('');
  L.push(`## Per-image detail`, ``);
  for (const t of agg.perTarget) {
    L.push(
      `### ${t.name} — overall ${t.overall.toFixed(1)} (runs: ${t.overallValues.join(', ')}) · provider ${t.providers.join('/')}`,
    );
    if (t.missing_elements.length) L.push(`- Missing: ${t.missing_elements.join(' | ')}`);
    for (const d of t.defects.slice(0, 10))
      L.push(`- [${d.severity}] ${d.dimension}: ${d.description}${d.location ? ` (${d.location})` : ''}`);
    if (t.top_fixes.length) {
      L.push(`- Top fixes:`);
      for (const f of t.top_fixes.slice(0, 6)) L.push(`  - ${f}`);
    }
    L.push('');
  }
  L.push(`## Severity totals`, ``);
  L.push(`high ${agg.severity.high} · medium ${agg.severity.medium} · low ${agg.severity.low}`);
  return L.join('\n');
}

// ---- main ------------------------------------------------------------------------

async function main() {
  const targets = ONLY ? TARGETS.filter((t) => ONLY.some((o) => t.name.includes(o))) : TARGETS;
  if (!targets.length) {
    console.error(`no targets matched --only=${ONLY?.join(',')}`);
    process.exit(2);
  }
  const rows: RunRow[] = [];
  for (const t of targets) {
    for (let run = 1; run <= REPEATS; run++) {
      console.log(`▶ ${t.name} [run ${run}/${REPEATS}]`);
      const critique = await critiqueTarget(PROVIDER, t);
      if (critique) {
        writeFileSync(
          join(OUT_DIR, `vlm-critique-${t.name}-r${run}.json`),
          JSON.stringify(critique, null, 2),
        );
        console.log(
          `  ✓ ${critique.provider}/${critique.model} · overall ${critique.overall}/10 · ${critique.defects.length} defects · ${critique.missing_elements.length} missing`,
        );
      } else {
        console.log(`  ✗ critique FAILED`);
      }
      rows.push({ name: t.name, run, critique });
    }
  }
  const agg = aggregate(rows);
  writeFileSync(join(OUT_DIR, 'vlm-summary.json'), JSON.stringify({ ...agg, rows: rows.map(({ critique, ...rest }) => ({ ...rest, overall: critique?.overall ?? null })) }, null, 2));
  writeFileSync(join(OUT_DIR, 'vlm-summary.md'), renderMarkdown(rows, agg));
  console.log(`\nsummary: ${join(OUT_DIR, 'vlm-summary.md')}`);
  console.log(
    `mean overall: ${agg.overallMean.toFixed(2)}/10 · severity h/m/l = ${agg.severity.high}/${agg.severity.medium}/${agg.severity.low} · ${agg.scoredCount}/${agg.rowCount} runs scored`,
  );
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
