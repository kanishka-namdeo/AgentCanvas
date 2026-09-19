// measure-prompt-baseline.ts — quantify AgentCanvas's per-call LLM context cost.
// Estimates tokens as chars/4 (same heuristic as scripts/measure-tool-cost.ts).
// Run: bun scripts/measure-prompt-baseline.ts

import { createCanvasTools, toolsToOpenAISpec, type CanvasToolContext } from '../src/lib/agent/tools';
import { createPenTools } from '../src/lib/agent/pen-tools';
import { buildSystemPrompt, SYSTEM_PROMPT_TEMPLATE } from '../src/lib/agent/runner-legacy';
import { formatSkillMetadataForPrompt, formatSkillBodyForPrompt } from '../src/lib/agent/skills';

const est = (s: string) => Math.round(s.length / 4);

function emptyCtx(): CanvasToolContext {
  return {
    getShapes: () => [],
    getTokens: () => ({ colors: [], textStyles: [] }),
    getDocument: () => ({
      id: 'x', name: 'x', version: '2.17',
      children: [], variables: undefined, themes: undefined,
      background: '#fff',
      viewport: { zoom: 1, panX: 0, panY: 0 },
      shapes: [], tokens: { colors: [], textStyles: [] },
    } as any),
    applyPatch: () => ({ op: 'select', summary: 'noop' }),
  };
}

const ctx = emptyCtx();
const tools = [...createCanvasTools(ctx), ...createPenTools(ctx)] as ReturnType<typeof createCanvasTools>;
const specs = toolsToOpenAISpec(tools);

const specsJson = JSON.stringify(specs);
const system = buildSystemPrompt(
  formatSkillMetadataForPrompt(),
  formatSkillBodyForPrompt('designs' as any),
  '',
  {
    id: 'demo', name: 'Untitled', version: '2.17',
    background: '#f8fafc', viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [], children: [], tokens: { colors: [], textStyles: [] },
  } as any,
  'slate' as any,
  false,
  false,
);

console.log('=== AgentCanvas per-call context baseline ===');
console.log(`Tool count:                    ${specs.length}`);
console.log(`Tool specs JSON:               ${specsJson.length.toLocaleString()} chars  ~${est(specsJson).toLocaleString()} tok`);
console.log(`System prompt (no snapshot):   ${system.length.toLocaleString()} chars  ~${est(system).toLocaleString()} tok`);
console.log(`  - template raw:              ${SYSTEM_PROMPT_TEMPLATE.length.toLocaleString()} chars  ~${est(SYSTEM_PROMPT_TEMPLATE).toLocaleString()} tok`);
console.log(`  - skill metadata:            ${est(formatSkillMetadataForPrompt()).toLocaleString()} tok`);
console.log(`  - skill body (designs):      ${est(formatSkillBodyForPrompt('designs' as any)).toLocaleString()} tok`);
console.log(`Static prefix total (approx):  ~${(est(specsJson) + est(system)).toLocaleString()} tok`);

console.log('');
console.log('=== Top 20 fattest tool definitions (est tokens) ===');
const sizes = specs
  .map((s: any) => ({ name: s.function.name, tokens: Math.round(JSON.stringify(s).length / 4) }))
  .sort((a: any, b: any) => b.tokens - a.tokens)
  .slice(0, 20);
for (const s of sizes) console.log(`  ${String(s.tokens).padStart(6)} tok  ${s.name}`);

const all = specs.map((s: any) => Math.round(JSON.stringify(s).length / 4));
const total = all.reduce((a: number, b: number) => a + b, 0);
console.log('');
console.log(`TOTAL tool defs: ~${total.toLocaleString()} tok   avg/tool: ~${Math.round(total / specs.length)} tok`);

// Description-only cost (what a one-line signature catalog would cost)
const descs = specs.map((s: any) => `${s.function.name}(${Object.keys(s.function.parameters?.properties ?? {}).join(', ')}) — ${s.function.description ?? ''}`);
const descOnly = est(descs.join('\n'));
console.log(`One-line signature catalog:    ~${descOnly.toLocaleString()} tok  (vs ~${total.toLocaleString()} full schemas)`);
