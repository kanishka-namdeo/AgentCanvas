// Task 5 of the landing-page plan — the sticky Magic sequence (spec §5.2).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useReducedMotion } from 'motion/react';
import { MagicSequence } from '@/components/landing/MagicSequence';

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

describe('landing: MagicSequence', () => {
  it('renders the section anchor and heading', () => {
    render(<MagicSequence />);
    expect(screen.getByTestId('section-magic')).toHaveAttribute('id', 'magic');
    expect(screen.getByRole('heading', { name: 'Describe it. Watch it appear.' })).toBeInTheDocument();
  });

  it('renders the three steps in order', () => {
    render(<MagicSequence />);
    expect(screen.getByText('Prompt typed')).toBeInTheDocument();
    expect(screen.getByText('Agent plans and builds')).toBeInTheDocument();
    expect(screen.getByText('Dashboard complete')).toBeInTheDocument();
  });

  it('crossfade variant renders both screenshots (motion layers stacked in one sticky frame)', () => {
    render(<MagicSequence />);
    const build = screen.getByAltText('AgentCanvas building a hero section live on the canvas');
    const done = screen.getByAltText('Completed dashboard design with the agent task list visible');
    expect(build).toHaveAttribute('src', '/landing/hero-build.png');
    expect(done).toHaveAttribute('src', '/landing/dashboard-complete.png');
    expect(screen.getByTestId('magic-frame-build')).toBeInTheDocument();
    expect(screen.getByTestId('magic-frame-done')).toBeInTheDocument();
  });

  it('frames the screenshots with the bottom-crop viewport (toast artifact treatment)', () => {
    render(<MagicSequence />);
    const frame = screen.getByTestId('browser-frame');
    expect(frame.getAttribute('data-crop')).toBe('bottom');
    const viewport = frame.lastElementChild as HTMLElement;
    expect(viewport.style.aspectRatio).toBe('4 / 3');
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('renders only the final screenshot statically', () => {
      render(<MagicSequence />);
      expect(screen.getByTestId('magic-final-static')).toBeInTheDocument();
      expect(screen.getByAltText('Completed dashboard design with the agent task list visible')).toBeInTheDocument();
      expect(screen.queryByTestId('magic-frame-build')).not.toBeInTheDocument();
      expect(screen.queryByTestId('magic-frame-done')).not.toBeInTheDocument();
    });

    it('still renders the steps', () => {
      render(<MagicSequence />);
      expect(screen.getByText('Agent plans and builds')).toBeInTheDocument();
    });
  });
});
