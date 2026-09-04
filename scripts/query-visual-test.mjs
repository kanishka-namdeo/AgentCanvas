// Query recent agent run status + events for the visual-test session.
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const prisma = new PrismaClient({ adapter });

const runs = await prisma.sessionRun.findMany({
  orderBy: { createdAt: 'desc' },
  take: 3,
  select: { id: true, status: true, errorMessage: true, toolCalls: true, createdAt: true },
});
console.log('RUNS:', JSON.stringify(runs, null, 2));

const events = await prisma.agentEvent.findMany({
  orderBy: { seq: 'desc' },
  take: 400,
  select: { type: true },
});
const counts = {};
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
console.log('EVENT COUNTS (last 400):', JSON.stringify(counts, null, 2));

const msgs = await prisma.sessionMessage.findMany({
  orderBy: { createdAt: 'desc' },
  take: 2,
  select: { role: true, status: true, error: true, content: true },
});
for (const m of msgs) {
  console.log('MSG:', m.role, m.status, m.error ?? '', (m.content ?? '').slice(0, 500));
}
await prisma.$disconnect();
