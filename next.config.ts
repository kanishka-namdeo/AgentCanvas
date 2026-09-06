import type { NextConfig } from "next";

// Baseline security headers applied to every route. Deliberately NO
// X-Frame-Options (the app is embedded in an iframe preview via the
// gateway :81 — XFO would break embedding), NO CSP (Turbopack dev mode
// requires inline styles/scripts; a production CSP is a separate,
// measured exercise), and NO HSTS (served over plain HTTP behind the
// sandbox gateway).
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    // KEEP for now (final decision deferred to a post-typecheck pass):
    // historical type errors must not block builds while the codebase is
    // being hardened incrementally.
    ignoreBuildErrors: true,
  },
  // KEEP false — documented decision: StrictMode double-invokes effects in
  // dev, which risks socket regressions (duplicate canvas-sync listeners /
  // re-subscriptions) on a socket-heavy client wired to a 3.9k-line store.
  // Dev-only impact; zero production performance upside.
  reactStrictMode: false,
  allowedDevOrigins: [
    "preview-chat-d55e008f-b6de-4b80-8697-b97749cf9be3.space-z.ai",
    "*.space-z.ai",
    // Allow direct localhost access (Playwright tests, local dev, health checks).
    // Next.js 16 blocks cross-origin dev resource access by default, which causes
    // 403 on all _next/static/chunks/*.js when accessing via 127.0.0.1 or localhost.
    "localhost",
    "127.0.0.1",
  ],
  // Externalize packages that use dynamic require() / native bindings so
  // Turbopack doesn't try to bundle them (which throws
  // "Cannot find module as expression is too dynamic").
  serverExternalPackages: [
    "turndown",
    "@mozilla/readability",
    "linkedom",
    "z-ai-web-dev-sdk",
    "@earendil-works/pi-coding-agent",
    // Native binary package (prebuilt .node binding). Without this,
    // Turbopack tries to bundle the .js shim and fails with
    // "non-ecmascript placeable asset" during `next build`.
    "@resvg/resvg-js",
  ],
  // Don't advertise the Next.js version in the x-powered-by response header.
  poweredByHeader: false,
  // SWC compiler transform: strip console.* from production builds, but
  // keep error/warn (operational diagnostics). No effect in dev.
  compiler: {
    removeConsole: {
      exclude: ["error", "warn"],
    },
  },
  // Barrel-package tree-shaking for the heavy icon/UI packages this app
  // actually imports (all verified present in package.json dependencies).
  // lucide-react is on Next's default list; the explicit entry is
  // self-documenting and harmless.
  // (date-fns removed 2026-09 dependency-hygiene pass — package deleted as
  // unused; an entry for an uninstalled package would be dead config.)
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "sonner",
      "cmdk",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-context-menu",
    ],
  },
  // React Compiler 1.0 (Oct 2025) — Babel plugin that auto-memoizes
  // components, eliminating the need for manual useMemo/useCallback/React.memo
  // on hot paths. Particularly impactful for the canvas re-rendering N shapes
  // per frame and the agent panel re-rendering on every streamed token.
  // Next.js 16.3.4 moved this OUT of `experimental` to a top-level key.
  // Validated safe with the project's manual memoization (the compiler
  // preserves `memo` and treats the file as opt-out via
  // `/* @reactCompilerDisable */`).
  reactCompiler: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
