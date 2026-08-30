import { db as prisma } from '../src/lib/db';
async function main() {
  const events = await (prisma as any).agentEvent.findMany({
    where: { seq: { in: [338, 344] } },
    orderBy: { seq: 'asc' },
  });
  for (const e of events) {
    console.log('=== seq', e.seq, e.type, '===');
    console.log(String(JSON.stringify(e.payload)).slice(0, 700));
  }
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message.slice(0, 300)); process.exit(1); });
