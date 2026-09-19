'use client';

// The composed section tree (2026-09-19 landing uplift). Every section is a
// client component, so the tree lives on the client side of the SmoothScroll
// boundary. The GitHub proof numbers arrive as a PROMISE started by the
// server (`src/app/page.tsx` — ISR-cached, so it resolves with the RSC
// payload without a client round trip) and are unwrapped here.
//
// Why not `use()`: an async component is invalid inside a client tree, and
// React 19's `use()` reads a thenable by suspending until the boundary
// retries — which this project's test renderer (vitest + jsdom + RTL) never
// does, so the whole tree stayed stuck on the Suspense fallback in unit
// tests. Resolving the promise into state keeps one code path for SSR,
// hydration and tests: the first paint renders without proof numbers, and
// they appear the moment the promise settles (milliseconds later, from the
// streamed payload). A failed fetch leaves `null` and every star segment
// degrades to nothing (see GitHubStars).

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { GitHubStats } from './GitHubStars';
import { LandingHeader } from './LandingHeader';
import { LandingFooter } from './LandingFooter';
import { Hero } from './Hero';

// Below-fold sections are lazy (spec §8: hero + header in the initial
// bundle). The loading skeleton reserves rough height to avoid CLS on slow
// connections when a user deep-scrolls before the chunk lands.
function SectionSkeleton() {
  return <div aria-hidden="true" className="min-h-[60vh]" />;
}

const MagicSequence = dynamic(
  () => import('./MagicSequence').then((m) => m.MagicSequence),
  { loading: SectionSkeleton },
);
const ScrollCanvas = dynamic(
  () => import('./ScrollCanvas').then((m) => m.ScrollCanvas),
  { loading: SectionSkeleton },
);
const FeatureGallery = dynamic(
  () => import('./FeatureGallery').then((m) => m.FeatureGallery),
  { loading: SectionSkeleton },
);
const TrustLoop = dynamic(
  () => import('./TrustLoop').then((m) => m.TrustLoop),
  { loading: SectionSkeleton },
);
const SocialProof = dynamic(
  () => import('./SocialProof').then((m) => m.SocialProof),
  { loading: SectionSkeleton },
);
const HowItWorks = dynamic(
  () => import('./HowItWorks').then((m) => m.HowItWorks),
  { loading: SectionSkeleton },
);
const OpenSourceFinale = dynamic(
  () => import('./OpenSourceFinale').then((m) => m.OpenSourceFinale),
  { loading: SectionSkeleton },
);

export function LandingTree({ statsPromise }: { statsPromise: Promise<GitHubStats | null> }) {
  const stats = useResolvedStats(statsPromise);
  return (
    <>
      <LandingHeader stars={stats?.stars} />
      <main>
        <Hero stars={stats?.stars} />
        <ScrollCanvas />
        <MagicSequence />
        <FeatureGallery />
        <TrustLoop />
        <SocialProof stats={stats} />
        <HowItWorks />
        <OpenSourceFinale stars={stats?.stars} />
      </main>
      <LandingFooter />
    </>
  );
}

/** Promise → state, without Suspense. The cleanup flag drops a resolution
 * that lands after unmount (React StrictMode double-invoke included).
 *
 * `Promise.resolve` is load-bearing: a promise passed from a server component
 * arrives as a React STREAMED THENABLE, whose `then()` returns undefined — so
 * chaining `.catch()` onto it throws "Cannot read properties of undefined
 * (reading 'catch')" and takes the whole page down (caught in the 2026-09-19
 * browser pass). Wrapping it in a real promise adopts the thenable instead. */
function useResolvedStats(promise: Promise<GitHubStats | null>): GitHubStats | null {
  const [stats, setStats] = useState<GitHubStats | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.resolve(promise)
      .then((resolved) => {
        if (alive) setStats(resolved);
      })
      .catch(() => {
        /* fetchGitHubStats never rejects, but a streamed payload can */
      });
    return () => {
      alive = false;
    };
  }, [promise]);
  return stats;
}
