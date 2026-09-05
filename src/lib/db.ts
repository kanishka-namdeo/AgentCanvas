// Prisma client (regenerated via `bun run db:generate` / postinstall).
// If you see "Cannot find module '.prisma/client/default'" in dev.log,
// run `bun run db:generate` and restart the dev server — the runtime
// module cache holds the failed import until a rebuild is triggered.
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const databaseUrl = process.env.DATABASE_URL ?? "file:./db/custom.db";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  // Log hygiene: default to warn/error only. Unconditional
  // `log: ["query"]` floods stdout and taxes every statement with log
  // formatting in long-running processes; opt in per-environment via
  // DATABASE_LOG_QUERIES=1 when debugging SQL.
  const log: Array<"query" | "warn" | "error"> =
    process.env.DATABASE_LOG_QUERIES === "1"
      ? ["query", "warn", "error"]
      : ["warn", "error"];
  // Prisma 7 driver adapter: pass the libsql `Config` object directly.
  // See: https://pris.ly/d/prisma7-client-config
  const adapter = new PrismaLibSql({ url: databaseUrl });
  return new PrismaClient({
    log,
    adapter,
  } as ConstructorParameters<typeof PrismaClient>[0]);
}

// Singleton in ALL environments. Next.js compiles instrumentation.ts (the
// socket service) and each route handler into SEPARATE module graphs, so
// a module-level const is per-bundle; without the globalThis cache every
// bundle would construct its own client and connection pool. The old
// dev-only cache was a production gap — production builds got one client
// per bundle.
export const db = globalForPrisma.prisma ?? createPrismaClient();
globalForPrisma.prisma = db;

// SQLite tuning (fire-and-forget: a pragma failure must NEVER break boot —
// every call is .catch(() => {})-swallowed, matching the journal's
// error-swallowing style).
//   - journal_mode=WAL is PERSISTENT (stored in the DB file, survives this
//     process) and lets readers proceed while a writer holds the write
//     lock, instead of journal_mode=delete's whole-file lock — the #1
//     SQLite tuning step for multi-connection access.
//   - synchronous=NORMAL and busy_timeout=5000 are PER-CONNECTION (NOT
//     persisted — that's why they're re-applied on every client creation
//     here, and why a client created by another module graph won't inherit
//     them). NORMAL trades a tiny crash window for far fewer fsyncs under
//     WAL; busy_timeout makes SQLITE_BUSY wait up to 5s instead of failing
//     instantly when the dev server's sibling connections write.
// Guarded on "file:" so a future DATABASE_URL pointing at a non-SQLite
// database (e.g. postgres) never receives SQLite pragmas.
if (databaseUrl.startsWith("file:")) {
  db.$queryRawUnsafe("PRAGMA journal_mode=WAL").catch(() => {});
  db.$queryRawUnsafe("PRAGMA synchronous=NORMAL").catch(() => {});
  db.$queryRawUnsafe("PRAGMA busy_timeout=5000").catch(() => {});
}
