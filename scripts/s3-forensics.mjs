// S3 stress-test forensics (v2): turn boundaries = agent:user_message.
// Verifies (a) mode per turn, (b) critique gating decisions, (c) patch/tool
// counts per turn (25 → 27 → 27 = incremental refinement, no rebuilds).
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const db = new PrismaClient({ adapter: new PrismaLibSql({ url: 'file:/home/z/my-project/db/custom.db' }) });

function payload(ev) {
  return typeof ev.payload === 'string' ? JSON.parse(ev.payload) : (ev.payload ?? {});
}

async function main() {
  const events = await db.agentEvent.findMany({
    where: { documentId: 'demo' },
    orderBy: { seq: 'asc' },
  });

  const turns = [];
  let cur = null;
  for (const ev of events) {
    const p = payload(ev);
    if (ev.type === 'agent:user_message') {
      cur = {
        seq: ev.seq,
        at: ev.createdAt?.toISOString?.() ?? String(ev.createdAt),
        mode: p.mode ?? '(none)',
        prompt: (p.prompt ?? p.text ?? '').slice(0, 55),
        patches: 0,
        toolCalls: 0,
        critiqueEvents: [],
        errors: 0,
      };
      turns.push(cur);
    } else if (!cur) {
      continue;
    } else if (ev.type === 'patch') {
      cur.patches += 1;
    } else if (ev.type === 'agent:tool_call_start') {
      cur.toolCalls += 1;
    } else if (ev.type === 'agent:critique') {
      cur.critiqueEvents.push({ phase: p.phase ?? p.kind ?? '?', defects: (p.defects ?? p.findings ?? []).length ?? p.defects });
    } else if (ev.type === 'agent:critique_skipped') {
      cur.critiqueEvents.push({ skipped: true, reason: p.reason, savedLlmCalls: p.savedLlmCalls });
    } else if (ev.type === 'agent:error') {
      cur.errors += 1;
    }
  }
  for (const t of turns) {
    console.log(
      `seq=${t.seq} mode=${t.mode} patches=${t.patches} tools=${t.toolCalls} errors=${t.errors} critique=${JSON.stringify(t.critiqueEvents)} :: ${t.prompt}`,
    );
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
