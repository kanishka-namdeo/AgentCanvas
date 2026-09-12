'use client';

import type { ReactNode } from 'react';

export interface BrowserFrameProps {
  /** Frame contents — usually a next/image screenshot (see the sections). */
  children: ReactNode;
  /** Passthrough classes for the outer frame (width/margins). */
  className?: string;
  /** CSS aspect-ratio of the viewport area; the child is clipped to it.
   * Default "16 / 10". Use a NARROWER ratio than the source screenshot's
   * (e.g. "4 / 3" for the 2.22:1 dashboard shots) together with
   * crop="bottom" + object-cover object-top to cut the bottom edge. */
  aspectRatio?: string;
  /** 'bottom' overlays a light fade over the viewport's bottom edge so the
   * cropped edge reads as intentional (spec §6: artifacts are cropped in
   * CSS, never edited out of the source screenshots). */
  crop?: 'bottom' | 'none';
}

/**
 * Light-chrome browser mockup — the shared screenshot frame for the landing
 * (spec §6 light-on-dark contract). All screenshots are light-mode while the
 * landing is dark, so every screenshot is framed inside this LIGHT chrome +
 * light page background and never pasted raw onto the dark page.
 */
export function BrowserFrame({
  children,
  className = '',
  aspectRatio = '16 / 10',
  crop = 'none',
}: BrowserFrameProps) {
  return (
    <div
      data-testid="browser-frame"
      data-crop={crop}
      className={`overflow-hidden rounded-xl border border-white/10 bg-white shadow-2xl ${className}`}
    >
      {/* Light chrome bar — three traffic lights + a light address strip. */}
      <div aria-hidden="true" className="flex items-center gap-1.5 bg-[#e2e8f0] px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#f87171]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#fbbf24]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#34d399]" />
        <span className="ml-2 h-4 flex-1 rounded bg-white/70" />
      </div>
      {/* Fixed-aspect viewport — overflow-hidden does the CSS crop (no CLS:
          the box keeps its shape regardless of child load state). */}
      <div className="relative w-full overflow-hidden bg-white" style={{ aspectRatio }}>
        {children}
        {crop === 'bottom' && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-white"
          />
        )}
      </div>
    </div>
  );
}
