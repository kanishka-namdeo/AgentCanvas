// migrate-snapshots-to-doc.ts — one-shot backfill for the shared-canvas model.
//
// Copies every legacy `SessionSnapshot` row (session-owned, pre-shared-canvas)
// into the new `DocumentSnapshot` table (document-owned, with sessionId /
// messageId / runId provenance). The owning documentId is resolved by joining
// the legacy row's sessionId to the Session table.
//
// Idempotent: rows whose id already exists in DocumentSnapshot are skipped, so
// re-running is safe. Run BEFORE the SessionSnapshot table is dropped (the
// schema keeps the legacy model during the migration window — see
// prisma/schema.prisma).
//
// Usage: bun run scripts/migrate-snapshots-to-doc.ts

import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const databaseUrl = process.env.DATABASE_URL ?? "file:./db/custom.db";

const prisma = new PrismaClient({
  adapter: new PrismaLibSql({ url: databaseUrl }),
} as ConstructorParameters<typeof PrismaClient>[0]);

async function main() {
  // Legacy rows + their owning session's documentId (raw SQL join — the
  // legacy model has no relation in the current schema).
  const legacyRows = await prisma.$queryRaw<
    Array<{
      id: string;
      sessionId: string;
      document: string;
      source: string;
      runId: string | null;
      createdAt: Date;
      documentId: string | null;
    }>
  >`
    SELECT ss.id, ss."sessionId", ss.document, ss.source, ss."runId", ss."createdAt", s."documentId"
    FROM "SessionSnapshot" ss
    LEFT JOIN "Session" s ON s.id = ss."sessionId"
  `;

  if (legacyRows.length === 0) {
    console.log("[migrate-snapshots-to-doc] no legacy SessionSnapshot rows — nothing to do.");
    return;
  }

  const existing = await prisma.documentSnapshot.findMany({
    where: { id: { in: legacyRows.map((r) => r.id) } },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((row) => row.id));

  let migrated = 0;
  let skipped = 0;
  let orphaned = 0;
  for (const row of legacyRows) {
    if (existingIds.has(row.id)) {
      skipped++;
      continue;
    }
    if (!row.documentId) {
      // Owning session row is gone — attribute to the fallback demo document
      // so the capture is never silently lost.
      orphaned++;
    }
    await prisma.documentSnapshot.create({
      data: {
        id: row.id,
        documentId: row.documentId ?? "demo",
        sessionId: row.sessionId,
        messageId: null,
        runId: row.runId,
        document: row.document,
        source: row.source,
        nodeCount: 0,
        label: null,
        bookmarked: false,
        createdAt: row.createdAt,
      },
    });
    migrated++;
  }

  console.log(
    `[migrate-snapshots-to-doc] legacy=${legacyRows.length} migrated=${migrated} skipped(already-present)=${skipped} orphaned(no-owner-session)=${orphaned}`,
  );
}

main()
  .catch((err) => {
    console.error("[migrate-snapshots-to-doc] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
