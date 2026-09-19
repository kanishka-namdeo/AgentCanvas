import { Marquee } from '@/components/ui/marquee';
import { GitHubStats, formatStarCount } from './GitHubStars';

/**
 * Honest social-proof band (2026-09-19 landing-uplift P1): GitHub-derived
 * numbers + a "Built on" tech marquee. NO testimonials, NO customer logos —
 * nothing here may be fabricated.
 *
 * A zero is anti-proof, so every GitHub tile is gated on a POSITIVE value:
 * a fresh repo (`★ 0`, `0 forks`) shows only its real positives — the license
 * tile and the tech marquee — instead of a wall of zeros. The band never
 * disappears; it degrades to what is actually true.
 *
 * Server-safe (the Marquee primitive is pure CSS — no hooks), so the band is
 * fully SSR-visible with zero client JS. Not an anchor section: it is a band
 * inside the narrative, not a nav destination, so it deliberately carries no
 * id and is NOT registered in LANDING_SECTIONS.
 */

const BUILT_ON = [
  'Next.js',
  'React',
  'TypeScript',
  'Tailwind CSS',
  'Radix UI',
  'Prisma',
  'Socket.IO',
  'motion',
] as const;

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex-1 rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-center">
      <p className="text-2xl font-semibold text-white [font-family:var(--font-geist-mono),monospace]">
        {value}
      </p>
      <p className="mt-1 text-xs text-white/60">{label}</p>
    </div>
  );
}

export function SocialProof({ stats }: { stats?: GitHubStats | null }) {
  return (
    <section data-testid="section-social-proof" aria-label="Open source stats and tech stack" className="px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <p className="text-sm font-medium uppercase tracking-widest text-white/50">
          Open source, built on open source
        </p>

        <div className="mt-8 flex flex-col gap-4 sm:flex-row">
          {typeof stats?.stars === 'number' && stats.stars > 0 && (
            <StatTile value={`★ ${formatStarCount(stats.stars)}`} label="GitHub stars" />
          )}
          {typeof stats?.forks === 'number' && stats.forks > 0 && (
            <StatTile value={formatStarCount(stats.forks)} label="forks" />
          )}
          {typeof stats?.openIssues === 'number' && stats.openIssues > 0 && (
            <StatTile value={formatStarCount(stats.openIssues)} label="open issues & PRs" />
          )}
          <StatTile value="AGPL-3.0" label="license — free forever" />
        </div>

        {/* Screen readers get the list once; the marquee duplicates every chip
            4× for the seamless loop and is fully aria-hidden. */}
        <p className="sr-only">Built on: {BUILT_ON.join(', ')}.</p>
        <div className="mt-10">
          <p className="mb-2 text-center text-xs text-white/50">Built on</p>
          <div
            aria-hidden="true"
            className="overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]"
          >
            <Marquee pauseOnHover className="[--duration:36s]">
              {BUILT_ON.map((name) => (
                <span
                  key={name}
                  className="mx-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-white/70 [font-family:var(--font-geist-mono),monospace]"
                >
                  {name}
                </span>
              ))}
            </Marquee>
          </div>
        </div>
      </div>
    </section>
  );
}
