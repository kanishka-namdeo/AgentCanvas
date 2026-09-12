'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useLenis } from 'lenis/react';
import { Star } from 'lucide-react';
import { REPO_URL } from './repo-url';

/** The five below-hero narrative beats — header anchors must match the
 * section ids rendered by the section components (spec §5.7). */
export const LANDING_SECTIONS = [
  { id: 'magic', label: 'The Magic' },
  { id: 'tool', label: 'The Tool' },
  { id: 'trust', label: 'Trust' },
  { id: 'how-it-works', label: 'How It Works' },
  { id: 'open-source', label: 'Open Source' },
] as const;

/** Fixed/absolute header over the hero (spec §5.7). Smooth anchor scrolling
 * goes through lenis when it is active; under prefers-reduced-motion no
 * provider exists, useLenis() returns null, and clicks fall through to
 * native anchor scrolling. */
export function LandingHeader() {
  const lenis = useLenis();

  const handleAnchorClick = (event: React.MouseEvent<HTMLAnchorElement>, hash: string) => {
    if (!lenis) return; // reduced motion → native anchor scroll
    event.preventDefault();
    lenis.scrollTo(hash, { offset: -72 });
  };

  return (
    <header data-testid="landing-header" className="absolute inset-x-0 top-0 z-40">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2" aria-label="AgentCanvas home">
          <Image src="/logo.svg" alt="AgentCanvas logo" width={24} height={24} />
          <span className="text-sm font-semibold text-white">AgentCanvas</span>
        </Link>

        <nav aria-label="Landing sections" className="hidden items-center gap-6 md:flex">
          {LANDING_SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              onClick={(event) => handleAnchorClick(event, `#${section.id}`)}
              className="text-sm text-white/70 transition-colors hover:text-white"
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="header-star"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-3 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10"
          >
            <Star className="h-3.5 w-3.5" aria-hidden="true" />
            Star
          </a>
          <Link
            href="/app"
            data-testid="header-open"
            className="ac-brand-gradient inline-flex items-center rounded-full px-4 py-1.5 text-xs font-semibold text-white shadow-lg"
          >
            Open the canvas
          </Link>
        </div>
      </div>
    </header>
  );
}
