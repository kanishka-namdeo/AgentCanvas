'use client';

import type { ReactNode } from 'react';
import { ReactLenis } from 'lenis/react';
import 'lenis/dist/lenis.css';
import { useReducedMotion } from 'motion/react';

const LENIS_OPTIONS = { lerp: 0.1, smoothWheel: true } as const;

/** Inertial scrolling for the cinematic arc (spec §4). Under
 * prefers-reduced-motion the provider is not mounted at all — anchor links
 * fall back to native scrolling (LandingHeader's useLenis() returns null). */
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
