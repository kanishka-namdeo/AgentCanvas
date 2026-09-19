import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { SITE_URL } from "@/components/landing/repo-url";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Inter is the typeface the AI agent's system prompt instructs it to use for
// all canvas text layers ("Font: Inter / system-ui sans-serif" in
// SYSTEM_PROMPT_TEMPLATE). Without it loaded, every <text> element in the SVG
// canvas falls back to the OS default sans-serif (San Francisco on macOS,
// Segoe UI on Windows) — inconsistent with the app chrome (Geist) and never
// the designer-grade font the prompt promised. Exposing it as --font-inter
// lets the DOM renderer's styleFor.ts pick it up via fontFamily referencing
// var(--font-inter).
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  // metadataBase (2026-09-19 landing-uplift P0): without it, OG/Twitter image
  // URLs resolve against the request host — behind a proxy or on localhost
  // they render as `http://localhost:…/opengraph-image` and share previews
  // break. NEXT_PUBLIC_SITE_URL can override for a future real domain.
  metadataBase: new URL(SITE_URL),
  title: "AgentCanvas — Figma for AI agents",
  description:
    "A Figma-like design canvas where the primary user is an AI agent (powered by the Pi Agent SDK). The agent sees the canvas state and manipulates it through tools.",
  keywords: ["Pi Agent SDK", "Figma", "AI agent", "canvas", "design tool", "Next.js"],
  authors: [{ name: "AgentCanvas" }],
  // Favicons come from the file conventions (src/app/icon.svg +
  // src/app/apple-icon.png, both generated from public/logo.svg) — an
  // explicit `icons` entry here would override those conventions.
};

// Mobile browser chrome follows the landing's dark ground (audit #15).
export const viewport: Viewport = {
  themeColor: "#0a0a0f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* UI-audit round 6 (2026-09 dark-mode FOUC fix): inline blocking
            script that reads the persisted theme preference from localStorage
            + the OS prefers-color-scheme + applies the .dark class to
            <html> BEFORE the body paints. Eliminates the white flash
            dark-mode users saw on every page load (the previous ThemeToggle
            useEffect ran AFTER first paint). Mirrors the next-themes /
            shadcn color-scheme script pattern. */}
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var raw=localStorage.getItem('agentcanvas.settings.v1');var t=raw&&JSON.parse(raw)&&JSON.parse(raw).state&&JSON.parse(raw).state.themePreference;if(!t){t=localStorage.getItem('agentcanvas-theme');}var dark=t==='dark'||((t==='system'||!t)&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(dark){document.documentElement.classList.add('dark');}}catch(e){}})();` }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
        {/* Sonner Toaster — the shadcn <Toaster /> above only renders useToast() hook
            toasts. Many components across the app call `toast()` from the `sonner`
            package directly (TopMenuBar, AgentPanel, LayersPanel, SettingsDialog, etc.).
            Without this <SonnerToaster /> mounted, all those toast() calls were
            silently dropped — users saw no feedback for export, copy, errors, etc. */}
        <SonnerToaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
