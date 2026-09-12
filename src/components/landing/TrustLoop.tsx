'use client';

import Image from 'next/image';
import { FileDiff, History, ShieldCheck, Timer } from 'lucide-react';
import { BlurFade } from '@/components/ui/blur-fade';
import { BrowserFrame } from './BrowserFrame';

/** The four approved bullets — verbatim copy from spec §5.4. */
const TRUST_BULLETS = [
  {
    Icon: ShieldCheck,
    title: 'Destructive-operation gating',
    body: 'The agent cannot delete or overwrite anything without an explicit Allow.',
  },
  {
    Icon: FileDiff,
    title: 'Diff cards',
    body: 'Every proposed destructive change is shown as a before/after diff.',
  },
  {
    Icon: Timer,
    title: 'Unattended auto-deny after 5 minutes',
    body: 'A pending approval with no human present is denied, never guessed.',
  },
  {
    Icon: History,
    title: 'Snapshot audit trail',
    body: 'Every approved change is a restorable document snapshot.',
  },
] as const;

/** Trust loop — credibility for teams (spec §5.4). The approval-dialog
 * screenshot is exactly 16:10, so the default frame fits it with zero crop. */
export function TrustLoop() {
  return (
    <section id="trust" data-testid="section-trust" className="scroll-mt-20 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <BlurFade inView>
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-white md:text-4xl">
            You approve. Every time.
          </h2>
          <p className="mt-3 max-w-2xl text-white/60">
            The agent moves fast because the dangerous steps stop and wait for a human.
          </p>
        </BlurFade>

        <div className="mt-12 grid items-center gap-12 md:grid-cols-5">
          <BlurFade inView delay={0.1} className="md:col-span-3">
            <BrowserFrame>
              <Image
                src="/landing/approval-dialog.png"
                alt="Approve destructive operation dialog with Deny and Allow actions"
                width={1600}
                height={1000}
                className="h-auto w-full object-cover"
              />
            </BrowserFrame>
          </BlurFade>

          <ul className="space-y-5 md:col-span-2">
            {TRUST_BULLETS.map(({ Icon, title, body }) => (
              <li key={title} className="flex gap-3">
                <span className="ac-brand-gradient mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
                  <Icon className="h-4 w-4 text-white" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-white">{title}</h3>
                  <p className="mt-1 text-sm text-white/60">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
