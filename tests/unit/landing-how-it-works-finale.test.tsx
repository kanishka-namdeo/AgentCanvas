// Task 7 of the landing-page plan — HowItWorks (§5.5) + OpenSourceFinale (§5.6).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

  it('animates the stats to the final values (60+ tools, 28 providers)', async () => {
    vi.useFakeTimers();
    try {
      render(<HowItWorks />);
      // Values start at 0 and count up after the mount delay.
      expect(screen.getByTestId('stat-tools')).toHaveTextContent('0+');
      expect(screen.getByTestId('stat-providers')).toHaveTextContent('0');
      // Vitest 5 fakes setInterval too, so waitFor cannot poll under fake
      // timers — flush the 300ms mount timer inside act, then restore real
      // timers so waitFor (and later tests) run on the real clock.
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      vi.useRealTimers();
      await waitFor(() => {
        expect(screen.getByTestId('stat-tools')).toHaveTextContent('60+');
        expect(screen.getByTestId('stat-providers')).toHaveTextContent('28');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the remaining developer-depth chips', () => {
    render(<HowItWorks />);
    expect(screen.getByText('.pen file format')).toBeInTheDocument();
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
      'git clone https://github.com/kanishka-namdeo/co-canvas.git',
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
      expect(writeText).toHaveBeenCalledWith('git clone https://github.com/kanishka-namdeo/co-canvas.git');
      await waitFor(() => {
        expect(button.getAttribute('data-copied')).toBe('true');
      });
    } finally {
      // Remove the instance property so other tests see stock jsdom navigator.
      delete (window.navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  it('renders the star button and the final /app CTA', () => {
    render(<OpenSourceFinale />);
    expect(screen.getByTestId('finale-star')).toHaveAttribute('href', REPO_URL);
    expect(screen.getByTestId('finale-open')).toHaveAttribute('href', '/app');
  });
});
