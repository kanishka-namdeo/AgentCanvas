import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
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
