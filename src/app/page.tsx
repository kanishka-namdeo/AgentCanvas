import type { Metadata } from 'next';
import { ScrollProgress } from '@/components/ui/scroll-progress';
import { SmoothScroll } from '@/components/landing/SmoothScroll';
import { LandingTree } from '@/components/landing/LandingTree';
import { fetchGitHubStats } from '@/components/landing/GitHubStars';
import { REPO_URL, SITE_URL } from '@/components/landing/repo-url';

const LANDING_DESCRIPTION =
  'The open-source canvas where AI agents do the drawing and you direct. 60+ typed tools, human-approved destructive steps, 28 LLM providers — AGPL-3.0 and free forever.';

export const metadata: Metadata = {
  title: 'AgentCanvas — Figma for AI agents',
  description: LANDING_DESCRIPTION,
  keywords: ['AgentCanvas', 'AI agents', 'design canvas', 'Figma', 'open source', 'AGPL-3.0'],
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'AgentCanvas',
    title: 'AgentCanvas — Figma for AI agents',
    description: LANDING_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AgentCanvas — Figma for AI agents',
    description: LANDING_DESCRIPTION,
  },
};

// Structured data (2026-09-19 landing-uplift P0): SoftwareApplication for the
// product + SoftwareSourceCode for the repo (open-source semantics: license,
// code repository, free offer). Static JSON — no runtime cost.
const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'SoftwareApplication',
      name: 'AgentCanvas',
      applicationCategory: 'DesignApplication',
      operatingSystem: 'Web',
      url: `${SITE_URL}/`,
      description: LANDING_DESCRIPTION,
      isAccessibleForFree: true,
      license: 'https://www.gnu.org/licenses/agpl-3.0.html',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      author: { '@type': 'Person', name: 'kanishka-namdeo' },
    },
    {
      '@type': 'SoftwareSourceCode',
      name: 'AgentCanvas',
      codeRepository: REPO_URL,
      programmingLanguage: 'TypeScript',
      license: 'https://www.gnu.org/licenses/agpl-3.0.html',
      url: `${SITE_URL}/`,
    },
  ],
};

/** The landing page owns `/` (spec §3). Single scroll narrative:
 * hero → magic → tool → trust → social proof → how-it-works → open-source
 * finale. The `.dark` class on the root forces the dark token subtree
 * regardless of the visitor's workspace theme preference (spec §9 — the
 * landing is the movie trailer; the light workspace is the product).
 *
 * The GitHub proof fetch starts here (server, ISR-cached) as a PROMISE that
 * the client tree resolves into state (`LandingTree`) — the client tree
 * cannot contain an async component, and the tree must stay renderable in a
 * plain client render (vitest renders this page directly). */
export default function LandingPage() {
  const statsPromise = fetchGitHubStats();
  return (
    <div data-testid="landing-root" className="dark min-h-screen bg-background text-foreground">
      {/* No-JS / progressive fallback (audit #8): BlurFade SSRs its hidden
          state inline; without JavaScript nothing would ever reveal the
          below-fold sections. This noscript override forces every BlurFade
          element visible. */}
      <noscript>
        <style>{`[data-blur-fade]{opacity:1 !important;filter:none !important;transform:none !important;}`}</style>
      </noscript>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      <SmoothScroll>
        <ScrollProgress className="fixed top-0 z-50" />
        <LandingTree statsPromise={statsPromise} />
      </SmoothScroll>
    </div>
  );
}
