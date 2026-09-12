import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import { ScrollProgress } from '@/components/ui/scroll-progress';
import { SmoothScroll } from '@/components/landing/SmoothScroll';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { LandingFooter } from '@/components/landing/LandingFooter';
import { Hero } from '@/components/landing/Hero';

// Below-fold sections are lazy (spec §8: hero + header in the initial
// bundle). This file is a SERVER component, so `ssr: false` is not allowed —
// dynamic() keeps its default SSR (better for content) and still splits the
// chunks. The loading skeleton reserves rough height to avoid CLS on slow
// connections when a user deep-scrolls before the chunk lands.

function SectionSkeleton() {
  return <div aria-hidden="true" className="min-h-[60vh]" />;
}

const MagicSequence = dynamic(
  () => import('@/components/landing/MagicSequence').then((m) => m.MagicSequence),
  { loading: SectionSkeleton },
);
const FeatureGallery = dynamic(
  () => import('@/components/landing/FeatureGallery').then((m) => m.FeatureGallery),
  { loading: SectionSkeleton },
);
const TrustLoop = dynamic(
  () => import('@/components/landing/TrustLoop').then((m) => m.TrustLoop),
  { loading: SectionSkeleton },
);
const HowItWorks = dynamic(
  () => import('@/components/landing/HowItWorks').then((m) => m.HowItWorks),
  { loading: SectionSkeleton },
);
const OpenSourceFinale = dynamic(
  () => import('@/components/landing/OpenSourceFinale').then((m) => m.OpenSourceFinale),
  { loading: SectionSkeleton },
);

export const metadata: Metadata = {
  title: 'AgentCanvas — Figma for AI agents',
  description:
    'The open-source canvas where AI agents do the drawing and you direct. 60+ typed tools, human-approved destructive steps, 28 LLM providers — AGPL-3.0 and free forever.',
  keywords: ['AgentCanvas', 'AI agents', 'design canvas', 'Figma', 'open source', 'AGPL-3.0'],
  twitter: {
    card: 'summary_large_image',
    title: 'AgentCanvas — Figma for AI agents',
    description:
      'The open-source canvas where AI agents do the drawing and you direct.',
  },
};

/** The landing page owns `/` (spec §3). Single scroll narrative:
 * hero → magic → tool → trust → how-it-works → open-source finale.
 * The `.dark` class on the root forces the dark token subtree regardless of
 * the visitor's workspace theme preference (spec §9 — the landing is the
 * movie trailer; the light workspace is the product). */
export default function LandingPage() {
  return (
    <div data-testid="landing-root" className="dark min-h-screen bg-background text-foreground">
      <SmoothScroll>
        <ScrollProgress className="fixed top-0 z-50" />
        <LandingHeader />
        <main>
          <Hero />
          <MagicSequence />
          <FeatureGallery />
          <TrustLoop />
          <HowItWorks />
          <OpenSourceFinale />
        </main>
        <LandingFooter />
      </SmoothScroll>
    </div>
  );
}
