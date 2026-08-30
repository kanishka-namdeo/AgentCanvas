import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const p = new PrismaClient({ adapter });
const evs = await p.agentEvent.findMany({ orderBy: { seq: 'desc' }, take: 25 });
for (const e of evs) console.log(e.createdAt?.toISOString().slice(11,19), e.type, String(e.payload).slice(0,90).replace(/\n/g,' '));
await p.$disconnect();
