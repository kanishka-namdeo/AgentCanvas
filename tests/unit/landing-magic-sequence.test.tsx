// Task 5 of the landing-page plan — the sticky Magic sequence (spec §5.2),
// rebuilt into a 3-state scroll-telling sequence in the 2026-09-19 uplift.

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

  it('gives the section a tall scroll track so the crossfade spans the pin range', () => {
    render(<MagicSequence />);
    const track = screen.getByTestId('section-magic').querySelector('.md\\:h-\\[250vh\\]');
    expect(track).not.toBeNull();
  });

  it('types the step-1 prompt with the typing animation (spec §5.2 step 1)', () => {
    render(<MagicSequence />);
    expect(screen.getByTestId('magic-typing')).toBeInTheDocument();
    // TypeAnimation types asynchronously — it renders empty on first paint;
    // the prompt COPY is asserted on the reduced-motion static branch below.
  });

  it('renders all three crossfade layers (build → working → done)', () => {
    render(<MagicSequence />);
    const build = screen.getByAltText('AgentCanvas building a hero section live on the canvas');
    const done = screen.getByAltText('Completed dashboard design with the agent task list visible');
    expect(build).toHaveAttribute('src', '/landing/hero-build.png');
    expect(done).toHaveAttribute('src', '/landing/dashboard-complete.png');
    expect(screen.getByTestId('magic-frame-build')).toBeInTheDocument();
    expect(screen.getByTestId('magic-frame-work')).toBeInTheDocument();
    expect(screen.getByTestId('magic-frame-done')).toBeInTheDocument();
    // The middle state is the diegetic agent-timeline mock.
    expect(screen.getByTestId('agent-timeline')).toBeInTheDocument();
  });

  it('frames the screenshots with the bottom-crop viewport (toast artifact treatment)', () => {
    render(<MagicSequence />);
    const frame = screen.getByTestId('browser-frame');
    expect(frame.getAttribute('data-crop')).toBe('bottom');
    const viewport = frame.lastElementChild as HTMLElement;
    expect(viewport.style.aspectRatio).toBe('4 / 3');
  });

  it('bounds the image srcset with a sizes hint (perf, audit #4)', () => {
    render(<MagicSequence />);
    const build = screen.getByAltText('AgentCanvas building a hero section live on the canvas');
    expect(build.getAttribute('data-sizes')).toBe('(max-width: 767px) 100vw, 50vw');
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
      expect(screen.queryByTestId('magic-frame-work')).not.toBeInTheDocument();
      expect(screen.queryByTestId('magic-frame-done')).not.toBeInTheDocument();
    });

    it('renders the full step-1 prompt statically instead of the typing effect', () => {
      render(<MagicSequence />);
      expect(screen.getByTestId('magic-typing-static')).toHaveTextContent(
        'Design a hero section with a gradient headline…',
      );
      expect(screen.queryByTestId('magic-typing')).not.toBeInTheDocument();
    });

    it('still renders the steps', () => {
      render(<MagicSequence />);
      expect(screen.getByText('Agent plans and builds')).toBeInTheDocument();
    });
  });
});
