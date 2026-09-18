// vlm-score-agnes.ts — VLM-as-judge for canvas screenshots using
// agnes-3.0-flash's image-input capability.
//
// This is the Layer 5 of the world-class test bench (research-03 §8).
// Scores rendered canvas PNGs against the 5-dimension aesthetics + usability
// rubric (Duan 2024 + Li 2025, per research-03 §3). Calls the Agnes gateway
// directly via fetch (NOT the z.ai sandbox) per the user directive
// "Remember and only use this openAI compatible endpoint for inference
// instead of ZAI sandbox for this performance tuning exercise."
//
// Usage:
//   bun scripts/agent-eval/vlm-score-agnes.ts \
//     --dumps=scripts/agent-eval/results/iter6-bench/dumps \
//     --out=scripts/agent-eval/results/iter6-bench/vlm-scores.json
//
// Each canvas dump in <dumps>/<id>-r<repeat>.canvas.json is rendered to PNG
// (using render-dumped-canvas.ts's pipeline), then sent to agnes-3.0-flash
// with the 5-dim rubric. Output is a JSON file mapping {scenarioId, repeat}
// → {vlm_overall, per_criterion, prompt_fidelity, top_fixes}.

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { renderCanvasToPng } from '../../src/lib/canvas/render-to-png';
import { normalizeCanvas } from '../../src/lib/agent/runner-legacy';
import { SCENARIOS } from './scenarios';

const args = process.argv.slice(2);
const dumpsArg = args.find((a) => a.startsWith('--dumps='));
const outArg = args.find((a) => a.startsWith('--out='));
const agnesUrl = 'https://apihub.agnes-ai.com/v1/chat/completions';
const agnesKey = 'cpk-ajRkpZScOVOm78JloDIH7GryqHY687mWZXHe1fNNbskyT74T';
const agnesModel = 'agnes-3.0-flash';

if (!dumpsArg || !outArg) {
  console.error('Usage: bun scripts/agent-eval/vlm-score-agnes.ts --dumps=DIR --out=FILE.json');
  process.exit(1);
}

const DUMPS_DIR = dumpsArg!.split('=').slice(1).join('=');
const OUT_PATH = outArg!.split('=').slice(1).join('=');
const PNG_DIR = join(DUMPS_DIR, 'png');
mkdirSync(PNG_DIR, { recursive: true });

// ---- 5-dimension rubric (Duan 2024 UI Critique Agent + Li 2025 ext.) ----
const RUBRIC_PROMPT = `You are a senior product designer judging an AI-generated design screenshot.
The screenshot shows the GENERATED CANVAS (ignore app chrome around it).
Score each dimension 0-5 (5=excellent, 3=acceptable, 1=poor).

Dimensions:
1. AESTHETICS — visual appeal, color harmony, modern feel. (5: cohesive + beautiful; 1: ugly/clashing.)
2. LEARNABILITY — clear structure, intuitive layout, recognizable patterns. (5: instantly usable; 1: confusing.)
3. EFFICIENCY — information density vs breathing room balance, minimal clicks. (5: optimal; 1: cluttered/wasteful.)
4. USABILITY — touch target sizing, contrast (WCAG AA ≥4.5:1 text), focus affordances. (5: passes; 1: broken.)
5. OVERALL — holistic polish vs a senior designer's bar. (5: shippable as-is; 1: amateur.)

ALSO CHECK PROMPT FIDELITY — did the design include every concrete element the user asked for?
(brand names, button labels, field labels, numeric values, specific colors)

EVIDENCE RULE: every defect you list must describe something visible in the image. Do not invent defects.
If you can't see the canvas clearly, score conservatively (3-4) and note "image-unclear".

Return JSON ONLY (no markdown fences):
{
  "per_criterion": [{"name":"AESTHETICS","score":0-5,"note":"..."},
                    {"name":"LEARNABILITY","score":0-5,"note":"..."},
                    {"name":"EFFICIENCY","score":0-5,"note":"..."},
                    {"name":"USABILITY","score":0-5,"note":"..."},
                    {"name":"OVERALL","score":0-5,"note":"..."}],
  "overall": 0-5,
  "prompt_fidelity": {"strings_present":[...],"strings_missing":[...]},
  "top_3_fixes": ["...", "...", "..."]
}`;

interface VlmScore {
  per_criterion: Array<{ name: string; score: number; note: string }>;
  overall: number;
  prompt_fidelity: { strings_present: string[]; strings_missing: string[] };
  top_3_fixes: string[];
  raw_latency_ms: number;
  raw_content?: string;
  error?: string;
}

async function scoreScreenshot(prompt: string, pngPath: string): Promise<VlmScore> {
  const imgB64 = readFileSync(pngPath).toString('base64');
  const body = {
    model: agnesModel,
    stream: false,
    temperature: 0.0,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: 'You are a senior design critic. Output valid JSON only — no markdown fences.' },
      { role: 'user', content: [
        { type: 'text', text: `Original user prompt:\n${prompt}\n\n${RUBRIC_PROMPT}` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgB64}` } },
      ] },
    ],
  };

  const start = Date.now();
  try {
    const resp = await fetch(agnesUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${agnesKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    const elapsed = Date.now() - start;
    if (!resp.ok) {
      return { per_criterion: [], overall: 0, prompt_fidelity: { strings_present: [], strings_missing: [] }, top_3_fixes: [], raw_latency_ms: elapsed, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    const r = JSON.parse(text);
    let content = r.choices?.[0]?.message?.content ?? '';
    if (content.startsWith('```')) {
      const m = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (m) content = m[1];
    }
    const parsed = JSON.parse(content);
    return { ...parsed, raw_latency_ms: elapsed, raw_content: content.slice(0, 500) };
  } catch (err: any) {
    return { per_criterion: [], overall: 0, prompt_fidelity: { strings_present: [], strings_missing: [] }, top_3_fixes: [], raw_latency_ms: Date.now() - start, error: err.message };
  }
}

async function renderCanvasToPngWrapper(docPath: string, outPath: string): Promise<void> {
  const raw = JSON.parse(readFileSync(docPath, 'utf-8'));
  const doc = normalizeCanvas(raw);
  const shapes = (doc.shapes ?? []) as unknown as Array<Record<string, unknown> & { x?: number; y?: number; width?: number; height?: number; visible?: boolean }>;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    if (s.visible === false) continue;
    const x = Number(s.x ?? 0);
    const y = Number(s.y ?? 0);
    const w = Number(s.width ?? 0);
    const h = Number(s.height ?? 0);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  if (!Number.isFinite(minX)) throw new Error('no visible layers');
  const pad = 24;
  const frameX = Math.floor(minX - pad);
  const frameY = Math.floor(minY - pad);
  const shifted = shapes.map((s) => ({ ...s, x: Number(s.x ?? 0) - frameX, y: Number(s.y ?? 0) - frameY }));
  const w = Math.ceil(maxX - minX + pad * 2);
  const h = Math.ceil(maxY - minY + pad * 2);
  const png = await renderCanvasToPng(shifted as any, w, h);
  writeFileSync(outPath, png);
}

async function main() {
  if (!existsSync(DUMPS_DIR)) {
    console.error(`Dumps dir not found: ${DUMPS_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(DUMPS_DIR).filter((f) => f.endsWith('.canvas.json'));
  console.log(`Found ${files.length} canvas dump(s) in ${DUMPS_DIR}`);

  // Map scenarioId → prompt for fidelity check
  const promptMap = new Map(SCENARIOS.map((s) => [s.id, s.prompt]));

  const results: Array<{ scenarioId: string; repeat: number; pngPath: string; score: VlmScore }> = [];
  let done = 0;
  for (const file of files) {
    // Parse: <id>-r<repeat>.canvas.json
    const m = file.match(/^(.+)-r(\d+)\.canvas\.json$/);
    if (!m) {
      console.log(`  skipping ${file} (doesn't match <id>-r<repeat>.canvas.json pattern)`);
      continue;
    }
    const scenarioId = m[1];
    const repeat = Number(m[2]);
    const prompt = promptMap.get(scenarioId) ?? '';
    if (!prompt) {
      console.log(`  skipping ${file} (scenario ${scenarioId} not in registry)`);
      continue;
    }

    const docPath = join(DUMPS_DIR, file);
    const pngPath = join(PNG_DIR, `${scenarioId}-r${repeat}.png`);
    if (!existsSync(pngPath)) {
      try {
        await renderCanvasToPngWrapper(docPath, pngPath);
        console.log(`  rendered ${file} → ${basename(pngPath)}`);
      } catch (err: any) {
        console.log(`  ✗ render failed for ${file}: ${err.message}`);
        continue;
      }
    }

    done++;
    console.log(`[${done}/${files.length}] scoring ${scenarioId} r${repeat}...`);
    const score = await scoreScreenshot(prompt, pngPath);
    if (score.error) {
      console.log(`  ✗ VLM error: ${score.error.slice(0, 100)}`);
    } else {
      console.log(`  ✓ overall=${score.overall}/5 (latency=${score.raw_latency_ms}ms)`);
    }
    results.push({ scenarioId, repeat, pngPath, score });
  }

  // Aggregate per-scenario mean + variance
  const byScenario = new Map<string, VlmScore[]>();
  for (const r of results) {
    const arr = byScenario.get(r.scenarioId) ?? [];
    arr.push(r.score);
    byScenario.set(r.scenarioId, arr);
  }
  const summary: Record<string, any> = {};
  for (const [id, scores] of byScenario) {
    const overalls = scores.map((s) => s.overall).filter((n) => typeof n === 'number');
    const mean = overalls.length ? overalls.reduce((a, b) => a + b, 0) / overalls.length : 0;
    const variance = overalls.length ? overalls.reduce((s, v) => s + (v - mean) ** 2, 0) / overalls.length : 0;
    summary[id] = {
      n: scores.length,
      vlm_overall_mean: Number(mean.toFixed(2)),
      vlm_overall_stdev: Number(Math.sqrt(variance).toFixed(2)),
      vlm_overall_min: overalls.length ? Math.min(...overalls) : null,
      vlm_overall_max: overalls.length ? Math.max(...overalls) : null,
      runs: scores.map((s, i) => ({
        repeat: i + 1,
        overall: s.overall,
        per_criterion: s.per_criterion?.map((c) => ({ name: c.name, score: c.score, note: c.note?.slice(0, 100) })),
        prompt_fidelity_missing: s.prompt_fidelity?.strings_missing?.slice(0, 5),
        top_fixes: s.top_3_fixes?.slice(0, 3),
        error: s.error,
        latency_ms: s.raw_latency_ms,
      })),
    };
  }
  writeFileSync(OUT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nWrote VLM scores to ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
