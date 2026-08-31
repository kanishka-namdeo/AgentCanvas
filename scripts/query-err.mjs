import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const p = new PrismaClient({ adapter });
const evs = await p.agentEvent.findMany({ orderBy: { seq: 'desc' }, take: 40 });
for (const e of evs) {
  const t = e.type;
  if (t.startsWith('agent:tool') || t === 'patch') continue;
  console.log(e.createdAt?.toISOString().slice(11,19), t, String(e.payload).slice(0,180).replace(/\n/g,' '));
}
await p.$disconnect();
