# Framework Best-Practices Research → AgentCanvas Optimization Plan

Synthesized from 17 web-search result sets (raw JSON in this directory) plus two
full codebase reconnaissance passes. Sources include nextjs.org production
guides, prisma.io query-optimization docs, socket.io performance-tuning docs,
tailwindcss.com v4 docs, zustand docs, powersync.com SQLite tuning, and
community best-practice guides (2025–2026).

## Next.js 16 (App Router, Turbopack, standalone)

- **Code splitting**: `next/dynamic` for rarely-used/heavy components; keep
  `ssr: false` for browser-only client components (nextjs.org Lazy Loading
  guide). Dialog-gated components that are statically imported are free wins.
- **`optimizePackageImports`**: accelerates barrel-package tree-shaking
  (lucide-react is on Next 16's default list; explicit entries are harmless and
  self-documenting).
- **Security headers** via `headers()`: X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy. Avoid X-Frame-Options/CSP here — the app
  is embedded in an iframe preview (gateway `:81`) and dev-mode requires inline
  styles/scripts.
- **`poweredByHeader: false`**, `compiler.removeConsole` (exclude error/warn)
  for production builds.
- **reactStrictMode**: recommended generally, but double-invoked effects risk
  regressions in a socket-heavy client on a 3.9k-line store — defer (documented
  decision, dev-only impact, zero production perf upside).

## React 19

- Targeted `React.memo` on list rows still valid; avoid blanket memoization
  (2025+ consensus: measure first). Rows in LayersPanel/SessionSidebar/
  RunHistoryPanel re-render on every store flush — hotspot confirmed by recon.
- React Compiler is the modern answer but experimental on this codebase — skip.
- Memoize expensive markdown renders (ai-sdk.dev recipe; repo already memo's
  `MarkdownMessage` — keep, verify).

## Prisma 7 + SQLite

- **Singleton in ALL environments** (globalThis cache; not just dev) — long
  running processes must share one client (production gap confirmed in db.ts).
- **Log levels**: `log: ['query']` unconditionally is an anti-pattern; default
  to `['warn','error']`, opt into query logging via env.
- **Strategic indexing** (prisma.io + SQLite guides): composite indexes
  matching exact query shapes — equality columns first, sort column last
  (e.g. `[sessionId, createdAt]`, `[documentId, lastOpenedAt]`). Don't index
  everything; every index taxes writes.
- **SQLite WAL** + reduced synchronous flushing is the #1 SQLite tuning step
  (powersync.com): `PRAGMA journal_mode=WAL` is persistent and safe for
  multi-connection access. Wrap sequential writes into transactions where
  possible.
- LIKE '%q%' search can never use an index (full scan) — accepted, already
  capped by the repo.

## Socket.io

- Batch messages (repo already bursts fanout every 16ms — confirmed good
  practice per socket.io perf docs). Document-scoped broadcasts (no io.emit) —
  already correct. No changes needed.

## Tailwind CSS 4

- v4 CSS-first engine with automatic content detection; `@source` pinning in
  globals.css is already correct. Legacy `tailwind.config.ts` kept only for
  third-party tooling — correct. No changes needed.

## Zustand 5

- **Selectors**: never subscribe to whole store (`useSettings()` in
  SettingsDialog — confirmed antipattern). Slice exactly what a component
  needs; `useShallow` for multi-value/object slices.
- 100+ call sites already use fine-grained selectors — only fix the outliers.

## Dependencies

- Removing verified-unused packages cuts install time, node_modules size, and
  supply-chain surface (dead code doesn't enter the bundle, but dead deps
  still get installed/audited).
- Duplicate version ranges in deps + devDeps for the same package (pi-mcp-adapter,
  pi-background-tasks) are a hygiene bug — keep one, take the higher range.

## Applied workstreams

1. **A — Frontend**: next.config (headers, optimizePackageImports,
   removeConsole, poweredByHeader), next/dynamic splitting of dialog-gated
   heavy components, selector fixes, row memoization, local favicon,
   dev-only `window.__canvasStore`.
2. **B — Data layer**: composite indexes, all-env Prisma singleton, log-level
   hygiene, SQLite WAL + busy_timeout, journal head-seq caching, dead debug
   export removal, drop always-zero `_count` subselects (after verifying no
   client usage).
3. **C — Hygiene**: remove verified-unused deps + their dead ui/ files, dedupe
   dev/deps version conflicts, refresh lockfile.

Not done (deliberate): DocumentSnapshot retention policy (product decision),
FTS5 search (over-engineering for current scale), React Compiler (experimental),
reactStrictMode flip (dev-behavior risk), pagination contract changes on
session APIs (would change client API shape).
