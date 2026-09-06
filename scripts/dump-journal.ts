#!/usr/bin/env bun
// dump-journal.ts — forensic dump of AgentEvent rows for a documentId.
// usage: bun scripts/dump-journal.ts <documentId> [--full]

import { db } from '@/lib/db';

const docId = process.argv[2];
const full = process.argv.includes('--full');
if (!docId) { console.error('usage: bun scripts/dump-journal.ts <documentId> [--full]'); process.exit(2); }

const rows = await db.agentEvent.findMany({
  where: { documentId: docId },
  orderBy: { seq: 'asc' },
  take: 400,
});

for (const r of rows) {
  const t = r.type;
  let brief = '';
  try {
    const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
    if (t === 'agent:tool_call_start') brief = `${p.toolName} ${String(p.argsPreview ?? '').slice(0, full ? 600 : 160)}`;
    else if (t === 'agent:tool_call_end') brief = `${p.toolName} ${String(p.resultPreview ?? '').slice(0, full ? 600 : 120)}`;
    else if (t === 'agent:subagent_dispatch') brief = `${p.subAgentType}`;
    else if (t === 'agent:subagent_result') brief = String(p.result ?? '').slice(0, 200);
    else if (t === 'agent:skill_selected') brief = JSON.stringify(p).slice(0, 160);
    else if (t === 'agent:status_note') brief = String(p.note ?? '').slice(0, 160);
    else if (t === 'agent:error') brief = String(p.message ?? '').slice(0, 200);
    else if (t === 'agent:turn_final') brief = `status=${p.status} diff="${p.diffSummary}" text=${String(p.text ?? '').slice(0, full ? 1200 : 200)}`;
    else if (t === 'agent:message_delta') brief = String(p.text ?? '').slice(0, 80);
    else if (t === 'patch') brief = `op=${p.patch?.op ?? p.patch?.type} ${JSON.stringify(p.patch ?? {}).slice(0, full ? 900 : 200)}`;
    else brief = JSON.stringify(p).slice(0, full ? 400 : 120);
  } catch { brief = '(unparsed)'; }
  console.log(`${String(r.seq).padStart(5)} ${t.padEnd(30)} ${brief}`);
}
console.log(`--- ${rows.length} rows ---`);
process.exit(0);
