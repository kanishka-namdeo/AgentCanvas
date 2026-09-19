// Task 4 of the landing-page plan — the Hero (spec §5.1).
// Every landing test file uses the same two module mocks:
//   1. next/image → plain <img> (direct src/alt assertions)
//   2. motion/react's useReducedMotion → controllable vi.fn
// restoreMocks resets the mock after each test, so beforeEach re-arms the
// default (reduced = false).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useReducedMotion } from 'motion/react';
import { REPO_URL } from '@/components/landing/repo-url';
import { Hero } from '@/components/landing/Hero';

vi.mock('next/image', () => ({
  default: (props: {
    src: string | { src: string };
    alt: string;
    width?: number;
    height?: number;
    className?: string;
    priority?: boolean;
    fetchPriority?: string;
    sizes?: string;
  }) => {
    const src = typeof props.src === 'string' ? props.src : props.src.src;
    return (
      <img
        src={src}
        alt={props.alt}
        width={props.width}
        height={props.height}
        className={props.className}
        data-sizes={props.sizes}
        data-priority={props.priority ? 'true' : undefined}
        data-fetch-priority={props.fetchPriority}
      />
    );
  },
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

const useReducedMotionMock = vi.mocked(useReducedMotion);

beforeEach(() => {
  useReducedMotionMock.mockReturnValue(false);
});

describe('landing: Hero', () => {
  it('renders the headline, subline, and section anchor', () => {
    render(<Hero />);
    expect(screen.getByRole('heading', { level: 1, name: 'Describe. Direct. Refine.' })).toBeInTheDocument();
    expect(screen.getByText(/The open-source canvas where the AI agents do the drawing/)).toBeInTheDocument();
    expect(screen.getByTestId('section-hero')).toHaveAttribute('id', 'top');
  });

  it('renders the dual CTAs with the right destinations', () => {
    render(<Hero />);
    expect(screen.getByTestId('hero-star')).toHaveAttribute('href', REPO_URL);
    expect(screen.getByTestId('hero-open')).toHaveAttribute('href', '/app');
  });

  it('renders the above-the-fold proof row (AGPL + hard product numbers)', () => {
    render(<Hero />);
    const proof = screen.getByTestId('hero-proof-row');
    expect(proof).toHaveTextContent('AGPL-3.0');
    expect(proof).toHaveTextContent('60+ tools');
    expect(proof).toHaveTextContent('28 providers');
    // No star segment when the server fetch failed — never a fabricated count.
    expect(screen.queryByTestId('github-stars')).not.toBeInTheDocument();
  });

  it('includes the live star count in the proof row when provided', () => {
    render(<Hero stars={1234} />);
    expect(screen.getByTestId('hero-proof-row')).toHaveTextContent('1,234');
    expect(screen.getByTestId('github-stars')).toBeInTheDocument();
  });

  it('shows the build-reveal poster still with alt text at the real 1600x1000 dims', () => {
    render(<Hero />);
    const img = screen.getByAltText('AgentCanvas building an analytics dashboard live on the canvas');
    expect(img).toHaveAttribute('src', '/landing/build-reveal-poster.png');
    expect(img).toHaveAttribute('width', '1600');
    expect(img).toHaveAttribute('height', '1000');
  });

  it('marks the hero image as priority with a bounded sizes hint (LCP diet)', () => {
    render(<Hero />);
    const img = screen.getByAltText('AgentCanvas building an analytics dashboard live on the canvas');
    expect(img.getAttribute('data-priority')).toBe('true');
    expect(img.getAttribute('data-fetch-priority')).toBe('high');
    expect(img.getAttribute('data-sizes')).toBe('(max-width: 767px) 100vw, 896px');
  });

  // 2026-09-19 video pass: the build-reveal cut is layered over the SAME 16/10
  // viewport as the hero-build screenshot. NOTE React sets `muted` as a DOM
  // property (never an attribute), so that one is asserted on the element.
  it('overlays the looping build-reveal video on the hero frame', () => {
    render(<Hero />);
    const video = screen.getByTestId('hero-video') as HTMLVideoElement;
    expect(video).toHaveAttribute('src', '/landing/build-reveal.mp4');
    expect(video).toHaveAttribute('poster', '/landing/build-reveal-poster.png');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).toHaveAttribute('playsinline');
    expect(video).toHaveAttribute('loop');
    expect(video).toHaveAttribute('aria-hidden', 'true');
    expect(video).toHaveAttribute('tabindex', '-1');
    expect(video.muted).toBe(true);
  });

  it('keeps the video as an absolute layer inside the frame viewport (zero crop)', () => {
    render(<Hero />);
    const video = screen.getByTestId('hero-video');
    expect(video.className).toContain('absolute inset-0');
    expect(video.className).toContain('object-cover');
    // The BrowserFrame viewport is the `relative` positioning context.
    expect(video.parentElement).toHaveClass('relative');
    // The LCP image stays mounted underneath as the no-JS fallback.
    expect(
      screen.getByAltText('AgentCanvas building an analytics dashboard live on the canvas'),
    ).toBeInTheDocument();
  });

  it('renders the tool-call chip marquee', () => {
    render(<Hero />);
    expect(screen.getByTestId('hero-chips')).toBeInTheDocument();
    // The Magic UI marquee repeats its children (repeat=4) for the seamless
    // loop, so the chip text matches multiple times — assert on the first.
    expect(screen.getAllByText('pen_create_frame()')[0]).toBeInTheDocument();
    // The duplicated loop copies are decorative — hidden from the a11y tree,
    // with the accessible list provided by the sr-only paragraph.
    const marquee = screen.getByTestId('hero-chips').querySelector('[aria-hidden="true"]');
    expect(marquee).not.toBeNull();
    expect(screen.getByText(/Tool calls the agent runs live/)).toBeInTheDocument();
  });

  it('renders the typing prompt line', () => {
    render(<Hero />);
    expect(screen.getByTestId('hero-typing')).toBeInTheDocument();
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('renders the full prompt statically instead of the typing effect', () => {
      render(<Hero />);
      // The same prompt the hero footage types (the build-reveal capture):
      // the reduced-motion still, the video, and the typed line tell one story.
      expect(screen.getByTestId('hero-typing-static')).toHaveTextContent(
        'Build a modern analytics dashboard with a dark sidebar',
      );
      expect(screen.queryByTestId('hero-typing')).not.toBeInTheDocument();
    });

    it('renders a static chip row instead of the marquee', () => {
      render(<Hero />);
      expect(screen.getByTestId('hero-chips-static')).toBeInTheDocument();
      expect(screen.queryByTestId('hero-chips')).not.toBeInTheDocument();
      expect(screen.getByText('pen_create_frame()')).toBeInTheDocument();
    });

    it('still renders the screenshot and both CTAs', () => {
      render(<Hero />);
      expect(screen.getByAltText('AgentCanvas building an analytics dashboard live on the canvas')).toBeInTheDocument();
      expect(screen.getByTestId('hero-star')).toHaveAttribute('href', REPO_URL);
      expect(screen.getByTestId('hero-open')).toHaveAttribute('href', '/app');
    });

    it('renders no hero video at all (the static screenshot is the fallback)', () => {
      render(<Hero />);
      expect(screen.queryByTestId('hero-video')).not.toBeInTheDocument();
    });
  });
});
