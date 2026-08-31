import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const p = new PrismaClient({ adapter });
const evs = await p.agentEvent.findMany({ orderBy: { seq: 'asc' }, where: { type: 'agent:tool_call_end' } });
for (const e of evs) {
  const pl = JSON.parse(String(e.payload));
  if (pl.toolCallId?.includes('insert_html') || pl.toolCallId?.includes('create_node')) {
    console.log('=== ' + pl.toolCallId + ' ===');
    console.log(JSON.stringify(pl, null, 1).slice(0, 1500));
  }
}
await p.$disconnect();
