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
  }) => {
    const src = typeof props.src === 'string' ? props.src : props.src.src;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={props.alt} width={props.width} height={props.height} className={props.className} />;
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
    expect(screen.getByRole('heading', { level: 1, name: 'Design at the speed of thought' })).toBeInTheDocument();
    expect(screen.getByText(/The open-source canvas where the AI agents do the drawing/)).toBeInTheDocument();
    expect(screen.getByTestId('section-hero')).toHaveAttribute('id', 'top');
  });

  it('renders the dual CTAs with the right destinations', () => {
    render(<Hero />);
    expect(screen.getByTestId('hero-star')).toHaveAttribute('href', REPO_URL);
    expect(screen.getByTestId('hero-open')).toHaveAttribute('href', '/app');
  });

  it('shows the hero-build screenshot with alt text at the real 3840x2400 dims', () => {
    render(<Hero />);
    const img = screen.getByAltText('AgentCanvas building a hero section live on the canvas');
    expect(img).toHaveAttribute('src', '/landing/hero-build.png');
    expect(img).toHaveAttribute('width', '3840');
    expect(img).toHaveAttribute('height', '2400');
  });

  it('renders the tool-call chip marquee', () => {
    render(<Hero />);
    expect(screen.getByTestId('hero-chips')).toBeInTheDocument();
    // The Magic UI marquee repeats its children (repeat=4) for the seamless
    // loop, so the chip text matches multiple times — assert on the first.
    expect(screen.getAllByText('pen_create_frame()')[0]).toBeInTheDocument();
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
      expect(screen.getByTestId('hero-typing-static')).toHaveTextContent(
        'Design a mobile login screen with social sign-in…',
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
      expect(screen.getByAltText('AgentCanvas building a hero section live on the canvas')).toBeInTheDocument();
      expect(screen.getByTestId('hero-star')).toHaveAttribute('href', REPO_URL);
      expect(screen.getByTestId('hero-open')).toHaveAttribute('href', '/app');
    });
  });
});
