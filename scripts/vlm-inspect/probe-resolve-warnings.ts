// probe-resolve-warnings.ts — resolve the 3 dumped multishot canvases and
// print the ResolverWarnings the agent WOULD have seen. Tells us whether each
// VLM-verified defect already emits a warning (prompt-side fix) or needs a
// new warning kind (resolver-side fix).
// Usage: bun scripts/vlm-inspect/probe-resolve-warnings.ts
import { readFileSync } from 'node:fs';
import { resolvePenTreeDetailed } from '../../src/lib/pen/resolve';
import type { CanvasDocument } from '../../src/lib/pen/types';

const FILES = [
  'ms-pricing-iterate',
  'ms-login-refine',
  'ms-dashboard-edit',
] as const;

for (const name of FILES) {
  const path = `scripts/agent-eval/results/${name}-final-canvas.json`;
  const doc = JSON.parse(readFileSync(path, 'utf8')) as CanvasDocument;
  const warnings: { kind: string; message: string; nodeId: string }[] = [];
  const { layers } = resolvePenTreeDetailed(doc, { warnings: warnings as never });
  console.log(`\n== ${name} (${layers.length} layers)`);
  if (!warnings.length) console.log('  (no warnings)');
  for (const w of warnings) console.log(`  [${w.kind}] ${w.message.slice(0, 160)}`);
}
