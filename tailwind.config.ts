import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

// Note: In Tailwind v4, color tokens are defined in `src/app/globals.css`
// via the `@theme inline` block. The legacy `colors` section below is kept
// only for backwards compatibility with any third-party packages that read
// `tailwind.config.ts` directly. Tailwind v4 itself does not load these —
// all real color tokens come from CSS variables in globals.css.
const config: Config = {
    darkMode: "class",
    content: [
        "./pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./components/**/*.{js,ts,jsx,tsx,mdx}",
        "./app/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            borderRadius: {
                lg: 'var(--radius)',
                md: 'calc(var(--radius) - 2px)',
                sm: 'calc(var(--radius) - 4px)'
            }
        }
  },
  plugins: [tailwindcssAnimate],
};
export default config;
