// prisma.config.ts — Prisma 7+ configuration.
// In Prisma 7, the datasource `url` was removed from `schema.prisma`.
// Connection URLs and driver adapters are configured here instead.
// See: https://pris.ly/d/prisma7-client-config
import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(__dirname, "prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./db/custom.db",
  },
});
