import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const p = new PrismaClient({ adapter });
const starts = await p.agentEvent.findMany({ orderBy: { seq: 'asc' }, where: { type: 'agent:tool_call_start' } });
const ends = await p.agentEvent.findMany({ orderBy: { seq: 'asc' }, where: { type: 'agent:tool_call_end' } });
const endMap = new Map(ends.map(e => [JSON.parse(String(e.payload)).toolCallId, JSON.parse(String(e.payload))]));
for (const s of starts) {
  const pl = JSON.parse(String(s.payload));
  const end = endMap.get(pl.toolCallId);
  console.log(s.createdAt?.toISOString().slice(11,19), pl.toolName.padEnd(24), end ? (end.success ? 'OK  ' : 'FAIL') + ' ' + (end.summary||'').slice(0,70).replace(/\n/g,' ') : '(no end)');
}
await p.$disconnect();
