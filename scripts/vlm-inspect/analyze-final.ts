// analyze-final.ts — transcript analysis over the final run's tap events:
//   todo-call share (noise target), tool histograms, per-turn stats, and
//   comparison against the baseline run where manifests exist.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FINAL = '/home/z/my-project/download/vlm-exercise/final';
const BASELINE = '/home/z/my-project/download/vlm-exercise/baseline';
const AFTER = '/home/z/my-project/download/vlm-exercise/after';

interface Row {
  id: string; turn: number; tools: number; secs: number;
  todoCalls: number; penCalls: number; otherCalls: number;
  variantUsed: boolean; toolHist: Record<string, number>;
}

function analyze(dir: string): Row[] {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const rows: Row[] = [];
  for (const e of manifest) {
    const tapFile = join(dir, 'tap-events', `${e.scenarioId}-t${e.turn}.jsonl`);
    if (!existsSync(tapFile)) continue;
    const hist: Record<string, number> = {};
    const seen = new Set<string>();
    for (const line of readFileSync(tapFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line).event;
        if (ev?.type === 'agent:tool_call_start' && ev.toolCallId && !seen.has(ev.toolCallId)) {
          seen.add(ev.toolCallId);
          const n = ev.toolName ?? '?';
          hist[n] = (hist[n] ?? 0) + 1;
        }
      } catch { /* skip */ }
    }
    const all = Object.values(hist).reduce((a, b) => a + b, 0);
    const todo = Object.entries(hist).filter(([k]) => k.startsWith('todo_')).reduce((a, [, v]) => a + v, 0);
    rows.push({
      id: e.scenarioId, turn: e.turn,
      tools: e.toolCalls ?? all,
      secs: Math.round((e.durationMs ?? 0) / 1000),
      todoCalls: todo,
      penCalls: Object.entries(hist).filter(([k]) => k.startsWith('pen_')).reduce((a, [, v]) => a + v, 0),
      otherCalls: all - todo,
      variantUsed: (hist['pen_generate_variants'] ?? 0) > 0,
      toolHist: hist,
    });
  }
  return rows;
}

function fmt(r: Row): string {
  const share = r.tools ? ((r.todoCalls / r.tools) * 100).toFixed(0) : '0';
  return `${r.id} t${r.turn}: ${r.tools} tools (${r.todoCalls} todo, ${share}%) · ${r.secs}s${r.variantUsed ? ' · VARIANT-GEN' : ''}`;
}

const final = analyze(FINAL);
console.log('=== FINAL RUN (perf package + todo-batch + variant gen + budget) ===');
for (const r of final) console.log(fmt(r));
const totTools = final.reduce((a, r) => a + r.tools, 0);
const totTodo = final.reduce((a, r) => a + r.todoCalls, 0);
const totSecs = final.reduce((a, r) => a + r.secs, 0);
console.log(`TOTAL: ${totTools} tool calls · ${totTodo} todo (${((totTodo / totTools) * 100).toFixed(1)}% share) · ${totSecs}s · ${final.filter((r) => r.variantUsed).length} turns used variant-gen`);

for (const [label, dir] of [['BASELINE', BASELINE], ['AFTER (7-fix)', AFTER]] as const) {
  if (!existsSync(join(dir, 'manifest.json'))) { console.log(`\n${label}: (missing)`); continue; }
  const rows = analyze(dir);
  const t = rows.reduce((a, r) => a + r.tools, 0);
  const td = rows.reduce((a, r) => a + r.todoCalls, 0);
  const s = rows.reduce((a, r) => a + r.secs, 0);
  console.log(`\n=== ${label} ===`);
  for (const r of rows) console.log(fmt(r));
  console.log(`TOTAL: ${t} tool calls · ${td} todo (${t ? ((td / t) * 100).toFixed(1) : 0}% share) · ${s}s`);
}

// aggregate tool histogram (final)
const agg: Record<string, number> = {};
for (const r of final) for (const [k, v] of Object.entries(r.toolHist)) agg[k] = (agg[k] ?? 0) + v;
console.log('\n=== FINAL tool histogram (all turns) ===');
for (const [k, v] of Object.entries(agg).sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(3)} ${k}`);
