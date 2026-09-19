// Task 6 of the landing-page plan — FeatureGallery (§5.3) + TrustLoop (§5.4).
// FeatureGallery grew from 2 to 5 bento tiles in the 2026-09-19 uplift.

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
    sizes?: string;
    'data-testid'?: string;
    'aria-hidden'?: boolean | 'true' | 'false';
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
        data-testid={props['data-testid']}
        aria-hidden={props['aria-hidden']}
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

describe('landing: FeatureGallery', () => {
  it('renders the section anchor and verbatim heading', () => {
    render(<FeatureGallery />);
    expect(screen.getByTestId('section-tool')).toHaveAttribute('id', 'tool');
    expect(screen.getByRole('heading', { name: 'Not a toy — a Figma-grade tool.' })).toBeInTheDocument();
  });

  it('renders all five bento tiles with their copy', () => {
    render(<FeatureGallery />);
    expect(screen.getByText('Figma-grade tooling')).toBeInTheDocument();
    expect(screen.getByText(/Layers, properties, components, auto layout, variables, and gradients/)).toBeInTheDocument();
    expect(screen.getByText('One-shot generators')).toBeInTheDocument();
    expect(screen.getByText(/Flows, wireframes, and mindmaps appear from a single prompt/)).toBeInTheDocument();
    expect(screen.getByText('Design systems built in')).toBeInTheDocument();
    expect(screen.getByText(/Five production token packs ship in the box/)).toBeInTheDocument();
    expect(screen.getByText('.pen file format')).toBeInTheDocument();
    expect(screen.getByText(/20 node types, diffable and restorable/)).toBeInTheDocument();
    expect(screen.getByText('Sessions & snapshots')).toBeInTheDocument();
    expect(screen.getByText(/every approved change is a restorable snapshot/)).toBeInTheDocument();
  });

  it('gives every bento tile an always-visible /app CTA', () => {
    render(<FeatureGallery />);
    const ctas = screen.getAllByRole('link', { name: /Open the canvas/ });
    expect(ctas).toHaveLength(5);
    for (const cta of ctas) {
      expect(cta).toHaveAttribute('href', '/app');
    }
  });

  it('renders the attention-heatmap parallax band with alt text and real dims', () => {
    render(<FeatureGallery />);
    const img = screen.getByAltText('Attention heatmap overlay over a zoomed-out AgentCanvas board');
    expect(img).toHaveAttribute('src', '/landing/attention-heatmap.png');
    expect(img).toHaveAttribute('width', '1280');
    expect(img).toHaveAttribute('height', '577');
    expect(img.getAttribute('data-sizes')).toBe('(max-width: 767px) 100vw, 1152px');
  });

  // 2026-09-19 video pass — the "product in motion" 2-up row
  // (capture-selection.md §4). NOTE React sets `muted` as a DOM property
  // (never an attribute), so that one is asserted on the element.
  it('renders the two motion frames with their clips and poster stills', () => {
    render(<FeatureGallery />);
    expect(screen.getByTestId('gallery-motion-row')).toBeInTheDocument();

    const tooling = screen.getByTestId('gallery-video-tooling') as HTMLVideoElement;
    expect(tooling).toHaveAttribute('src', '/landing/tooling-tour.mp4');
    expect(tooling).toHaveAttribute('poster', '/landing/tooling-tour-poster.png');

    const designPack = screen.getByTestId('gallery-video-design-pack') as HTMLVideoElement;
    expect(designPack).toHaveAttribute('src', '/landing/design-pack.mp4');
    expect(designPack).toHaveAttribute('poster', '/landing/design-pack-poster.png');

    for (const video of [tooling, designPack]) {
      // Lazy: preload="none" keeps the MP4s off the wire until the row is reached.
      expect(video).toHaveAttribute('preload', 'none');
      expect(video).toHaveAttribute('loop');
      expect(video).toHaveAttribute('playsinline');
      expect(video).toHaveAttribute('aria-hidden', 'true');
      expect(video).toHaveAttribute('tabindex', '-1');
      expect(video.muted).toBe(true);
      expect(video.className).toContain('absolute inset-0');
    }
  });

  it('gives each motion frame a real caption (the video is decorative)', () => {
    render(<FeatureGallery />);
    expect(screen.getByTestId('gallery-caption-tooling')).toHaveTextContent(
      '⌘K command palette, layers reparented by drag, property edits, and snapping guides',
    );
    expect(screen.getByTestId('gallery-caption-design-pack')).toHaveTextContent(
      'Pick a design system pack — every screen on the canvas follows its tokens.',
    );
  });

  it('places the motion row between the bento grid and the heatmap band', () => {
    render(<FeatureGallery />);
    const row = screen.getByTestId('gallery-motion-row');
    const lastBentoCta = screen.getAllByRole('link', { name: /Open the canvas/ })[4];
    const heatmap = screen.getByAltText(
      'Attention heatmap overlay over a zoomed-out AgentCanvas board',
    );
    expect(lastBentoCta.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(heatmap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

    it('swaps both motion frames for their poster stills (no autoplay anywhere)', () => {
      render(<FeatureGallery />);
      expect(screen.queryByTestId('gallery-video-tooling')).not.toBeInTheDocument();
      expect(screen.queryByTestId('gallery-video-design-pack')).not.toBeInTheDocument();

      const toolingPoster = screen.getByTestId('gallery-poster-tooling');
      expect(toolingPoster).toHaveAttribute('src', '/landing/tooling-tour-poster.png');
      expect(toolingPoster).toHaveAttribute('width', '1600');
      expect(toolingPoster).toHaveAttribute('height', '1000');

      const designPackPoster = screen.getByTestId('gallery-poster-design-pack');
      expect(designPackPoster).toHaveAttribute('src', '/landing/design-pack-poster.png');
      expect(designPackPoster).toHaveAttribute('width', '1600');
      expect(designPackPoster).toHaveAttribute('height', '1000');

      // The captions are the accessible text in both branches.
      expect(screen.getByTestId('gallery-caption-tooling')).toHaveTextContent('snapping guides');
      expect(screen.getByTestId('gallery-caption-design-pack')).toHaveTextContent(
        'every screen on the canvas follows its tokens',
      );
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

  it('zooms the small dialog region via CSS only (audit #16)', () => {
    render(<TrustLoop />);
    const img = screen.getByAltText('Approve destructive operation dialog with Deny and Allow actions');
    expect(img).toHaveClass('scale-[2]');
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
