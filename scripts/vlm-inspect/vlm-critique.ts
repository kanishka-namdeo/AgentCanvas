// vlm-critique.ts — independent VLM inspection of scenario screenshots.
//
// For every turn in <passDir>/manifest.jsonl: send the canvas screenshot
// (plus the PREVIOUS turn's screenshot for multi-shot turns 2+) to the
// vision LLM with a structured, scenario-general rubric, parse the JSON
// critique, and write per-turn critique files. Then aggregate into
// summary.json + summary.md (dimension means, defect histogram, missing
// elements, regressions, top fixes).
//
// This is deliberately an EXTERNAL measurement — it shares no code with the
// app's in-loop design-critic-vlm sub-agent so the exercise cannot grade
// itself with the same instrument that coaches the agent.
//
// Usage: bun scripts/vlm-inspect/vlm-critique.ts <passDir> [--only=id1,id2]

import ZAI from 'z-ai-web-dev-sdk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const passDir = process.argv[2];
const ONLY_ARG = process.argv.find((a) => a.startsWith('--only='));
const ONLY = ONLY_ARG ? ONLY_ARG.split('=').slice(1).join('=').split(',') : null;
if (!passDir) {
  console.error('Usage: bun vlm-critique.ts <passDir> [--only=id1,id2]');
  process.exit(2);
}

// ---- rubric -------------------------------------------------------------------

const DIMENSIONS = [
  'prompt_fidelity',
  'layout_structure',
  'spacing_consistency',
  'typography',
  'color_cohesion',
  'component_polish',
  'cleanliness',
  'overall_polish',
] as const;

const SYSTEM_PROMPT = `You are an impartial, exacting senior product designer reviewing the output of an AI design agent. You will be shown a screenshot of a design-tool application. Evaluate ONLY the design rendered on its canvas — IGNORE the application chrome (toolbars, zoom controls, sidebars, the chat/messages panel, cursors, selection outlines, layer panels). The chrome is not part of the design under review.

You will be told what the user asked for. Judge the canvas strictly against that request, then score each dimension 1-10 (10 = flawless professional work, 5 = mediocre, 1 = broken):

1. prompt_fidelity — every element, string, and arrangement the user asked for is present and correct
2. layout_structure — sensible composition; elements grouped, aligned and proportioned like real UI; nothing scattered or floating randomly
3. spacing_consistency — paddings and gaps consistent, nothing cramped, nothing touching that shouldn't
4. typography — clear size/weight hierarchy, readable, no clipped or awkwardly wrapped text
5. color_cohesion — coherent palette, sensible background/surface/accent distribution, adequate contrast
6. component_polish — cards/buttons/inputs/toggles look like finished components (radii, shadows, borders, states)
7. cleanliness — no overlapping elements, no clipped content, no stray artifacts, nothing colliding
8. overall_polish — would this pass as a real designer's mockup in a portfolio?

Also report:
- defects: EVERY visual defect you can see: {"dimension", "severity" ("high"|"medium"|"low"), "description", "location"} — be specific and visual, name where it is
- missing_elements: things the user explicitly asked for that are absent or wrong
- regressions: ONLY if a BEFORE image is provided — elements from the previous turn that were damaged, moved unexpectedly, restyled wrongly, or deleted by the latest edit (an empty array otherwise)
- top_fixes: the 3-5 highest-leverage concrete fixes

Respond with ONLY a JSON object, no markdown fences, no commentary:
{"scores": {"prompt_fidelity": n, "layout_structure": n, "spacing_consistency": n, "typography": n, "color_cohesion": n, "component_polish": n, "cleanliness": n, "overall_polish": n}, "overall": n, "defects": [{"dimension": "...", "severity": "...", "description": "...", "location": "..."}], "missing_elements": ["..."], "regressions": ["..."], "top_fixes": ["..."]}`;

// ---- types --------------------------------------------------------------------

interface ManifestEntry {
  scenarioId: string;
  turn: number;
  prompt: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  screenshot: string;
  toolCalls: number;
  timedOut: boolean;
  retried: boolean;
}

interface Defect { dimension: string; severity: string; description: string; location?: string }
interface Critique {
  scores: Record<string, number>;
  overall: number;
  defects: Defect[];
  missing_elements: string[];
  regressions: string[];
  top_fixes: string[];
  raw?: string;
}

// ---- defensive JSON parsing (LLM output) ----------------------------------------

function parseCritique(content: string): Critique | undefined {
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
  let obj: any;
  try { obj = JSON.parse(s.slice(start, end)); } catch { return undefined; }
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
      ? obj.missing_elements.filter((x: unknown): x is string => typeof x === 'string') : [],
    regressions: Array.isArray(obj.regressions)
      ? obj.regressions.filter((x: unknown): x is string => typeof x === 'string') : [],
    top_fixes: Array.isArray(obj.top_fixes)
      ? obj.top_fixes.filter((x: unknown): x is string => typeof x === 'string') : [],
    raw: content,
  };
}

// ---- image loading --------------------------------------------------------------

function toDataUrl(path: string): string | null {
  if (!existsSync(path)) return null;
  const b64 = readFileSync(path).toString('base64');
  return `data:image/png;base64,${b64}`;
}

// ---- one critique call -----------------------------------------------------------

async function critiqueTurn(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  entry: ManifestEntry,
  promptsSoFar: string[],
  beforePath: string | undefined,
): Promise<Critique | undefined> {
  const after = toDataUrl(entry.screenshot);
  if (!after) {
    console.log(`  ⚠ screenshot missing: ${entry.screenshot} — skipped`);
    return undefined;
  }

  const contextLines = [
    `The design-tool screenshot below shows the canvas AFTER the AI agent handled the user's requests.`,
    ``,
    `The user's requests so far (in order):`,
    ...promptsSoFar.map((p, i) => `${i + 1}. ${p}`),
    ``,
    beforePath
      ? `FIRST image = BEFORE (previous turn's canvas). SECOND image = AFTER (current canvas, the one to score). Compare them for REGRESSIONS caused by the latest edit; score the AFTER image.`
      : `Score the canvas shown in the image.`,
  ];

  const content: any[] = [{ type: 'text', text: contextLines.join('\n') }];
  if (beforePath) {
    const before = toDataUrl(beforePath);
    if (before) content.push({ type: 'image_url', image_url: { url: before, detail: 'high' } });
  }
  content.push({ type: 'image_url', image_url: { url: after, detail: 'high' } });

  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await (zai as any).chat.completions.createVision({
        messages,
        thinking: { type: 'disabled' },
      });
      const text = response?.choices?.[0]?.message?.content ?? '';
      if (typeof text !== 'string' || !text.trim()) throw new Error('empty VLM response');
      const parsed = parseCritique(text);
      if (parsed) return parsed;
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: 'Your previous response did not parse as JSON. Reply with ONLY the JSON object.' });
    } catch (err) {
      console.log(`  ⚠ VLM attempt ${attempt + 1} failed: ${(err as Error).message.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return undefined;
}

// ---- aggregation -------------------------------------------------------------------

interface TurnRow {
  scenarioId: string;
  turn: number;
  prompt: string;
  toolCalls: number;
  durationS: number;
  critique?: Critique;
  screenshot: string;
}

function aggregate(rows: TurnRow[]) {
  const scored = rows.filter((r) => r.critique);
  const dimMeans: Record<string, number> = {};
  for (const d of DIMENSIONS) {
    const xs = scored.map((r) => r.critique!.scores[d] ?? 5);
    dimMeans[d] = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  }
  const overallMean = scored.length ? scored.reduce((a, r) => a + r.critique!.overall, 0) / scored.length : 0;

  const defectCounts: Record<string, { high: number; medium: number; low: number }> = {};
  let totalDefects = 0;
  for (const r of scored) {
    for (const d of r.critique!.defects) {
      const key = d.dimension || 'unknown';
      defectCounts[key] ??= { high: 0, medium: 0, low: 0 };
      defectCounts[key][d.severity as 'high' | 'medium' | 'low'] =
        (defectCounts[key][d.severity as 'high' | 'medium' | 'low'] ?? 0) + 1;
      totalDefects++;
    }
  }

  const byScenario = new Map<string, TurnRow[]>();
  for (const r of scored) {
    const list = byScenario.get(r.scenarioId) ?? [];
    list.push(r);
    byScenario.set(r.scenarioId, list);
  }
  const scenarioSummaries = [...byScenario.entries()].map(([id, rs]) => ({
    scenarioId: id,
    turns: rs.length,
    overall: rs.reduce((a, r) => a + r.critique!.overall, 0) / rs.length,
    finalOverall: rs[rs.length - 1].critique!.overall,
    toolCalls: rs.reduce((a, r) => a + r.toolCalls, 0),
    durationS: rs.reduce((a, r) => a + r.durationS, 0),
    missing_elements: rs.flatMap((r) => r.critique!.missing_elements),
    regressions: rs.flatMap((r) => r.critique!.regressions),
    defects: rs.flatMap((r) => r.critique!.defects),
  }));

  return { dimMeans, overallMean, totalDefects, defectCounts, scenarioSummaries, scoredCount: scored.length, rowCount: rows.length };
}

function renderMarkdown(rows: TurnRow[], agg: ReturnType<typeof aggregate>): string {
  const L: string[] = [];
  L.push(`# VLM Inspection Report`, ``);
  L.push(`- Pass dir: ${passDir}`);
  L.push(`- Generated: ${new Date().toISOString()}`);
  L.push(`- Turns scored: ${agg.scoredCount}/${agg.rowCount}`);
  L.push(`- Mean overall score: ${agg.overallMean.toFixed(2)}/10`);
  L.push(`- Total defects reported: ${agg.totalDefects}`);
  L.push('');
  L.push(`## Dimension means`, ``);
  L.push(`| dimension | mean |`);
  L.push(`| --- | --- |`);
  for (const d of DIMENSIONS) L.push(`| ${d} | ${agg.dimMeans[d].toFixed(2)} |`);
  L.push('');
  L.push(`## Per-turn scores`, ``);
  L.push(`| scenario | turn | overall | fidelity | layout | spacing | typography | color | polish | clean | tools | secs |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of rows) {
    const c = r.critique;
    L.push(`| ${r.scenarioId} | ${r.turn} | ${c ? c.overall : '—'} | ${c ? c.scores.prompt_fidelity : '—'} | ${c ? c.scores.layout_structure : '—'} | ${c ? c.scores.spacing_consistency : '—'} | ${c ? c.scores.typography : '—'} | ${c ? c.scores.color_cohesion : '—'} | ${c ? c.scores.component_polish : '—'} | ${c ? c.scores.cleanliness : '—'} | ${r.toolCalls} | ${(r.durationS).toFixed(0)} |`);
  }
  L.push('');
  L.push(`## Defect histogram (dimension × severity)`, ``);
  L.push(`| dimension | high | medium | low | total |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  const dims = Object.keys(agg.defectCounts).sort((a, b) => {
    const ta = Object.values(agg.defectCounts[a]).reduce((x, y) => x + y, 0);
    const tb = Object.values(agg.defectCounts[b]).reduce((x, y) => x + y, 0);
    return tb - ta;
  });
  for (const d of dims) {
    const c = agg.defectCounts[d];
    const total = c.high + c.medium + c.low;
    L.push(`| ${d} | ${c.high} | ${c.medium} | ${c.low} | ${total} |`);
  }
  L.push('');
  L.push(`## Scenario summaries`, ``);
  for (const s of agg.scenarioSummaries) {
    L.push(`### ${s.scenarioId} — overall ${s.overall.toFixed(1)} (final turn ${s.finalOverall}), ${s.toolCalls} tools, ${s.durationS.toFixed(0)}s`);
    if (s.missing_elements.length) L.push(`- Missing: ${s.missing_elements.join(' | ')}`);
    if (s.regressions.length) L.push(`- Regressions: ${s.regressions.join(' | ')}`);
    for (const d of s.defects.slice(0, 8)) L.push(`- [${d.severity}] ${d.dimension}: ${d.description}${d.location ? ` (${d.location})` : ''}`);
    L.push('');
  }
  L.push(`## All top fixes (per turn)`, ``);
  for (const r of rows) {
    if (r.critique?.top_fixes?.length) {
      L.push(`**${r.scenarioId} t${r.turn}:**`);
      for (const f of r.critique.top_fixes) L.push(`- ${f}`);
      L.push('');
    }
  }
  return L.join('\n');
}

// ---- main -------------------------------------------------------------------------

async function main() {
  const manifestPath = join(passDir, 'manifest.jsonl');
  if (!existsSync(manifestPath)) {
    console.error(`manifest not found: ${manifestPath}`);
    process.exit(2);
  }
  const entries: ManifestEntry[] = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const selected = ONLY ? entries.filter((e) => ONLY.includes(e.scenarioId)) : entries;

  const zai = await ZAI.create();
  const rows: TurnRow[] = [];
  const byScenario = new Map<string, ManifestEntry[]>();
  for (const e of entries) {
    const list = byScenario.get(e.scenarioId) ?? [];
    list.push(e);
    byScenario.set(e.scenarioId, list);
  }

  for (const e of selected) {
    console.log(`▶ ${e.scenarioId} t${e.turn}`);
    const all = byScenario.get(e.scenarioId)!;
    const promptsSoFar = all.filter((x) => x.turn <= e.turn).map((x) => x.prompt);
    const before = all.find((x) => x.turn === e.turn - 1)?.screenshot;
    const critique = await critiqueTurn(zai, e, promptsSoFar, before);
    if (critique) {
      writeFileSync(
        join(passDir, `critique-${e.scenarioId}-t${e.turn}.json`),
        JSON.stringify({ ...critique, raw: undefined, manifest: e }, null, 2),
      );
      console.log(`  ✓ overall ${critique.overall}/10 · ${critique.defects.length} defects · ${critique.missing_elements.length} missing · ${critique.regressions.length} regressions`);
    } else {
      console.log(`  ✗ critique FAILED (kept raw attempt out)`);
    }
    rows.push({
      scenarioId: e.scenarioId,
      turn: e.turn,
      prompt: e.prompt,
      toolCalls: e.toolCalls,
      durationS: e.durationMs / 1000,
      critique,
      screenshot: basename(e.screenshot),
    });
  }

  const agg = aggregate(rows);
  writeFileSync(join(passDir, 'summary.json'), JSON.stringify({ ...agg, rows: rows.map(({ critique, ...rest }) => ({ ...rest, overall: critique?.overall ?? null })) }, null, 2));
  writeFileSync(join(passDir, 'summary.md'), renderMarkdown(rows, agg));
  console.log(`\nsummary: ${join(passDir, 'summary.md')}`);
  console.log(`mean overall: ${agg.overallMean.toFixed(2)}/10 · ${agg.totalDefects} defects across ${agg.scoredCount} turns`);
}

main();
