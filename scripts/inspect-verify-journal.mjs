// Inspect the AgentEvent journal for the two verification runs — confirms what
// actually happened inside the auto-mode control run (shapes drawn? critic
// gate decision?) without relying on the NDJSON shape counter.
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const databaseUrl = process.env.DATABASE_URL ?? 'file:./db/custom.db';
const adapter = new PrismaLibSql({ url: databaseUrl });
const db = new PrismaClient({ adapter });
const events = await db.agentEvent.findMany({
  where: { documentId: { startsWith: 'verify-critique-auto-' } },
  orderBy: { seq: 'asc' },
  take: 400,
});
console.log(`auto-run events: ${events.length}`);
const types = {};
for (const e of events) {
  types[e.type] = (types[e.type] ?? 0) + 1;
}
console.log('event type counts:', JSON.stringify(types, null, 0));
// Tool calls tell us whether the agent actually drew anything.
const toolCalls = events.filter((e) => e.type === 'tool_call_start').map((e) => {
  try { return JSON.parse(e.payload ?? '{}').name ?? e.payload?.slice(0, 60); } catch { return '?'; }
});
console.log('tool calls:', toolCalls.join(' | '));
const patches = events.filter((e) => e.type === 'canvas:patch');
console.log('patch events:', patches.length);
for (const p of patches.slice(0, 6)) {
  try {
    const payload = JSON.parse(p.payload ?? '{}');
    const op = payload.patch?.op ?? payload.op ?? '?';
    console.log('  patch op:', op, 'nodes:', payload.patch?.nodes?.length ?? payload.nodes?.length ?? '');
  } catch { console.log('  patch (unparsed)'); }
}
await db.$disconnect();
