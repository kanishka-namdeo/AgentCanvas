// merge-critiques.ts — build the final summary from existing critique-*.json
// files + manifest.json without any new VLM calls (used when a full re-run
// hits rate limits but per-turn critiques already exist on disk).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const passDir = process.argv[2];
const manifest = JSON.parse(readFileSync(join(passDir, 'manifest.json'), 'utf8'));
const byScenario = new Map<string, typeof manifest>();
for (const e of manifest) {
  const list = byScenario.get(e.scenarioId) ?? [];
  list.push(e);
  byScenario.set(e.scenarioId, list);
}

const DIMS = ['prompt_fidelity', 'layout_structure', 'spacing_consistency', 'typography', 'color_cohesion', 'component_polish', 'cleanliness', 'overall_polish'];

interface Crit { scores: Record<string, number>; overall: number; defects: any[]; missing_elements: string[]; regressions: string[] }
const rows: any[] = [];
for (const e of manifest) {
  const f = join(passDir, `critique-${e.scenarioId}-t${e.turn}.json`);
  if (!existsSync(f)) { rows.push({ ...e, critique: null }); continue; }
  const c: Crit = JSON.parse(readFileSync(f, 'utf8'));
  rows.push({ ...e, critique: c });
}

const scored = rows.filter((r) => r.critique);
const dimMeans: Record<string, number> = {};
for (const d of DIMS) {
  const xs = scored.map((r) => r.critique.scores[d] ?? 5);
  dimMeans[d] = xs.reduce((a, b) => a + b, 0) / xs.length;
}
const overallMean = scored.reduce((a, r) => a + r.critique.overall, 0) / scored.length;
let totalDefects = 0; let totalMissing = 0; let totalRegressions = 0;
const sev: Record<string, number> = { high: 0, medium: 0, low: 0 };
for (const r of scored) {
  totalDefects += r.critique.defects.length;
  totalMissing += r.critique.missing_elements.length;
  totalRegressions += r.critique.regressions.length;
  for (const d of r.critique.defects) sev[d.severity] = (sev[d.severity] ?? 0) + 1;
}

let md = `# VLM Inspection Report (merged)\n\n- Pass dir: ${passDir}\n- Turns scored: ${scored.length}/${rows.length}\n- Mean overall score: ${overallMean.toFixed(2)}/10\n- Total defects: ${totalDefects} · missing: ${totalMissing} · regressions: ${totalRegressions}\n- Severity: high ${sev.high} / medium ${sev.medium} / low ${sev.low}\n\n## Dimension means\n\n| dimension | mean |\n| --- | --- |\n`;
for (const d of DIMS) md += `| ${d} | ${dimMeans[d].toFixed(2)} |\n`;
md += `\n## Per-turn scores\n\n| scenario | turn | overall | tools | secs |\n| --- | --- | --- | --- | --- |\n`;
for (const r of rows) {
  md += `| ${r.scenarioId} | ${r.turn} | ${r.critique ? r.critique.overall : '—'} | ${r.toolCalls ?? '?'} | ${Math.round((r.durationMs ?? 0) / 1000)} |\n`;
}
writeFileSync(join(passDir, 'summary-merged.md'), md);
writeFileSync(join(passDir, 'summary-merged.json'), JSON.stringify({
  scoredCount: scored.length, totalTurns: rows.length, overallMean, dimMeans,
  totalDefects, totalMissing, totalRegressions, severity: sev,
  turns: rows.map((r) => ({ scenarioId: r.scenarioId, turn: r.turn, overall: r.critique?.overall ?? null, toolCalls: r.toolCalls, durationS: Math.round((r.durationMs ?? 0) / 1000) })),
}, null, 2));
console.log(md);
