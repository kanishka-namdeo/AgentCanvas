'use client';

import type { ReactNode } from 'react';
import { ReactLenis } from 'lenis/react';
import 'lenis/dist/lenis.css';
import { useReducedMotion } from 'motion/react';

const LENIS_OPTIONS = { lerp: 0.1, smoothWheel: true } as const;

/** Inertial scrolling for the cinematic arc (spec §4). Under
 * prefers-reduced-motion the provider is not mounted at all — anchor links
 * fall back to native scrolling (LandingHeader's useLenis() returns null).
 *
 * ## Lenis ↔ Framer Motion `useScroll` compatibility
 *
 * The ScrollCanvas scrollytelling spine (and every other motion-driven
 * landing section — Hero parallax, MagicSequence crossfade, FeatureGallery
 * parallax) reads scroll position via Framer Motion's `useScroll({ target })`.
 * `useScroll`'s default scroll source is the native `window` scroll position
 * (it listens to `scroll` events on `window` and reads `scrollY` /
 * element `getBoundingClientRect`).
 *
 * Lenis does NOT replace the native scroll position. It interpolates the
 * TARGET scroll position in a `requestAnimationFrame` loop and updates
 * `window.scrollY` to match (via `window.scrollTo`), so `useScroll` sees the
 * same interpolated values Lenis renders. The scrub stays 1:1 with what's
 * on screen — there is no double-buffering conflict.
 *
 * What Lenis DOES change: scroll *velocity* (it smooths fast scrolls into a
 * gentler ramp) and wheel/touch *event prevention* (it `preventDefault`s the
 * wheel so the page never scrolls past the interpolated target). Neither
 * breaks `useScroll`: the hook is read-only and reacts to whatever scroll
 * position exists at the time of the `scroll` event.
 *
 * Net: SmoothScroll + useScroll + ScrollCanvas coexist without coordination.
 * If a future feature needs Lenis's `on('scroll', cb)` callback (e.g. to
 * drive a non-Framer animation), the consumer can call `useLenis()` directly
 * — but no landing component currently needs to.
 */
export function SmoothScroll({ children }: { children: ReactNode }) {
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) {
    return <>{children}</>;
  }

  return (
    <ReactLenis root options={LENIS_OPTIONS}>
      {children}
    </ReactLenis>
  );
}
