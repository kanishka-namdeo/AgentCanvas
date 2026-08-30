import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const p = new PrismaClient({ adapter });
const evs = await p.agentEvent.findMany({ orderBy: { seq: 'asc' }, where: { type: 'agent:tool_call_start' }, take: 200, select: { toolCallId: true, payload: true, createdAt: true } });
for (const e of evs) { const t = JSON.parse(String(e.payload)).toolName; console.log(e.createdAt?.toISOString().slice(11,19), t); }
const docs = await p.document.findMany({ select: { id: true, name: true, version: true, updatedAt: true } });
for (const d of docs) console.log('DOC', d.id, d.name, 'v'+d.version, d.updatedAt?.toISOString().slice(11,19));
await p.$disconnect();
