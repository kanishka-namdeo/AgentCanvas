// Task 6 of the landing-page plan — FeatureGallery (§5.3) + TrustLoop (§5.4).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useReducedMotion } from 'motion/react';
import { FeatureGallery } from '@/components/landing/FeatureGallery';
import { TrustLoop } from '@/components/landing/TrustLoop';

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

describe('landing: FeatureGallery', () => {
  it('renders the section anchor and verbatim heading', () => {
    render(<FeatureGallery />);
    expect(screen.getByTestId('section-tool')).toHaveAttribute('id', 'tool');
    expect(screen.getByRole('heading', { name: 'Not a toy — a Figma-grade tool.' })).toBeInTheDocument();
  });

  it('renders the two bento cards with their copy', () => {
    render(<FeatureGallery />);
    expect(screen.getByText('Figma-grade tooling')).toBeInTheDocument();
    expect(screen.getByText(/Layers, properties, components, auto layout, variables, and gradients/)).toBeInTheDocument();
    expect(screen.getByText('One-shot generators')).toBeInTheDocument();
    expect(screen.getByText(/Flows, wireframes, and mindmaps appear from a single prompt/)).toBeInTheDocument();
  });

  it('renders the attention-heatmap parallax band with alt text and real dims', () => {
    render(<FeatureGallery />);
    const img = screen.getByAltText('Attention heatmap overlay over a zoomed-out AgentCanvas board');
    expect(img).toHaveAttribute('src', '/landing/attention-heatmap.png');
    expect(img).toHaveAttribute('width', '1280');
    expect(img).toHaveAttribute('height', '577');
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('still renders all content statically', () => {
      render(<FeatureGallery />);
      expect(screen.getByText('Figma-grade tooling')).toBeInTheDocument();
      expect(screen.getByAltText('Attention heatmap overlay over a zoomed-out AgentCanvas board')).toBeInTheDocument();
    });
  });
});

describe('landing: TrustLoop', () => {
  it('renders the section anchor and verbatim heading', () => {
    render(<TrustLoop />);
    expect(screen.getByTestId('section-trust')).toHaveAttribute('id', 'trust');
    expect(screen.getByRole('heading', { name: 'You approve. Every time.' })).toBeInTheDocument();
  });

  it('renders the approval-dialog screenshot in a frame with alt text and real dims', () => {
    render(<TrustLoop />);
    const img = screen.getByAltText('Approve destructive operation dialog with Deny and Allow actions');
    expect(img).toHaveAttribute('src', '/landing/approval-dialog.png');
    expect(img).toHaveAttribute('width', '1600');
    expect(img).toHaveAttribute('height', '1000');
  });

  it('renders the four approved trust bullets verbatim', () => {
    render(<TrustLoop />);
    expect(screen.getByText('Destructive-operation gating')).toBeInTheDocument();
    expect(screen.getByText(/the agent cannot delete or overwrite anything without an explicit Allow/i)).toBeInTheDocument();
    expect(screen.getByText('Diff cards')).toBeInTheDocument();
    expect(screen.getByText(/every proposed destructive change is shown as a before\/after diff/i)).toBeInTheDocument();
    expect(screen.getByText('Unattended auto-deny after 5 minutes')).toBeInTheDocument();
    expect(screen.getByText(/a pending approval with no human present is denied, never guessed/i)).toBeInTheDocument();
    expect(screen.getByText('Snapshot audit trail')).toBeInTheDocument();
    expect(screen.getByText(/every approved change is a restorable document snapshot/i)).toBeInTheDocument();
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('still renders the screenshot and bullets', () => {
      render(<TrustLoop />);
      expect(screen.getByAltText('Approve destructive operation dialog with Deny and Allow actions')).toBeInTheDocument();
      expect(screen.getByText('Snapshot audit trail')).toBeInTheDocument();
    });
  });
});
