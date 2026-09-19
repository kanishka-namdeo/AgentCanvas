'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, Copy, Star } from 'lucide-react';
import { BorderBeam } from '@/components/ui/border-beam';
import { BlurFade } from '@/components/ui/blur-fade';
import { REPO_URL, REPO_CLONE_URL } from './repo-url';
import { formatStarCount, hasStars } from './GitHubStars';

const CLONE_COMMAND = `git clone ${REPO_CLONE_URL}`;

/** Open-source finale — the conversion (spec §5.6). Plain styled <pre>,
 * no syntax-highlighting library; copy button via navigator.clipboard.
 * `stars` comes from the server fetch (GitHubStars contract) — the CTA keeps
 * its label and gains the live count only when the fetch succeeded. */
export function OpenSourceFinale({ stars }: { stars?: number | null }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyCloneCommand = async () => {
    try {
      await navigator.clipboard.writeText(CLONE_COMMAND);
      setCopied(true);
    } catch {
      // Clipboard unavailable (permissions / non-secure context) — no-op.
    }
  };

  return (
    <section
      id="open-source"
      data-testid="section-open-source"
      className="scroll-mt-20 px-6 py-24 text-center"
    >
      <div className="mx-auto max-w-3xl">
        <BlurFade inView>
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-white md:text-4xl">
            Open source. AGPL-3.0. Free forever.
          </h2>
          <p className="mt-3 text-white/60">
            Clone it, star it, open the canvas. No signup, no pricing — ever.
          </p>
        </BlurFade>

        {/* Copyable clone command block with a border beam accent. */}
        <BlurFade inView delay={0.1}>
          <div className="relative mt-10 overflow-hidden rounded-xl border border-white/10 bg-white/5">
            <BorderBeam size={60} duration={6} />
            <div className="flex items-center justify-between gap-4 p-5">
              <pre
                data-testid="clone-command"
                className="overflow-x-auto text-left text-sm text-white/90 [font-family:var(--font-geist-mono),monospace]"
              >
                {CLONE_COMMAND}
              </pre>
              <button
                type="button"
                onClick={copyCloneCommand}
                data-testid="copy-clone"
                data-copied={copied ? 'true' : 'false'}
                aria-label={copied ? 'Copied' : 'Copy clone command'}
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/80 transition-colors hover:bg-white/10"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </BlurFade>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="finale-star"
            className="ac-brand-gradient ac-cta-gradient inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white shadow-lg"
          >
            <Star className="h-4 w-4" aria-hidden="true" />
            Star on GitHub
            {hasStars(stars) && (
              <span className="opacity-90">· ★ {formatStarCount(stars)}</span>
            )}
          </a>
          <Link
            href="/app"
            data-testid="finale-open"
            className="inline-flex items-center gap-2 rounded-full border border-white/20 px-6 py-3 text-sm font-medium text-white/90 transition-colors hover:bg-white/10"
          >
            Open the canvas
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
