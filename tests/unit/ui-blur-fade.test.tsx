// BlurFade reduced-motion short-circuit (landing spec §10: every motion
// behavior needs a static prefers-reduced-motion fallback).
// Uses the same mock convention as the landing suites:
//   motion/react's useReducedMotion → controllable vi.fn
// (tests/setup.ts already stubs IntersectionObserver for useInView).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { useReducedMotion } from 'motion/react';
import { BlurFade } from '@/components/ui/blur-fade';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

const useReducedMotionMock = vi.mocked(useReducedMotion);

beforeEach(() => {
  useReducedMotionMock.mockReturnValue(false);
});

describe('ui: BlurFade', () => {
  it('animates normally when reduced motion is off', () => {
    const { container } = render(
      <BlurFade>
        <span data-testid="child">content</span>
      </BlurFade>,
    );
    expect(screen_child(container)).toBeInTheDocument();
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('renders the child fully visible with no blur/y/opacity animation styles', () => {
      const { container } = render(
        <BlurFade>
          <span data-testid="child">content</span>
        </BlurFade>,
      );
      const wrapper = screen_child(container);
      expect(wrapper).toBeInTheDocument();
      // No blur filter, no hidden-state opacity, no nonzero translate — the
      // entrance animation must be a static no-op.
      expect(wrapper.style.filter ?? '').not.toContain('blur');
      expect(wrapper.style.opacity).not.toBe('0');
      expect(wrapper.style.transform ?? '').not.toMatch(/-?[1-9]/);
    });

    it('also stays static with in-view gating enabled', () => {
      const { container } = render(
        <BlurFade inView delay={0.2}>
          <span data-testid="child">content</span>
        </BlurFade>,
      );
      const wrapper = screen_child(container);
      expect(wrapper).toBeInTheDocument();
      expect(wrapper.style.filter ?? '').not.toContain('blur');
      expect(wrapper.style.opacity).not.toBe('0');
      expect(wrapper.style.transform ?? '').not.toMatch(/-?[1-9]/);
    });
  });
});

function screen_child(container: HTMLElement): HTMLElement {
  const wrapper = container.firstElementChild as HTMLElement | null;
  if (!wrapper) throw new Error('BlurFade rendered no wrapper element');
  return wrapper;
}
