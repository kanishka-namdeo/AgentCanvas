import type { Config } from "tailwindcss";

// Tailwind v4 reads its config from CSS — see `src/app/globals.css` for the
// authoritative `@theme inline` block (color tokens, border radius, fonts)
// and the `@custom-variant dark (&:where(.dark, .dark *))` declaration
// (the v4 way to enable class-based dark mode — replaces the legacy
// `darkMode: "class"` JS config).
//
// This file is kept as a minimal stub for any third-party packages that
// probe `tailwind.config.ts` directly (e.g. some shadcn/ui CLIs). It is NOT
// loaded by the Tailwind v4 PostCSS plugin — `@tailwindcss/postcss` reads
// only `globals.css`.
//
// Animation utilities live in `tw-animate-css` (imported in `globals.css`),
// which is the Tailwind v4 successor to `tailwindcss-animate`. The legacy
// `tailwindcss-animate` package was removed from `package.json` in the
// 2026-09 cleanup pass — it duplicated `tw-animate-css` and its `plugins`
// registration here was dead config under v4.
const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
};
export default config;
