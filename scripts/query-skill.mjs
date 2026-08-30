import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const p = new PrismaClient({ adapter });
const evs = await p.agentEvent.findMany({ orderBy: { seq: 'desc' }, where: { type: { contains: 'skill' } }, take: 6 });
for (const e of evs) console.log(e.createdAt?.toISOString().slice(11,19), e.type, String(e.payload).slice(0,400).replace(/\n/g,' '));
const cls = await p.agentEvent.findMany({ orderBy: { seq: 'desc' }, where: { type: { contains: 'classif' } }, take: 4 });
for (const e of cls) console.log(e.createdAt?.toISOString().slice(11,19), e.type, String(e.payload).slice(0,500).replace(/\n/g,' '));
await p.$disconnect();
