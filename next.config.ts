import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
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
