// Poll the multi-shot visual test state: last run status, journal event
// counts, canvas shape count for the multishot-test document.
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const DOC = process.argv[2] || 'multishot-test';
const adapter = new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' });
const prisma = new PrismaClient({ adapter });

const shapeCount = await prisma.shape.count({ where: { documentId: DOC } });
const frames = await prisma.shape.findMany({
  where: { documentId: DOC, type: 'frame', parentId: null },
  select: { name: true, x: true, y: true, width: true, height: true },
  orderBy: { createdAt: 'asc' },
});

const runs = await prisma.sessionRun.findMany({
  where: { session: { documentId: DOC } },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { id: true, status: true, errorMessage: true, toolCalls: true, createdAt: true },
});

const historyRows = await prisma.agentEvent.findMany({
  where: { documentId: DOC, type: { in: ['agent:user_message', 'agent:turn_final'] } },
  orderBy: { seq: 'desc' },
  take: 12,
  select: { seq: true, type: true, payload: true, createdAt: true },
});

const msgs = await prisma.sessionMessage.findMany({
  where: { session: { documentId: DOC } },
  orderBy: { createdAt: 'asc' },
  take: 20,
  select: { role: true, status: true, error: true, content: true, createdAt: true },
});

console.log('=== RUNS (newest first) ===');
for (const r of runs) console.log(`${r.createdAt.toISOString()} ${r.status} tools=${r.toolCalls} ${r.errorMessage ? 'ERR: ' + r.errorMessage.slice(0, 120) : ''}`);

console.log(`\n=== CANVAS: ${shapeCount} shapes, ${frames.length} top-level frames ===`);
for (const f of frames) console.log(`  frame "${f.name}" @ (${f.x},${f.y}) ${f.width}x${f.height}`);

console.log('\n=== HISTORY (user_message / turn_final, newest first) ===');
for (const h of historyRows.slice(0, 8)) {
  const p = typeof h.payload === 'string' ? JSON.parse(h.payload) : h.payload;
  if (h.type === 'agent:user_message') {
    console.log(`seq=${h.seq} USER: ${String(p.text).slice(0, 90)}`);
  } else {
    console.log(`seq=${h.seq} FINAL (status=${p.status}, diff=${p.diffSummary ?? 'NONE'}): ${String(p.text).replace(/\s+/g, ' ').slice(0, 140)}`);
  }
}

console.log(`\n=== MESSAGES (${msgs.length}) ===`);
for (const m of msgs) {
  console.log(`${m.role} [${m.status}]${m.error ? ' ERR=' + m.error.slice(0, 80) : ''}: ${String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 130)}`);
}
await prisma.$disconnect();
