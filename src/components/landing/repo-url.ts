// The canonical repo URL — single source of truth (spec §3).
// Git remote is ground truth. The repo was renamed co-canvas → AgentCanvas
// (the old URL 301s to this one) — always link the canonical name so the
// clone command and every GitHub link state the repo's real name.

export const REPO_URL = "https://github.com/kanishka-namdeo/AgentCanvas";

export const REPO_CLONE_URL = `${REPO_URL}.git`;

// The absolute base URL metadata (canonical / og:url / og:image / sitemap)
// resolves against. NEXT_PUBLIC_SITE_URL overrides for a future real domain;
// the default is the z.ai sandbox preview host (the URL users actually see
// the app on today — from `allowedDevOrigins` in next.config.ts), so share
// previews resolve absolutely instead of against localhost.
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  "https://preview-chat-d55e008f-b6de-4b80-8697-b97749cf9be3.space-z.ai";
