// Phase C pre-flight: check the live journal for silent seq-collision drops.
//
// Hypothesis: Next.js compiles instrumentation.ts and route handlers into
// SEPARATE module graphs, so src/lib/agent/event-journal.ts has TWO runtime
// instances (one per bundle), each with its own seqCounters/writeChain.
// When both instances write to the same document without re-reading max(seq)
// in between, the (documentId, seq) unique index rejects one side and the
// writeChain silently swallows it — journal rows disappear with NO error and
// NO gap in the seq sequence (contiguity is preserved by the collision itself).
//
// Evidence query: per (documentId, clientId), MutationClock.lastMutationId
// counts every ACCEPTED user mutation; each accepted mutation journals
// exactly ONE 'user_patch' row. Any deficit in user_patch rows = dropped rows.
import { createClient } from '@libsql/client';

const db = createClient({ url: 'file:/home/z/my-project/db/custom.db' });

const clocks = await db.execute("SELECT documentId, clientId, lastMutationId FROM MutationClock");
const patches = await db.execute("SELECT documentId, COUNT(*) as n FROM AgentEvent WHERE type='user_patch' GROUP BY documentId");
const patchByDoc = new Map<string, number>(patches.rows.map(r => [String(r.documentId), Number(r.n)]));

console.log('=== MutationClock vs user_patch rows ===');
let mismatch = 0;
for (const row of clocks.rows) {
  const journaled = patchByDoc.get(String(row.documentId)) ?? 0;
  const clock = Number(row.lastMutationId);
  // user_patch rows for THIS clientId can't be split out cheaply; compare
  // per-document totals against the SUM of clocks per doc.
  console.log(`doc=${String(row.documentId).slice(0, 12)} client=${String(row.clientId).slice(0, 12)} clock=${clock} docUserPatchRows=${journaled}`);
  if (clock > journaled) mismatch++;
}

// per-document sum of clocks vs rows
const clockSum = new Map<string, number>();
for (const row of clocks.rows) {
  const d = String(row.documentId);
  clockSum.set(d, (clockSum.get(d) ?? 0) + Number(row.lastMutationId));
}
console.log('\n=== per-doc clock SUM vs user_patch count ===');
for (const [doc, sum] of clockSum) {
  const rows = patchByDoc.get(doc) ?? 0;
  const flag = sum > rows ? '  <-- DEFICIT (dropped rows!)' : '  ok';
  console.log(`doc=${doc.slice(0, 12)} clocksSum=${sum} userPatchRows=${rows}${flag}`);
}

// Also: verify seq contiguity per document (should be 1..max with no gaps —
// gaps would indicate a different failure mode: failed first-write).
console.log('\n=== seq contiguity per document ===');
const seqs = await db.execute("SELECT documentId, seq FROM AgentEvent ORDER BY documentId, seq");
const byDoc = new Map<string, number[]>();
for (const r of seqs.rows) {
  const d = String(r.documentId);
  if (!byDoc.has(d)) byDoc.set(d, []);
  byDoc.get(d)!.push(Number(r.seq));
}
for (const [doc, list] of byDoc) {
  const gaps: string[] = [];
  for (let i = 1; i < list.length; i++) {
    if (list[i] !== list[i - 1] + 1) gaps.push(`${list[i - 1]}->${list[i]}`);
  }
  console.log(`doc=${doc.slice(0, 12)} rows=${list.length} min=${list[0]} max=${list[list.length - 1]} gaps=${gaps.length ? gaps.slice(0, 5).join(',') : 'none'}`);
}

// Type histogram — what's actually in the journal.
console.log('\n=== type histogram ===');
const types = await db.execute("SELECT type, COUNT(*) as n FROM AgentEvent GROUP BY type ORDER BY n DESC");
for (const r of types.rows) console.log(`${String(r.type).padEnd(34)} ${r.n}`);
