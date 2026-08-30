// Query the journal for plan events + pending plan resolution state.
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const events = await p.agentEvent.findMany({
    where: { type: { contains: 'plan' } },
    orderBy: { seq: 'desc' },
    take: 5,
  });
  for (const e of events) {
    console.log(e.seq, e.type, JSON.stringify(e.payload).slice(0, 300));
  }
  await p.$disconnect();
}

main().catch((e) => { console.error('ERR', e.message.slice(0, 300)); process.exit(1); });
