// Query the agent journal for the depth-research visual-test session:
// critique results, contrast_failure warnings, and edit-scoping evidence.
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const db = new PrismaClient({ adapter });

const docId = process.argv[2] ?? 'demo';
const events = await db.agentEvent.findMany({
  where: { documentId: docId },
  orderBy: { seq: 'asc' },
  take: 400,
});

let critiques = [];
let warnings = [];
let turnSummaries = [];
for (const e of events) {
  const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
  if (!p) continue;
  const s = JSON.stringify(p);
  if (e.type === 'agent:critique') {
    critiques.push({ seq: e.seq, score: p.score ?? p.overall_score, severity: p.severity, summary: (p.summary ?? p.topFixes ?? s).toString().slice(0, 300) });
  }
  if (s.includes('contrast_failure') || s.includes('hug_fill_conflict') || s.includes('fill_without_parent')) {
    const m = s.match(/"[^"]*contrast_failure[^"]*"[^}]*"message":"([^"]{0,220})/);
    warnings.push({ seq: e.seq, type: e.type, msg: m ? m[1].slice(0, 200) : s.slice(0, 150) });
  }
  if (e.type === 'agent:turn_final') {
    turnSummaries.push({ seq: e.seq, text: (p.text ?? '').slice(0, 400), status: p.status });
  }
}

console.log('=== CRITIQUES ===');
for (const c of critiques) console.log(`seq=${c.seq} score=${c.score} sev=${c.severity}\n  ${c.summary}`);
console.log('\n=== CONTRAST/SIZING WARNINGS in tool results ===');
for (const w of warnings) console.log(`seq=${w.seq} (${w.type}): ${w.msg}`);
console.log(`\n(warning mentions: ${warnings.length})`);
console.log('\n=== TURN SUMMARIES ===');
for (const t of turnSummaries) console.log(`seq=${t.seq} [${t.status}] ${t.text.replace(/\n/g, ' ').slice(0, 350)}`);
await db.$disconnect();
