// cleanup-orphan-sessions.ts — one-time data repair for the session-sync bug.
//
// Bug history: createServerSession() never passed the client's session id, so
// the server row got its own cuid while the client kept syncing runs/messages/
// snapshots against its localStorage id — every child write FK-failed, and the
// hydrate merge loop re-created a new server shell on every reload. Result:
// thousands of empty "Canvas · demo" Session rows with zero messages/runs/
// snapshots (2,733 at discovery time), all runs orphaned.
//
// This script deletes Session rows that have NO messages, NO runs, and NO
// snapshots (pure empty shells — safe to drop; the client recreates sessions
// on demand). Rows with any content are kept untouched.
//
// Run: bun run scripts/cleanup-orphan-sessions.ts [--dry-run]

import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const databaseUrl = process.env.DATABASE_URL ?? 'file:/home/z/my-project/db/custom.db';
const db = new PrismaClient({
  adapter: new PrismaLibSql({ url: databaseUrl }),
} as ConstructorParameters<typeof PrismaClient>[0]);

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const empty = await db.session.findMany({
    select: { id: true, title: true, createdAt: true },
    where: {
      messages: { none: {} },
      runs: { none: {} },
      snapshots: { none: {} },
    },
  });

  console.log(`Found ${empty.length} empty session shell(s).`);
  if (dryRun) {
    for (const s of empty.slice(0, 10)) console.log(`  [dry-run] would delete ${s.id} (${s.title})`);
    if (empty.length > 10) console.log(`  ... and ${empty.length - 10} more`);
    return;
  }

  // Delete in batches to avoid one giant IN (...) clause.
  const BATCH = 200;
  let deleted = 0;
  for (let i = 0; i < empty.length; i += BATCH) {
    const batch = empty.slice(i, i + BATCH);
    const res = await db.session.deleteMany({
      where: { id: { in: batch.map((s) => s.id) } },
    });
    deleted += res.count;
  }
  console.log(`Deleted ${deleted} empty session shell(s).`);

  const remaining = await db.session.count();
  console.log(`Remaining sessions: ${remaining}`);
}

main()
  .catch((err) => {
    console.error('cleanup failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
