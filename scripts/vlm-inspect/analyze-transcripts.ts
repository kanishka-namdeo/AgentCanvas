// analyze-transcripts.ts — join the socket tap log with the scenario manifest.
//
// For every manifest turn window [startMs, endMs + grace] extract from the
// tap: the selected skill, the resolved model, every tool call (name,
// success, duration via toolCallId matching), the canvas patch count, and
// agent errors. Emit per-turn stats + cross-turn tool usage aggregates.
//
// Usage: bun scripts/vlm-inspect/analyze-transcripts.ts <passDir>

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const passDir = process.argv[2];
if (!passDir) {
  console.error('Usage: bun analyze-transcripts.ts <passDir>');
  process.exit(2);
}

interface ManifestEntry {
  scenarioId: string; turn: number; prompt: string;
  startMs: number; endMs: number; durationMs: number;
  screenshot: string; tapFile: string; toolCalls: number;
  timedOut: boolean; empty: boolean; redone?: number;
}

interface TapLine { t: number; event: Record<string, any> }

function loadTap(path: string): TapLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l) as TapLine; } catch { return null; }
    })
    .filter((x): x is TapLine => x !== null);
}

interface ToolStat { name: string; success: boolean | null; durMs: number | null; summary?: string }

interface TurnTranscript {
  scenarioId: string;
  turn: number;
  prompt: string;
  skill?: { category: string; confidence: number; method: string; toolCount: number };
  model?: string;
  toolCalls: ToolStat[];
  toolCallCount: number;
  failedCalls: number;
  patchCount: number;
  errors: string[];
  durationS: number;
  warnings?: string[];
}

function analyze() {
  const manifest: ManifestEntry[] = JSON.parse(readFileSync(join(passDir, 'manifest.json'), 'utf8'));
  const transcripts: TurnTranscript[] = [];

  for (const m of manifest) {
    const tap = loadTap(m.tapFile);
    const win = tap.filter((x) => x.t >= m.startMs - 1000 && x.t <= m.endMs + 5000);
    const starts = new Map<string, { t: number; name: string }>();
    const ends = new Map<string, { t: number; success: boolean; summary: string }>();
    let skill: TurnTranscript['skill'];
    let model: string | undefined;
    let patchCount = 0;
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const { t: evtT, event } of win) {
      switch (event.type) {
        case 'agent:tool_call_start':
          starts.set(event.toolCallId, { t: evtT, name: event.toolName });
          break;
        case 'agent:tool_call_end':
          ends.set(event.toolCallId, { t: evtT, success: event.success, summary: event.summary ?? '' });
          break;
        case 'agent:skill_selected':
          skill = { category: event.category, confidence: event.confidence, method: event.method, toolCount: event.toolCount };
          break;
        case 'agent:model_resolved':
          model = event.model ?? event.resolvedModel;
          break;
        case 'canvas:patch':
          patchCount++;
          break;
        case 'agent:error':
          errors.push(event.message ?? 'unknown error');
          break;
        default:
          break;
      }
    }

    const toolCalls: ToolStat[] = [...starts.entries()].map(([id, s]) => {
      const e = ends.get(id);
      return {
        name: s.name,
        success: e?.success ?? null,
        durMs: e ? e.t - s.t : null,
        summary: e?.summary?.slice(0, 160),
      };
    });

    transcripts.push({
      scenarioId: m.scenarioId,
      turn: m.turn,
      prompt: m.prompt,
      skill,
      model,
      toolCalls,
      toolCallCount: toolCalls.length,
      failedCalls: toolCalls.filter((c) => c.success === false).length,
      patchCount,
      errors,
      durationS: m.durationMs / 1000,
      warnings,
    });
  }

  // Cross-turn aggregates.
  const toolFreq = new Map<string, { count: number; failures: number; totalMs: number }>();
  for (const t of transcripts) {
    for (const c of t.toolCalls) {
      const s = toolFreq.get(c.name) ?? { count: 0, failures: 0, totalMs: 0 };
      s.count++;
      if (c.success === false) s.failures++;
      if (c.durMs) s.totalMs += c.durMs;
      toolFreq.set(c.name, s);
    }
  }

  const out = {
    passDir,
    generatedAt: new Date().toISOString(),
    turns: transcripts,
    toolFrequency: [...toolFreq.entries()]
      .map(([name, s]) => ({ name, ...s, meanMs: s.count ? Math.round(s.totalMs / s.count) : 0 }))
      .sort((a, b) => b.count - a.count),
  };
  writeFileSync(join(passDir, 'transcripts.json'), JSON.stringify(out, null, 2));

  // Markdown digest.
  const L: string[] = [];
  L.push(`# Agent Transcripts — ${passDir}`, '');
  for (const t of transcripts) {
    L.push(`## ${t.scenarioId} turn ${t.turn}${t.skill ? ` · skill=${t.skill.category} (${t.skill.method}, conf ${t.skill.confidence?.toFixed?.(2) ?? t.skill.confidence})` : ''}${t.model ? ` · model=${t.model}` : ''}`);
    L.push(`> ${t.prompt}`);
    L.push('');
    L.push(`${t.toolCallCount} tool calls · ${t.failedCalls} failed · ${t.patchCount} patches · ${t.durationS.toFixed(0)}s`);
    if (t.errors.length) L.push(`errors: ${t.errors.join(' | ')}`);
    const names = new Map<string, number>();
    for (const c of t.toolCalls) names.set(c.name, (names.get(c.name) ?? 0) + 1);
    L.push('');
    L.push('``' + `${[...names.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(', ')}` + '``');
    L.push('');
  }
  L.push(`## Tool frequency (all turns)`, '');
  L.push(`| tool | calls | failures | mean ms |`);
  L.push(`| --- | --- | --- | --- |`);
  for (const f of out.toolFrequency) L.push(`| ${f.name} | ${f.count} | ${f.failures} | ${f.meanMs} |`);
  writeFileSync(join(passDir, 'transcripts.md'), L.join('\n'));
  console.log(`transcripts: ${join(passDir, 'transcripts.md')}`);
  for (const t of transcripts) {
    console.log(`  ${t.scenarioId} t${t.turn}: ${t.toolCallCount} calls, ${t.failedCalls} failed, ${t.patchCount} patches${t.skill ? `, skill=${t.skill.category}` : ''}`);
  }
}

analyze();
