'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useLenis } from 'lenis/react';
import { Star } from 'lucide-react';
import { REPO_URL } from './repo-url';
import { GitHubStars, hasStars } from './GitHubStars';

/** The five below-hero narrative beats — header anchors must match the
 * section ids rendered by the section components (spec §5.7). */
export const LANDING_SECTIONS = [
  { id: 'magic', label: 'The Magic' },
  { id: 'tool', label: 'The Tool' },
  { id: 'trust', label: 'Trust' },
  { id: 'how-it-works', label: 'How It Works' },
  { id: 'open-source', label: 'Open Source' },
] as const;

/** Landing header (spec §5.7, upgraded in the 2026-09-19 uplift): fixed over
 * the hero (transparent), picking up a blurred dark surface + hairline border
 * once the visitor scrolls past the hero, so the anchor nav + CTAs stay
 * available for the rest of the arc. Anchor clicks scroll via lenis with NO
 * manual offset — sections own their breathing room through `scroll-mt-20`
 * (lenis honors scroll-margin; the old `offset: -72` double-compensated and
 * landed links 152px low). Under prefers-reduced-motion no provider exists,
 * useLenis() returns null, and clicks fall through to native anchor
 * scrolling — which resolves the same scroll-mt-20, so both paths land
 * identically. */
export function LandingHeader({ stars }: { stars?: number | null }) {
  const lenis = useLenis();
  const [scrolled, setScrolled] = useState(false);

  // Plain window scroll listener (not a lenis callback) so the surface swap
  // also works under reduced motion, where no lenis provider is mounted.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight * 0.6);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleAnchorClick = (event: React.MouseEvent<HTMLAnchorElement>, hash: string) => {
    if (!lenis) return; // reduced motion → native anchor scroll
    event.preventDefault();
    lenis.scrollTo(hash);
  };

  return (
    <header
      data-testid="landing-header"
      data-scrolled={scrolled ? 'true' : 'false'}
      className={`fixed inset-x-0 top-0 z-40 transition-colors duration-300 ${
        scrolled ? 'border-b border-white/10 bg-background/70 backdrop-blur-md' : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2" aria-label="AgentCanvas home">
          <Image src="/logo.svg" alt="AgentCanvas logo" width={24} height={24} sizes="24px" />
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
            {hasStars(stars) ? <GitHubStars stars={stars} /> : 'Star'}
          </a>
          <Link
            href="/app"
            data-testid="header-open"
            className="ac-brand-gradient ac-cta-gradient inline-flex items-center rounded-full px-4 py-1.5 text-xs font-semibold text-white shadow-lg"
          >
            Open the canvas
          </Link>
        </div>
      </div>
    </header>
  );
}
