import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
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
  ],
};

export default nextConfig;
