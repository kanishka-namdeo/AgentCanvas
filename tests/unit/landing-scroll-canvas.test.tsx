// Scrollytelling spine (landing-scrollytelling task): the ScrollCanvas
// component — a sticky SVG plane that draws a dashboard in lockstep with
// scroll progress. Tests assert the accessibility contract (section
// aria-labelledby, SVG role="img", aria-live status region), the section's
// structural anchors (testid, h2, prompt chip), the drawing primitives
// (header rect, sidebar rect, 3 stat cards, chart area, chart bars, text
// labels), and the prefers-reduced-motion branch (collapsed track, completed
// drawing state, no parallax handlers).
//
// Interaction layer (landing-interactions task): additional tests assert the
// keyboard + mouse interaction surface — section tabIndex + aria-labelledby
// describing the shortcuts, the step indicator (currentStep / totalSteps),
// the autoplay indicator visible only while isPlaying, the example prompt
// chip text cycling via the hook, and the reduced-motion no-op behavior for
// Space.

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useReducedMotion } from 'motion/react';
import { ScrollCanvas } from '@/components/landing/ScrollCanvas';
import {
  useScrollCanvasKeyboard,
  EXAMPLE_PROMPTS,
  TOTAL_STEPS,
  type ScrollCanvasKeyboardApi,
} from '@/components/landing/ScrollCanvasInteractions';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

// Mock the keyboard hook so per-test assertions can drive `isPlaying`,
// `currentStep`, `currentExampleIndex` without depending on the RAF loop or
// window.scrollTo (jsdom doesn't lay out, so the real hook's getProgress
// returns 0 and currentStep stays at 1 — fine for the default tests, but
// the autoplay indicator test needs isPlaying=true on first render). The
// default implementation delegates to the real hook; tests that need to
// assert on hook-driven UI override it via `useScrollCanvasKeyboardMock.mockReturnValue`.
//
// IMPORTANT: `restoreMocks: true` in vitest.config.ts resets mock state
// between tests but does NOT restore `vi.fn(impl)` back to its original
// impl — `mockReturnValue` from a prior test leaks into the next. So we
// stash the real impl in `realUseScrollCanvasKeyboardRef` inside the
// factory and re-apply it in `beforeEach` via `mockImplementation`.
const realUseScrollCanvasKeyboardRef = vi.hoisted<{
  current: typeof useScrollCanvasKeyboard | null;
}>(() => ({ current: null }));

vi.mock('@/components/landing/ScrollCanvasInteractions', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/components/landing/ScrollCanvasInteractions')
  >();
  realUseScrollCanvasKeyboardRef.current = actual.useScrollCanvasKeyboard;
  return {
    ...actual,
    useScrollCanvasKeyboard: vi.fn(actual.useScrollCanvasKeyboard),
  };
});

const useReducedMotionMock = vi.mocked(useReducedMotion);
const useScrollCanvasKeyboardMock = vi.mocked(useScrollCanvasKeyboard);

beforeAll(() => {
  // The factory populates the ref synchronously when the mock module is
  // first imported — which happens at test-file load, before any test runs.
  // `beforeAll` re-asserts it's populated so TypeScript narrows the type.
  if (!realUseScrollCanvasKeyboardRef.current) {
    throw new Error(
      'useScrollCanvasKeyboard mock factory did not populate realUseScrollCanvasKeyboardRef',
    );
  }
});

beforeEach(() => {
  useReducedMotionMock.mockReturnValue(false);
  // Restore the real hook impl so the default tests (those that don't
  // override via mockReturnValue) get the real keyboard handler logic —
  // including the reduced-motion no-op branch (which reads useReducedMotion
  // internally).
  const real = realUseScrollCanvasKeyboardRef.current;
  if (real) {
    useScrollCanvasKeyboardMock.mockImplementation(real);
  }
});

describe('landing: ScrollCanvas', () => {
  it('renders the section with off-screen h2 + aria-labelledby', () => {
    render(<ScrollCanvas />);
    const section = screen.getByTestId('section-scroll-canvas');
    expect(section).toHaveAttribute('aria-labelledby', 'scroll-canvas-heading');
    // The h2 lives in the DOM with the heading role and the right text —
    // visually-hidden via `sr-only`, not `display: none`, so AT still reads it.
    // Partial-match via regex: the h2 text was expanded in the
    // landing-interactions task to also describe the keyboard shortcuts (so
    // the section's accessible name satisfies "aria-label or aria-labelledby
    // describing keyboard shortcuts").
    const heading = screen.getByRole('heading', {
      name: /Watch the canvas draw itself/,
    });
    expect(heading).toHaveAttribute('id', 'scroll-canvas-heading');
  });

  it('renders the visible section title + caption', () => {
    render(<ScrollCanvas />);
    expect(
      screen.getByRole('heading', { name: 'Design that draws itself.' }),
    ).toBeInTheDocument();
  });

  it('renders the SVG with role="img" and a stable aria-label', () => {
    render(<ScrollCanvas />);
    const svg = screen.getByRole('img', {
      name: /AgentCanvas dashboard being drawn by an AI agent/i,
    });
    expect(svg.tagName).toBe('svg');
  });

  it('renders the aria-live status region with an initial state', () => {
    render(<ScrollCanvas />);
    const status = screen.getByTestId('scroll-canvas-status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    // The initial status text is announced (STATUS_TEXTS[0]).
    expect(status).toHaveTextContent('Empty canvas');
  });

  it('renders the prompt chip with the prompt text', () => {
    render(<ScrollCanvas />);
    const chip = screen.getByTestId('scroll-canvas-prompt');
    expect(chip).toHaveTextContent('Build a dashboard with 3 stat cards');
  });

  it('renders a tall 300vh scroll track so the scrub has range', () => {
    render(<ScrollCanvas />);
    const section = screen.getByTestId('section-scroll-canvas');
    const track = section.querySelector('.md\\:h-\\[300vh\\]');
    expect(track).not.toBeNull();
  });

  it('renders the parallax plane wrapper', () => {
    render(<ScrollCanvas />);
    expect(screen.getByTestId('scroll-canvas-plane')).toBeInTheDocument();
  });

  it('renders all six dashboard rectangles', () => {
    render(<ScrollCanvas />);
    const svg = screen.getByRole('img', {
      name: /AgentCanvas dashboard being drawn/i,
    });
    // 6 drawn shapes: header + sidebar + 3 stat cards + chart area. Plus the
    // 3 KPI accent squares inside the stat cards, the dot-grid background,
    // and the chart bars — so we assert at least the 6 drawn shapes are
    // present (the exact count includes the extra primitives).
    const rects = svg.querySelectorAll('rect');
    expect(rects.length).toBeGreaterThanOrEqual(6);
  });

  it('renders the chart bars (10 bars inside the chart area)', () => {
    render(<ScrollCanvas />);
    const svg = screen.getByRole('img', {
      name: /AgentCanvas dashboard being drawn/i,
    });
    // The chart bars are the rects with a `scaleY` style — count by their
    // position inside the chart area. We assert ≥10 bars exist somewhere in
    // the drawing.
    const rects = svg.querySelectorAll('rect');
    expect(rects.length).toBeGreaterThanOrEqual(16); // 6 shapes + 3 KPI + ≥10 bars
  });

  it('renders the three text labels (Dashboard / STATS / ACTIVITY)', () => {
    render(<ScrollCanvas />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('STATS')).toBeInTheDocument();
    expect(screen.getByText('ACTIVITY')).toBeInTheDocument();
  });

  it('renders the step counter with an initial "Step 01 / 11"', () => {
    render(<ScrollCanvas />);
    const counter = screen.getByTestId('scroll-canvas-step');
    expect(counter).toHaveTextContent('Step 01 / 11');
  });

  /* ── Interaction layer (landing-interactions task) ──────────────────── */

  it('section is keyboard-focusable via tabIndex={0}', () => {
    render(<ScrollCanvas />);
    const section = screen.getByTestId('section-scroll-canvas');
    // `tabIndex={0}` puts the section in the natural tab order so keyboard
    // users can focus it and drive the shortcuts.
    expect(section.tabIndex).toBe(0);
  });

  it('section has an accessible name describing the keyboard shortcuts', () => {
    render(<ScrollCanvas />);
    const section = screen.getByTestId('section-scroll-canvas');
    // The section's accessible name comes from `aria-labelledby` pointing to
    // the off-screen h2 — which the landing-interactions task expanded to
    // also describe the keyboard shortcuts (so screen-reader users get the
    // shortcut list when they navigate to the section landmark).
    const labelledby = section.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    const target = labelledby ? document.getElementById(labelledby) : null;
    expect(target).not.toBeNull();
    const text = target?.textContent ?? '';
    expect(text).toMatch(/Space/);
    expect(text).toMatch(/Enter/);
    expect(text).toMatch(/Escape/);
  });

  it('renders the step indicator from the hook (currentStep / totalSteps)', () => {
    // Override the hook with a non-default currentStep so the indicator
    // visibly differs from the initial "Step 01 / 11".
    useScrollCanvasKeyboardMock.mockReturnValue({
      sectionRef: { current: null },
      isPlaying: false,
      currentStep: 5,
      totalSteps: TOTAL_STEPS,
      examplePrompts: EXAMPLE_PROMPTS,
      currentExampleIndex: 0,
    } as ScrollCanvasKeyboardApi);
    render(<ScrollCanvas />);
    const indicator = screen.getByTestId('scroll-canvas-step');
    expect(indicator).toHaveTextContent(
      `Step 05 / ${String(TOTAL_STEPS).padStart(2, '0')}`,
    );
  });

  it('does NOT render the autoplay indicator when isPlaying is false', () => {
    // Default mock: real hook returns isPlaying=false on first render.
    render(<ScrollCanvas />);
    expect(screen.queryByTestId('scroll-canvas-autoplay')).not.toBeInTheDocument();
  });

  it('renders the autoplay indicator when isPlaying is true', () => {
    useScrollCanvasKeyboardMock.mockReturnValue({
      sectionRef: { current: null },
      isPlaying: true,
      currentStep: 1,
      totalSteps: TOTAL_STEPS,
      examplePrompts: EXAMPLE_PROMPTS,
      currentExampleIndex: 0,
    } as ScrollCanvasKeyboardApi);
    render(<ScrollCanvas />);
    const indicator = screen.getByTestId('scroll-canvas-autoplay');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent(/Playing/);
  });

  it('renders the example prompt chip with the current example text', () => {
    // Cycle to the third example ("Wireframe a SaaS landing page") via the
    // hook's currentExampleIndex to prove the chip reads from the hook.
    useScrollCanvasKeyboardMock.mockReturnValue({
      sectionRef: { current: null },
      isPlaying: false,
      currentStep: 1,
      totalSteps: TOTAL_STEPS,
      examplePrompts: EXAMPLE_PROMPTS,
      currentExampleIndex: 2,
    } as ScrollCanvasKeyboardApi);
    render(<ScrollCanvas />);
    const chip = screen.getByTestId('scroll-canvas-prompt');
    expect(chip).toHaveTextContent(EXAMPLE_PROMPTS[2]);
  });

  it('renders the "Scroll to explore ↓" hint for click-to-scroll affordance', () => {
    render(<ScrollCanvas />);
    const hint = screen.getByTestId('scroll-canvas-hint');
    expect(hint).toHaveTextContent(/Scroll to explore/);
  });

  describe('under prefers-reduced-motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('collapses the 300vh scroll track (no tall pin range)', () => {
      render(<ScrollCanvas />);
      const section = screen.getByTestId('section-scroll-canvas');
      const tallTrack = section.querySelector('.md\\:h-\\[300vh\\]');
      expect(tallTrack).toBeNull();
    });

    it('announces the completed drawing state in the live region', () => {
      render(<ScrollCanvas />);
      const status = screen.getByTestId('scroll-canvas-status');
      expect(status).toHaveTextContent('Complete dashboard design.');
    });

    it('still renders the SVG with role="img" so AT users get the alt text', () => {
      render(<ScrollCanvas />);
      expect(
        screen.getByRole('img', {
          name: /AgentCanvas dashboard being drawn/i,
        }),
      ).toBeInTheDocument();
    });

    it('still renders every text label so the drawing reads as complete', () => {
      render(<ScrollCanvas />);
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
      expect(screen.getByText('STATS')).toBeInTheDocument();
      expect(screen.getByText('ACTIVITY')).toBeInTheDocument();
    });

    it('renders the prompt chip with the prompt text (no scrub, but visible)', () => {
      render(<ScrollCanvas />);
      expect(screen.getByTestId('scroll-canvas-prompt')).toHaveTextContent(
        'Build a dashboard with 3 stat cards',
      );
    });

    it('Space is a no-op (does not trigger autoplay)', () => {
      // The real hook (default mock impl) reads useReducedMotion() — which
      // is mocked to return true here — so the Space handler bails out
      // before flipping isPlaying. The autoplay indicator must NOT appear.
      render(<ScrollCanvas />);
      const section = screen.getByTestId('section-scroll-canvas');
      section.focus();
      fireEvent.keyDown(section, { key: ' ' });
      expect(
        screen.queryByTestId('scroll-canvas-autoplay'),
      ).not.toBeInTheDocument();
    });

    it('hides the "Scroll to explore ↓" hint (no scrub to invite)', () => {
      render(<ScrollCanvas />);
      // The hint is suppressed under reduced motion — the canvas already
      // shows the final state, so there's nothing to scroll-scrub.
      expect(screen.queryByTestId('scroll-canvas-hint')).not.toBeInTheDocument();
    });
  });
});
