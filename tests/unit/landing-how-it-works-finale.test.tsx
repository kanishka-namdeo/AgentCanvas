// Task 7 of the landing-page plan — HowItWorks (§5.5) + OpenSourceFinale (§5.6).
// The 2026-09-19 uplift changed the stats contract: SSR/no-JS render the FINAL
// values (no "0 typed tools" flash, audit #6); the count-up is a client
// enhancement gated on useInView.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useInView, useReducedMotion } from 'motion/react';
import { REPO_URL } from '@/components/landing/repo-url';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { OpenSourceFinale } from '@/components/landing/OpenSourceFinale';

// NumberFlow upgrades a web component that jsdom can't render meaningfully —
// mock it to a span carrying the value so stat assertions are deterministic.
vi.mock('@number-flow/react', () => ({
  default: (props: { value: number; suffix?: string; 'data-testid'?: string; className?: string }) => (
    <span data-testid={props['data-testid'] ?? 'number-flow'} className={props.className}>
      {props.value}
      {props.suffix ?? ''}
    </span>
  ),
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return {
    ...actual,
    useReducedMotion: vi.fn(() => false),
    useInView: vi.fn(() => false),
  };
});

const useReducedMotionMock = vi.mocked(useReducedMotion);
const useInViewMock = vi.mocked(useInView);

beforeEach(() => {
  useReducedMotionMock.mockReturnValue(false);
  useInViewMock.mockReturnValue(false);
});

describe('landing: HowItWorks', () => {
  it('renders the section anchor and heading', () => {
    render(<HowItWorks />);
    expect(screen.getByTestId('section-how-it-works')).toHaveAttribute('id', 'how-it-works');
    expect(screen.getByRole('heading', { name: 'How it works' })).toBeInTheDocument();
  });

  it('renders the CSS/flex diagram boxes in flow order with mono labels', () => {
    render(<HowItWorks />);
    expect(screen.getByTestId('flow-prompt')).toHaveTextContent('Prompt');
    expect(screen.getByTestId('flow-agent')).toHaveTextContent('Agent');
    expect(screen.getByTestId('flow-tools')).toHaveTextContent('Tools');
    expect(screen.getByTestId('flow-canvas')).toHaveTextContent('Canvas');
  });

  it('ships the FINAL stat values in the initial (SSR) render — no zero flash', () => {
    render(<HowItWorks />);
    expect(screen.getByTestId('stat-tools')).toHaveTextContent('60+');
    expect(screen.getByTestId('stat-providers')).toHaveTextContent('28');
  });

  it('counts up 0 → final when the stats scroll into view (motion allowed)', async () => {
    const { rerender } = render(<HowItWorks />);
    // Entering the viewport flips the counters into count-up mode: they
    // remount at 0 and the mount timer animates them back to the finals.
    useInViewMock.mockReturnValue(true);
    rerender(<HowItWorks />);
    await waitFor(() => {
      expect(screen.getByTestId('stat-tools')).toHaveTextContent('60+');
      expect(screen.getByTestId('stat-providers')).toHaveTextContent('28');
    });
  });

  it('keeps the final values statically under reduced motion', () => {
    useReducedMotionMock.mockReturnValue(true);
    render(<HowItWorks />);
    expect(screen.getByTestId('stat-tools')).toHaveTextContent('60+');
    expect(screen.getByTestId('stat-providers')).toHaveTextContent('28');
  });

  it('renders the remaining developer-depth chips', () => {
    render(<HowItWorks />);
    expect(screen.getByText('Portable canvas format')).toBeInTheDocument();
    expect(screen.getByText('Sessions + snapshots')).toBeInTheDocument();
    expect(screen.getByText('Socket.IO realtime')).toBeInTheDocument();
    expect(screen.getByText('Copy as HTML / React / Tailwind')).toBeInTheDocument();
  });
});

describe('landing: OpenSourceFinale', () => {
  it('renders the section anchor and verbatim heading', () => {
    render(<OpenSourceFinale />);
    expect(screen.getByTestId('section-open-source')).toHaveAttribute('id', 'open-source');
    expect(screen.getByRole('heading', { name: 'Open source. AGPL-3.0. Free forever.' })).toBeInTheDocument();
  });

  it('renders the clone command from the shared REPO_URL constant', () => {
    render(<OpenSourceFinale />);
    expect(screen.getByTestId('clone-command')).toHaveTextContent(
      'git clone https://github.com/kanishka-namdeo/AgentCanvas.git',
    );
  });

  it('copies the clone command and flips the copied state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    try {
      render(<OpenSourceFinale />);
      const button = screen.getByTestId('copy-clone');
      expect(button.getAttribute('data-copied')).toBe('false');
      fireEvent.click(button);
      expect(writeText).toHaveBeenCalledWith('git clone https://github.com/kanishka-namdeo/AgentCanvas.git');
      await waitFor(() => {
        expect(button.getAttribute('data-copied')).toBe('true');
      });
    } finally {
      // Remove the instance property so other tests see stock jsdom navigator.
      delete (window.navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  it('renders the star button (with the live count when provided) and the final /app CTA', () => {
    const { rerender } = render(<OpenSourceFinale />);
    expect(screen.getByTestId('finale-star')).toHaveAttribute('href', REPO_URL);
    expect(screen.getByTestId('finale-star')).toHaveTextContent('Star on GitHub');
    expect(screen.getByTestId('finale-open')).toHaveAttribute('href', '/app');
    rerender(<OpenSourceFinale stars={1234} />);
    expect(screen.getByTestId('finale-star')).toHaveTextContent('1,234');
  });
});
