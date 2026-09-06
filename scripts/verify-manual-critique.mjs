#!/usr/bin/env node
// Functional verification of the design-critique invocation mode (2026-09-06).
//
// Usage: node scripts/verify-manual-critique.mjs [manual|auto]
//   manual (default) — POST /api/agent WITHOUT designCritiqueMode in settings
//                      → route/runner normalize to the 'manual' product default
//                      → expect ZERO critic subagent dispatches (invocations are
//                        manual, not compulsory) and, on a fresh-doc build with
//                        enough new shapes, an agent:critique_skipped event with
//                        reason 'manual_mode'.
//   auto (control)    — POST with settings.designCritiqueMode = 'auto'
//                      → expect the critic subagents to dispatch (proves the
//                        settings threading client→route→runner works).
//
// The prompt intentionally builds a multi-element login screen on a FRESH
// document (≥8 new shapes clears the FRESH_DOC_NODE_THRESHOLD the auto
// ladder uses), so 'auto' would fire critics and 'manual' must hold them.

const MODE = process.argv[2] ?? 'manual';
const DOC_ID = `verify-critique-${MODE}-${Date.now()}`;
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

const settings = {
  llmProvider: 'zai',
  thinkingLevel: 'low',
  maxIterations: 12,
};
if (MODE === 'auto') settings.designCritiqueMode = 'auto';

const body = {
  documentId: DOC_ID,
  prompt:
    'Create a login screen: a card with a bold title "Welcome back", an email input, a password input, a primary login button, a small remember-me row, and a footer link row.',
  canvasState: {
    id: DOC_ID,
    name: 'Verify',
    version: '2.17',
    children: [],
    background: '#f8fafc',
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  },
  settings,
};

console.log(`[verify] mode=${MODE} doc=${DOC_ID}`);
const res = await fetch(`${BASE}/api/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
if (!res.ok || !res.body) {
  console.error(`[verify] FAIL: HTTP ${res.status}`);
  process.exit(2);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
let sawTurnEnd = false;
let criticDispatches = 0;
let critiqueEvents = 0;
let critiqueEventsWithDefects = 0;
let skipEvents = [];
let errors = [];
let addedShapes = 0;

const deadline = Date.now() + 8 * 60 * 1000;
process.stdout.write('[verify] streaming');
outer: while (true) {
  if (Date.now() > deadline) {
    console.log('\n[verify] timeout waiting for stream');
    break;
  }
  const read = await Promise.race([
    reader.read(),
    new Promise((r) => setTimeout(() => r({ done: true, timedOut: true }), 120_000)),
  ]);
  if (read.done) break;
  buf += decoder.decode(read.value, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // partial line
    }
    if (ev.type === 'patch') {
      const p = ev.patch;
      const op = p?.op ?? p?.type;
      if (op === 'add_subtree') addedShapes += (p.nodes?.length ?? 1);
      else if (op === 'bulk_add') addedShapes += (p.shapes?.length ?? p.nodes?.length ?? 1);
      else if (op === 'add') addedShapes += 1;
    } else if (ev.type === 'agent_event') {
      const t = ev.event?.type;
      if (t === 'agent:subagent_dispatch') {
        if (/design_critic/.test(ev.event.subAgentType ?? '')) {
          criticDispatches++;
          console.log(`\n[verify] DISPATCH ${ev.event.subAgentType}`);
        }
      } else if (t === 'agent:critique') {
        critiqueEvents++;
        const defectCount = (ev.event.defects ?? []).length;
        if (defectCount > 0) critiqueEventsWithDefects++;
        console.log(`\n[verify] CRITIQUE iter=${ev.event.iteration} defects=${defectCount}`);
      } else if (t === 'agent:critique_skipped') {
        skipEvents.push(ev.event.reason);
        console.log(`\n[verify] CRITIQUE_SKIPPED reason=${ev.event.reason}`);
      } else if (t === 'agent:error') {
        errors.push(ev.event.message ?? '');
        console.log(`\n[verify] ERROR ${(ev.event.message ?? '').slice(0, 120)}`);
      } else if (t === 'agent:turn_end') {
        sawTurnEnd = true;
        break outer;
      } else {
        process.stdout.write('.');
      }
    }
  }
}
console.log('');
console.log(`[verify] summary: turn_end=${sawTurnEnd} shapes~${addedShapes} criticDispatches=${criticDispatches} critiqueEvents=${critiqueEvents}(withDefects=${critiqueEventsWithDefects}) skipEvents=${JSON.stringify(skipEvents)} errors=${errors.length}`);

// ---- assertions ------------------------------------------------------------
let failed = 0;
if (!sawTurnEnd) { console.log('[verify] FAIL: turn never ended'); failed++; }
if (errors.length > 0) { console.log(`[verify] FAIL: ${errors.length} agent error(s): ${errors[0]?.slice(0, 160)}`); failed++; }

if (MODE === 'manual') {
  // NOTE: an agent:critique event with ZERO defects still fires on skipped
  // turns — it carries the free deterministic-validator report (defects from
  // validation.reasons only). The LLM-critic invocation signal is
  // subagent_dispatch + a critique event carrying actual critic defects.
  if (criticDispatches > 0 || critiqueEventsWithDefects > 0) {
    console.log(`[verify] FAIL(manual): critics fired automatically (dispatches=${criticDispatches}, critiquesWithDefects=${critiqueEventsWithDefects}) — invocations must be manual`);
    failed++;
  } else {
    console.log('[verify] PASS(manual): no critic subagent dispatched automatically');
  }
  if (addedShapes >= 8 && !skipEvents.includes('manual_mode')) {
    console.log(`[verify] FAIL(manual): expected a critique_skipped 'manual_mode' row on a ${addedShapes}-shape fresh build, got ${JSON.stringify(skipEvents)}`);
    failed++;
  }
} else if (MODE === 'auto') {
  if (criticDispatches === 0) {
    console.log('[verify] FAIL(auto): control run dispatched no critics — settings threading broken?');
    failed++;
  } else {
    console.log('[verify] PASS(auto): control run dispatched the critic subagents as expected');
  }
}

console.log(failed === 0 ? '[verify] RESULT: PASS' : `[verify] RESULT: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
