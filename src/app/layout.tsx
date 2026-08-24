import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";

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
// lets the SVG ShapeRenderer pick it up via fontFamily="var(--font-inter)".
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "AgentCanvas — Figma for AI agents",
  description:
    "A Figma-like design canvas where the primary user is an AI agent (powered by the Pi Agent SDK). The agent sees the canvas state and manipulates it through tools.",
  keywords: ["Pi Agent SDK", "Figma", "AI agent", "canvas", "design tool", "Next.js"],
  authors: [{ name: "AgentCanvas" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
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
