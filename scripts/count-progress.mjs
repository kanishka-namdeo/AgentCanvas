import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const p = new PrismaClient({ adapter });
const c = await p.agentEvent.count({ where: { type: 'agent:tool_progress' } });
const recent = await p.agentEvent.findMany({ where: { type: 'agent:tool_progress' }, orderBy: { seq: 'desc' }, take: 2 });
for (const r of recent) console.log(r.createdAt?.toISOString().slice(11,19), String(r.payload).slice(0,120));
console.log('total tool_progress events:', c);
await p.$disconnect();
