// BorderBeam reduced-motion short-circuit (landing spec §10: every motion
// behavior needs a static prefers-reduced-motion fallback).
// Uses the same mock convention as ui-blur-fade.test.tsx:
//   motion/react's useReducedMotion → controllable vi.fn

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { useReducedMotion } from 'motion/react';
import { BorderBeam } from '@/components/ui/border-beam';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

const useReducedMotionMock = vi.mocked(useReducedMotion);

beforeEach(() => {
  useReducedMotionMock.mockReturnValue(false);
});

function beamEl(container: HTMLElement): HTMLElement {
  const outer = container.firstElementChild as HTMLElement | null;
  if (!outer) throw new Error('BorderBeam rendered no wrapper element');
  const beam = outer.firstElementChild as HTMLElement | null;
  if (!beam) throw new Error('BorderBeam rendered no inner beam element');
  return beam;
}

describe('ui: BorderBeam', () => {
  it('animates normally when reduced motion is off (initial offsetDistance applied inline)', () => {
    const { container } = render(<BorderBeam size={40} />);
    const beam = beamEl(container);
    // framer-motion applies the `initial` offsetDistance as an inline style.
    expect(beam.style.getPropertyValue('offset-distance')).toBe('0%');
    expect(beam.style.getPropertyValue('offset-path')).toContain('rect(');
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('keeps the same DOM shape but renders no animation styles', () => {
      const { container } = render(<BorderBeam size={40} delay={1} />);
      const beam = beamEl(container);
      expect(beam).toBeInTheDocument();
      // Static no-op: no initial/animate offsetDistance inline style, no
      // framer-motion animation bookkeeping attributes.
      expect(beam.style.getPropertyValue('offset-distance')).toBe('');
      expect(beam.getAttribute('style') ?? '').not.toContain('offset-distance');
      // The decorative beam stays invisible statically (no gradient painted
      // at a fixed position) — only its geometry/vars remain.
      expect(beam.style.getPropertyValue('offset-path')).toContain('rect(');
      expect(beam.style.getPropertyValue('--color-from')).toBe('#ffaa40');
    });

    it('still applies custom props (className/size/colors) statically', () => {
      const { container } = render(
        <BorderBeam size={70} colorFrom="#fff" colorTo="#000" className="my-beam" />,
      );
      const beam = beamEl(container);
      expect(beam.className).toContain('my-beam');
      expect(beam.style.width).toBe('70px');
      expect(beam.style.getPropertyValue('--color-from')).toBe('#fff');
      expect(beam.style.getPropertyValue('--color-to')).toBe('#000');
    });
  });
});
