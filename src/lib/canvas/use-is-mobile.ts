'use client';

// Mobile detection hook (P3-8) — mirrors shadcn/ui's `useMediaQuery` pattern
// but inlined so we don't pull a new dep. Returns true when viewport width is
// below the breakpoint. Default false on SSR + first paint (so the desktop
// layout is the SSR default — no hydration mismatch flash).
//
// Used by page.tsx to auto-collapse the side panels on mobile and to widen
// their min/max sizes so an opened panel takes most of the screen.

import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT_PX = 768; // Tailwind `md` breakpoint.

export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT_PX): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setIsMobile(mql.matches);
    onChange(); // Sync immediately on mount.
    // addEventListener with { passive: true } is the modern API; older Safari
    // fallback uses addListener. The feature-detect keeps this SSR-safe.
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [breakpoint]);
  return isMobile;
}
