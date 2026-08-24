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
  // Prisma 7 driver adapter: pass the libsql `Config` object directly.
  // See: https://pris.ly/d/prisma7-client-config
  const adapter = new PrismaLibSql({ url: databaseUrl });
  return new PrismaClient({
    log: ["query"],
    adapter,
  } as ConstructorParameters<typeof PrismaClient>[0]);
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
