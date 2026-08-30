import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const p = new PrismaClient({ adapter });
const evs = await p.agentEvent.findMany({ orderBy: { seq: 'asc' }, where: { type: 'agent:tool_call_end' }, take: 50 });
for (const e of evs) {
  const pl = JSON.parse(String(e.payload));
  console.log(e.createdAt?.toISOString().slice(11,19), pl.toolCallId?.replace('functions.',''), 'success:'+pl.success, (pl.summary||'').slice(0,160));
}
await p.$disconnect();
