// Vitest stub for stylesheets imported by tested components (e.g.
// 'lenis/dist/lenis.css' in src/components/landing/SmoothScroll.tsx).
// jsdom applies no styles, so the real CSS is irrelevant under test — and
// routing it through vite:css would drag the Next/Tailwind PostCSS config
// into the vitest transform pipeline, which fails to load there.
export {};
