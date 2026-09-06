// Dump the payloads of the auto-run verification journal to see exactly what
// the agent did (which tool, which patch op, which subagent, final message).
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const databaseUrl = process.env.DATABASE_URL ?? 'file:./db/custom.db';
const adapter = new PrismaLibSql({ url: databaseUrl });
const db = new PrismaClient({ adapter });

const which = process.argv[2] ?? 'auto';
const events = await db.agentEvent.findMany({
  where: { documentId: { startsWith: `verify-critique-${which}-` } },
  orderBy: { seq: 'asc' },
  take: 500,
});
console.log(`${which}-run events: ${events.length}`);
for (const e of events) {
  const p = (() => {
    try { return JSON.parse(e.payload ?? '{}'); } catch { return {}; }
  })();
  switch (e.type) {
    case 'agent:subagent_dispatch':
      console.log(`- subagent_dispatch: ${p.subAgentType} — ${p.task ?? ''}`);
      break;
    case 'agent:subagent_result':
      console.log(`- subagent_result: ${p.subAgentType} success=${p.success} — ${(p.summary ?? '').slice(0, 100)}`);
      break;
    case 'agent:tool_call_start':
      console.log(`- tool_call_start: ${p.name ?? p.toolName ?? '?'}`);
      break;
    case 'patch':
      console.log(`- patch: op=${p.patch?.op ?? p.op ?? '?'} nodes=${p.patch?.nodes?.length ?? p.nodes?.length ?? '?'} ids=${(p.patch?.ids ?? []).slice(0, 3).join(',')}`);
      break;
    case 'agent:tool_call_end':
      console.log(`- tool_call_end: ${p.name ?? p.toolName ?? '?'} success=${p.success ?? ''}`);
      break;
    case 'agent:message_end':
      if (p.text) console.log(`- message: ${String(p.text).slice(0, 220).replace(/\n/g, ' ')}`);
      break;
    case 'agent:critique':
      console.log(`- CRITIQUE iter=${p.iteration} defects=${(p.defects ?? []).length} textSeverity=${p.textSeverity}`);
      break;
    case 'agent:critique_skipped':
      console.log(`- CRITIQUE_SKIPPED ${p.reason}`);
      break;
    case 'agent:turn_final':
      console.log(`- turn_final: status=${p.status ?? ''} shapes=${p.shapeCount ?? ''}`);
      break;
    default:
      break;
  }
}
await db.$disconnect();
