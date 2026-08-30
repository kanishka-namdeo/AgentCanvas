// Runtime smoke test: build ALL agent tools with typebox-v1 schemas and
// validate representative model calls through the SDK's validator.
import { createCanvasTools } from '../src/lib/agent/tools';
import { createPenTools } from '../src/lib/agent/pen-tools';
import { createFigmaTools } from '../src/lib/agent/figma-tools';
import { validateToolArguments } from '@openclaw/ai';

const ctx = {
  getShapes: () => [],
  getTokens: () => ({ colors: [], textStyles: [] }) as any,
  applyPatch: (p: any) => p,
  getDocument: () => undefined,
} as any;

let tools: any[] = [];
try {
  tools = [...(createCanvasTools(ctx) as any[]), ...(createPenTools(ctx) as any[]), ...(createFigmaTools(ctx) as any[])];
  console.log(`built ${tools.length} tools OK`);
} catch (e) {
  console.log('BUILD FAILED:', e instanceof Error ? e.stack : e);
  process.exit(1);
}

const byName = (n: string) => tools.find((t) => t.name === n);
let failures = 0;

function probe(name: string, args: any, expect: 'pass' | 'fail') {
  const tool = byName(name);
  if (!tool) {
    console.log(`[${name}] TOOL NOT FOUND`);
    failures++;
    return;
  }
  try {
    const out = validateToolArguments(tool, { name, arguments: structuredClone(args) } as any);
    if (expect === 'fail') {
      console.log(`[${name}] UNEXPECTED PASS ->`, JSON.stringify(out).slice(0, 110));
      failures++;
    } else {
      console.log(`[${name}] PASS ->`, JSON.stringify(out).slice(0, 110));
    }
  } catch (e: any) {
    if (expect === 'fail') {
      console.log(`[${name}] correctly rejected:`, String(e.message).split('\n')[1]?.trim());
    } else {
      console.log(`[${name}] UNEXPECTED FAIL ->`, String(e.message).split('\n').slice(0, 5).join(' | '));
      failures++;
    }
  }
}

// 1. The EXACT failure from the live incident: stringified variantCount
probe('pen_generate_variants', { request: 'landing page', variantCount: '3' }, 'pass');
probe('pen_generate_variants', { request: 'landing page', variantCount: 3 }, 'pass');
probe('pen_generate_variants', { request: 'landing page', variantCount: '7' }, 'fail');

// 2. Recursive subtree: deep nesting + stringified numbers (must accept — unions)
probe('pen_create_subtree', {
  node: {
    type: 'frame', width: 'fit_content', height: 812,
    children: [{ type: 'text', fontSize: '24', children: [{ type: 'text', fontSize: 12 }] }],
  },
}, 'pass');
probe('pen_create_subtree', { nodes: [{ type: 'frame' }, { type: 'frame' }] }, 'pass');
// string elements INSIDE the children array were invalid under the old
// v0.34 recursive schema too (array items must be objects) — pre-existing.
probe('pen_create_subtree', { node: { type: 'frame', children: ['[{"type":"text"}]'] } }, 'fail');
// garbage coerces to a string, then execute() returns the friendly
// subtree_node_missing error — graceful, matches pre-migration UX.
probe('pen_create_subtree', { node: 42 }, 'pass');
probe('pen_create_subtree', {}, 'pass'); // both-missing → execute() friendly error

// 3. Stringified numbers on plain style fields (systemic coercion check)
probe('pen_create_node', { type: 'text', text: 'Hi', fontSize: '24', opacity: '0.8' }, 'pass');

// 3b. THE live incident: sizing strings on update changes (8× failures in the
// landing-page turn) — must now pass validation.
probe('pen_update_node', { nodeId: 'abc', changes: { height: 'fit_content' } }, 'pass');
probe('pen_update_node', { nodeId: 'abc', changes: { width: 'fill_container', height: 280 } }, 'pass');
probe('pen_create_node', { type: 'frame', width: 'fit_content', height: 'fill_container' }, 'pass');

// 4. Literal unions still enforced
probe('pen_update_node', { shapeId: 'abc', changes: { textAlign: 'middle' } }, 'fail');
probe('pen_update_node', { shapeId: 'abc', changes: { textAlign: 'center' } }, 'pass');

// 5. Every tool's schema must at least be structurally buildable JSON schema
let badSpecs = 0;
for (const t of tools) {
  if (!t.parameters || typeof t.parameters !== 'object') {
    console.log(`[spec] ${t.name}: missing parameters`);
    badSpecs++;
  }
}
console.log(`spec scan: ${tools.length - badSpecs}/${tools.length} OK`);

console.log(failures === 0 ? 'ALL PROBES PASSED' : `${failures} PROBE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
