'use client';

// ScrollCanvasInteractions — the keyboard + mouse interaction layer for the
// ScrollCanvas scrollytelling spine (landing-interactions task, research
// report §C.2 keyboard matrix + §C.3 reduced-motion fallback).
//
// Exposes `useScrollCanvasKeyboard()` returning the keyboard handler API and
// a section ref that ScrollCanvas attaches to its `<section>` element. The
// hook owns:
//
//   - keydown handling for Space (autoplay), Enter + arrows (step), Esc (reset)
//   - ↑ / ↓ cycling of the example prompt chips (visual only — no scroll)
//   - the autoplay RAF loop (advances scroll ~0.5% per frame until complete)
//   - currentStep / totalSteps derived from the section's track bounding rect
//   - click-to-scroll on the section (smooth-scrolls to the next section)
//
// Reduced-motion contract (research report §C.3): every shortcut that
// manipulates scroll position — Space, Enter, ←/→, Esc — is a no-op when
// `useReducedMotion()` returns true. The canvas is already at its final
// state under reduced motion, so there's nothing to scrub. Only `Tab` (native
// browser focus) and `Enter` (focus + activate, but no-op since the canvas is
// already complete) work. ↑/↓ (example cycling) are also no-ops under reduced
// motion because the example prompts exist to drive the drawing demo, which
// doesn't run when the canvas is already drawn.
//
// The hook is deliberately self-contained — it takes no args and finds its
// own track element via `querySelector('[data-testid="scroll-canvas-track"]')`
// inside the section it owns. This keeps ScrollCanvas.tsx focused on the SVG
// drawing primitives + motion values, while this hook owns interaction state.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { useReducedMotion } from 'motion/react';

/* ─────────────────────────────────────────────────────────────────────────
   Constants — must match ScrollCanvas's STEPS / STATUS_THRESHOLDS so the
   step indicator stays in sync with the drawing primitives.
   ──────────────────────────────────────────────────────────────────────── */

export const EXAMPLE_PROMPTS = [
  'Build a dashboard with 3 stat cards',
  'Design a mobile checkout flow',
  'Wireframe a SaaS landing page',
  'Draw an onboarding sequence',
] as const;

export const TOTAL_STEPS = 11;

// Step boundaries (matches ScrollCanvas STEPS — 11 steps, 12 boundaries).
// `STEP_THRESHOLDS[i]` is the progress at which step `i+1` BEGINS. So:
//   step  1 → progress ≥ 0.00
//   step  2 → progress ≥ 0.08
//   step  3 → progress ≥ 0.18
//   ...
//   step 11 → progress ≥ 0.95
//   step 12 (end) → progress ≥ 1.00 — used as the "advance to end" target.
const STEP_THRESHOLDS = [
  0.0, 0.08, 0.18, 0.28, 0.36, 0.44, 0.52, 0.62, 0.74, 0.86, 0.95, 1.0,
] as const;

// Autoplay advances scroll progress ~0.5% per frame (research report §C.2
// "0.5× speed" — interpreted here as 0.5% of total track per frame, which at
// 60fps completes a 3-viewport track in ~3.3 seconds, matching the calm
// constant-rate demo the report calls for).
const AUTOPLAY_PROGRESS_PER_FRAME = 0.005;

/* ─────────────────────────────────────────────────────────────────────────
   Public API
   ──────────────────────────────────────────────────────────────────────── */

export interface ScrollCanvasKeyboardApi {
  /** Attach to the ScrollCanvas `<section>` element. The hook reads the
   *  section's bounding rect and its first track descendant to drive the
   *  autoplay loop + step indicator. */
  sectionRef: RefObject<HTMLElement | null>;
  /** True while the autoplay RAF loop is running. Drives the "▶ Playing"
   *  indicator chip. */
  isPlaying: boolean;
  /** 1-indexed current draw step (1..TOTAL_STEPS). */
  currentStep: number;
  /** Total draw steps (matches STATUS_TEXTS.length - 1 in ScrollCanvas). */
  totalSteps: number;
  /** Example prompts for the chip cycle (↑ / ↓ keys). */
  examplePrompts: readonly string[];
  /** Index into `examplePrompts` for the currently displayed prompt. */
  currentExampleIndex: number;
}

/* ─────────────────────────────────────────────────────────────────────────
   Hook
   ──────────────────────────────────────────────────────────────────────── */

export function useScrollCanvasKeyboard(): ScrollCanvasKeyboardApi {
  const sectionRef = useRef<HTMLElement | null>(null);
  const reduced = Boolean(useReducedMotion());

  const [isPlaying, setIsPlaying] = useState(false);
  // Under reduced motion the canvas is already at the final state, so the
  // step indicator seeds at TOTAL_STEPS. Otherwise it seeds at step 1
  // (empty canvas) and updates from window scroll.
  const [currentStep, setCurrentStep] = useState<number>(
    reduced ? TOTAL_STEPS : 1,
  );
  const [currentExampleIndex, setCurrentExampleIndex] = useState(0);

  // Refs the RAF loop reads so it doesn't restart on every state change.
  const isPlayingRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  /* Helper: find the track element inside the section. The track is the
   * tall `md:h-[300vh]` div that owns `useScroll` in ScrollCanvas. */
  const getTrack = useCallback((): HTMLElement | null => {
    if (!sectionRef.current) return null;
    return sectionRef.current.querySelector<HTMLElement>(
      '[data-testid="scroll-canvas-track"]',
    );
  }, []);

  /* Helper: read the current scroll progress (0..1) through the track.
   *
   * Returns 1 (completed) under reduced motion because the canvas always
   * renders at its final state in that branch. Returns 0 (start) when the
   * track is unmeasured (jsdom tests) or has no scroll range — without this
   * fallback, a 0-height `getBoundingClientRect()` (jsdom's default) would
   * divide-by-zero into a NaN that lifts `currentStep` to its ceiling and
   * breaks the "Step 01 / 11" initial-render assertion. */
  const getProgress = useCallback((): number => {
    if (reduced) return 1;
    const track = getTrack();
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, -rect.top / total));
  }, [getTrack, reduced]);

  /* Helper: compute the current step from scroll progress. */
  const computeStep = useCallback((): number => {
    const p = getProgress();
    let idx = 1;
    // STEP_THRESHOLDS has 12 entries; the last (1.0) maps to step 11.
    for (let i = 0; i < STEP_THRESHOLDS.length - 1; i += 1) {
      if (p >= STEP_THRESHOLDS[i]) idx = i + 1;
    }
    return Math.min(TOTAL_STEPS, idx);
  }, [getProgress]);

  /* Helper: scroll the window so the track lands at a target progress. */
  const scrollToProgress = useCallback(
    (target: number, behavior: 'auto' | 'smooth' = 'smooth') => {
      const track = getTrack();
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      if (total <= 0) return; // nothing to scroll (reduced motion)
      const clamped = Math.min(1, Math.max(0, target));
      // We want the track's `top` (relative to viewport) to equal
      // `-clamped * total`. The current `top` is `rect.top`. So the scroll
      // delta to apply is `rect.top - (-clamped * total)` =
      // `rect.top + clamped * total`.
      const delta = rect.top + clamped * total;
      window.scrollTo({ top: window.scrollY + delta, behavior });
    },
    [getTrack],
  );

  /* Helper: scroll to a specific step boundary (1..TOTAL_STEPS). */
  const scrollToStep = useCallback(
    (step: number) => {
      const idx = Math.max(1, Math.min(STEP_THRESHOLDS.length, step));
      scrollToProgress(STEP_THRESHOLDS[idx - 1]);
    },
    [scrollToProgress],
  );

  /* ── Autoplay ──────────────────────────────────────────────────────── */

  const stopAutoplay = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
    }
  }, []);

  const tick = useCallback(() => {
    if (!isPlayingRef.current) return;
    const track = getTrack();
    if (!track) {
      stopAutoplay();
      return;
    }
    const rect = track.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    if (total <= 0) {
      stopAutoplay();
      return;
    }
    const progress = Math.min(1, Math.max(0, -rect.top / total));
    if (progress >= 1) {
      stopAutoplay();
      return;
    }
    // Advance by AUTOPLAY_PROGRESS_PER_FRAME * total pixels. Use 'auto'
    // behavior so each frame lands exactly where intended — 'smooth' would
    // queue an animation that fights the next frame's delta.
    const delta = AUTOPLAY_PROGRESS_PER_FRAME * total;
    window.scrollTo({ top: window.scrollY + delta, behavior: 'auto' });
    if (progress + AUTOPLAY_PROGRESS_PER_FRAME >= 1) {
      // Next frame would overshoot — stop here at the end.
      stopAutoplay();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [getTrack, stopAutoplay]);

  const startAutoplay = useCallback(() => {
    if (reduced) return; // reduced-motion: no autoplay (canvas already final)
    if (isPlayingRef.current) return;
    isPlayingRef.current = true;
    setIsPlaying(true);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [reduced, tick]);

  const toggleAutoplay = useCallback(() => {
    if (reduced) return;
    if (isPlayingRef.current) {
      stopAutoplay();
    } else {
      startAutoplay();
    }
  }, [reduced, startAutoplay, stopAutoplay]);

  /* ── Step controls (Enter + ← / →) ─────────────────────────────────── */

  const advanceStep = useCallback(() => {
    if (reduced) return;
    stopAutoplay();
    const next = Math.min(STEP_THRESHOLDS.length, computeStep() + 1);
    scrollToStep(next);
  }, [reduced, stopAutoplay, computeStep, scrollToStep]);

  const stepForward = useCallback(() => {
    if (reduced) return;
    stopAutoplay();
    const next = Math.min(STEP_THRESHOLDS.length, computeStep() + 1);
    scrollToStep(next);
  }, [reduced, stopAutoplay, computeStep, scrollToStep]);

  const stepBackward = useCallback(() => {
    if (reduced) return;
    stopAutoplay();
    const prev = Math.max(1, computeStep() - 1);
    scrollToStep(prev);
  }, [reduced, stopAutoplay, computeStep, scrollToStep]);

  /* ── Reset (Esc) ───────────────────────────────────────────────────── */

  const resetToStart = useCallback(() => {
    if (reduced) return;
    stopAutoplay();
    scrollToProgress(0);
  }, [reduced, stopAutoplay, scrollToProgress]);

  /* ── Example prompt cycling (↑ / ↓) — visual only ────────────────── */

  const cycleExampleForward = useCallback(() => {
    if (reduced) return; // reduced-motion: examples are inert (no drawing demo)
    setCurrentExampleIndex((i) => (i + 1) % EXAMPLE_PROMPTS.length);
  }, [reduced]);

  const cycleExampleBackward = useCallback(() => {
    if (reduced) return;
    setCurrentExampleIndex(
      (i) => (i - 1 + EXAMPLE_PROMPTS.length) % EXAMPLE_PROMPTS.length,
    );
  }, [reduced]);

  /* ── Keyboard handler ──────────────────────────────────────────────── */

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Don't intercept keys while the user is typing in an input/textarea
      // or contentEditable host — Space / Enter / arrows there belong to the
      // field, not the canvas.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      switch (event.key) {
        case ' ':
        case 'Spacebar':
          // Space would also scroll the page; preventDefault so the canvas
          // section owns it while focused.
          event.preventDefault();
          toggleAutoplay();
          break;
        case 'Enter':
          // Enter activates the focused canvas — advances one draw step.
          // Under reduced motion it's a no-op (canvas already complete).
          event.preventDefault();
          advanceStep();
          break;
        case 'ArrowRight':
          event.preventDefault();
          stepForward();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          stepBackward();
          break;
        case 'ArrowUp':
          event.preventDefault();
          cycleExampleBackward();
          break;
        case 'ArrowDown':
          event.preventDefault();
          cycleExampleForward();
          break;
        case 'Escape':
          event.preventDefault();
          resetToStart();
          break;
        default:
          // Tab and any other key: do nothing — native focus traversal
          // owns Tab.
          break;
      }
    },
    [
      toggleAutoplay,
      advanceStep,
      stepForward,
      stepBackward,
      cycleExampleBackward,
      cycleExampleForward,
      resetToStart,
    ],
  );

  /* Attach keydown listener to the section. Using addEventListener (rather
   * than React's onKeyDown) so the listener sees events bubbling from
   * descendant focusable elements too. */
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    section.addEventListener('keydown', handleKeyDown);
    return () => {
      section.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  /* Update step indicator from window scroll. Skipped under reduced motion
   * (the canvas is already at step TOTAL_STEPS). */
  useEffect(() => {
    if (reduced) {
      setCurrentStep(TOTAL_STEPS);
      return;
    }
    const onScroll = () => setCurrentStep(computeStep());
    onScroll(); // sync on mount
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, [reduced, computeStep]);

  /* ── Click-to-scroll ──────────────────────────────────────────────── */

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const onClick = (event: MouseEvent) => {
      // Ignore clicks on the prompt chip — it has its own hover behavior
      // and the click shouldn't trigger a scroll-away.
      const target = event.target as HTMLElement | null;
      if (target && target.closest('[data-testid="scroll-canvas-prompt"]')) {
        return;
      }
      // Find the next section sibling. The landing's sections are stacked
      // siblings inside <main> (see LandingTree.tsx), so the next <section>
      // is the next major landmark.
      let next: Element | null = section.nextElementSibling;
      while (next && next.tagName !== 'SECTION') {
        next = next.nextElementSibling;
      }
      if (next) {
        (next as HTMLElement).scrollIntoView({
          behavior: reduced ? 'auto' : 'smooth',
          block: 'start',
        });
      }
    };
    section.addEventListener('click', onClick);
    return () => {
      section.removeEventListener('click', onClick);
    };
  }, [reduced]);

  /* Cleanup the RAF loop on unmount. */
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      isPlayingRef.current = false;
    };
  }, []);

  return {
    sectionRef,
    isPlaying,
    currentStep: reduced ? TOTAL_STEPS : currentStep,
    totalSteps: TOTAL_STEPS,
    examplePrompts: EXAMPLE_PROMPTS,
    currentExampleIndex,
  };
}

/* Export a tiny helper for callers that want to programmatically trigger the
 * click-to-scroll behavior (used by ScrollCanvas's "Scroll to explore ↓"
 * hint button). Not part of the hook's public return shape — kept here so the
 * scroll-to-next-sibling logic has ONE owner. */
export function scrollToNextSection(
  current: HTMLElement,
  reduced: boolean,
): void {
  let next: Element | null = current.nextElementSibling;
  while (next && next.tagName !== 'SECTION') {
    next = next.nextElementSibling;
  }
  if (next) {
    (next as HTMLElement).scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'start',
    });
  }
}

/** Convenience type for the click handler signature on the section. Exported
 * so ScrollCanvas can type its onClick prop without re-importing React event
 * types. */
export type SectionClickHandler = (event: ReactMouseEvent<HTMLElement>) => void;
