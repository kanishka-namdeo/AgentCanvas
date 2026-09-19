// Task 3 of the landing-page plan — shared landing primitives.
// Covers the repo-URL constants, the BrowserFrame crop contract, the header
// anchors/CTAs (incl. the live star chip), the GitHubStars proof component,
// and the footer. next/image is mocked to a plain <img> so alt/src assertions
// are direct (house suite has no next/image precedent).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { REPO_URL, REPO_CLONE_URL, SITE_URL } from '@/components/landing/repo-url';
import { BrowserFrame } from '@/components/landing/BrowserFrame';
import { LandingHeader, LANDING_SECTIONS } from '@/components/landing/LandingHeader';
import { LandingFooter } from '@/components/landing/LandingFooter';
import {
  GitHubStars,
  fetchGitHubStats,
  formatStarCount,
  hasStars,
} from '@/components/landing/GitHubStars';

vi.mock('next/image', () => ({
  default: (props: {
    src: string | { src: string };
    alt: string;
    width?: number;
    height?: number;
    className?: string;
  }) => {
    const src = typeof props.src === 'string' ? props.src : props.src.src;
    return <img src={src} alt={props.alt} width={props.width} height={props.height} className={props.className} />;
  },
}));

// LandingHeader reads useLenis() — without a lenis provider (reduced-motion
// path) it returns null and anchor clicks fall back to native scrolling.
vi.mock('lenis/react', () => ({
  ReactLenis: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useLenis: () => null,
}));

describe('landing: repo-url constants', () => {
  it('defines the canonical repo URL exactly once', () => {
    expect(REPO_URL).toBe('https://github.com/kanishka-namdeo/AgentCanvas');
    expect(REPO_CLONE_URL).toBe('https://github.com/kanishka-namdeo/AgentCanvas.git');
  });

  it('exposes an absolute SITE_URL for metadata (never localhost)', () => {
    expect(SITE_URL).toMatch(/^https:\/\//);
    expect(SITE_URL).not.toContain('localhost');
  });
});

describe('landing: BrowserFrame', () => {
  it('renders a light-chrome frame with the default 16 / 10 viewport', () => {
    render(
      <BrowserFrame>
        <img src="/landing/hero-build.png" alt="demo screenshot" />
      </BrowserFrame>,
    );
    const frame = screen.getByTestId('browser-frame');
    expect(frame).toBeInTheDocument();
    expect(frame.getAttribute('data-crop')).toBe('none');
    const viewport = frame.lastElementChild as HTMLElement;
    expect(viewport.style.aspectRatio).toBe('16 / 10');
    expect(screen.getByAltText('demo screenshot')).toBeInTheDocument();
  });

  it('supports the bottom-crop treatment (spec §6 toast artifact)', () => {
    render(
      <BrowserFrame aspectRatio="4 / 3" crop="bottom">
        <img src="/landing/dashboard-complete.png" alt="cropped screenshot" />
      </BrowserFrame>,
    );
    const frame = screen.getByTestId('browser-frame');
    expect(frame.getAttribute('data-crop')).toBe('bottom');
    const viewport = frame.lastElementChild as HTMLElement;
    expect(viewport.style.aspectRatio).toBe('4 / 3');
    // The light bottom fade that blends the cropped edge.
    expect(viewport.lastElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('applies a passthrough className', () => {
    render(
      <BrowserFrame className="mt-8 w-full max-w-4xl">
        <img src="/x.png" alt="frame" />
      </BrowserFrame>,
    );
    expect(screen.getByTestId('browser-frame')).toHaveClass('mt-8');
  });
});

describe('landing: GitHubStars', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('formats counts with US grouping', () => {
    expect(formatStarCount(1234)).toBe('1,234');
    expect(formatStarCount(0)).toBe('0');
  });

  it('renders the ★ count segment and nothing without a count', () => {
    const { rerender } = render(<GitHubStars stars={1234} />);
    expect(screen.getByTestId('github-stars')).toHaveTextContent('1,234');
    rerender(<GitHubStars stars={null} />);
    expect(screen.queryByTestId('github-stars')).not.toBeInTheDocument();
    rerender(<GitHubStars />);
    expect(screen.queryByTestId('github-stars')).not.toBeInTheDocument();
  });

  it('suppresses a zero count — ★ 0 is anti-proof, not proof', () => {
    render(<GitHubStars stars={0} />);
    expect(screen.queryByTestId('github-stars')).not.toBeInTheDocument();
    expect(hasStars(0)).toBe(false);
    expect(hasStars(3)).toBe(true);
    expect(hasStars(null)).toBe(false);
    expect(hasStars(undefined)).toBe(false);
  });

  it('fetches stars/forks/issues from the parsed REPO_URL', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ stargazers_count: 1234, forks_count: 21, open_issues_count: 7 }),
    }) as unknown as typeof fetch;
    await expect(fetchGitHubStats()).resolves.toEqual({ stars: 1234, forks: 21, openIssues: 7 });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/kanishka-namdeo/AgentCanvas',
      expect.objectContaining({ next: { revalidate: 3600 } }),
    );
  });

  it('returns null on non-OK responses (rate limit) — never a fabricated count', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
    await expect(fetchGitHubStats()).resolves.toBeNull();
  });

  it('returns null when the network fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(fetchGitHubStats()).resolves.toBeNull();
  });

  it('returns null on an unexpected payload', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    await expect(fetchGitHubStats()).resolves.toBeNull();
  });
});

describe('landing: LandingHeader', () => {
  it('renders the logo, section anchors, star link, and /app CTA', () => {
    render(<LandingHeader />);
    expect(screen.getByAltText('AgentCanvas logo')).toBeInTheDocument();
    for (const section of LANDING_SECTIONS) {
      expect(screen.getByRole('link', { name: section.label })).toHaveAttribute('href', `#${section.id}`);
    }
    expect(screen.getByTestId('header-star')).toHaveAttribute('href', REPO_URL);
    expect(screen.getByTestId('header-star')).toHaveTextContent('Star');
    expect(screen.getByTestId('header-open')).toHaveAttribute('href', '/app');
  });

  it('shows the live star count in the chip when the fetch succeeded', () => {
    render(<LandingHeader stars={1234} />);
    expect(screen.getByTestId('header-star')).toHaveTextContent('1,234');
    expect(screen.getByTestId('header-star')).toHaveAttribute('href', REPO_URL);
  });

  it('anchors exactly to the five below-hero section ids', () => {
    expect(LANDING_SECTIONS.map((s) => s.id)).toEqual([
      'magic',
      'tool',
      'trust',
      'how-it-works',
      'open-source',
    ]);
  });
});

describe('landing: LandingFooter', () => {
  it('renders the logo, AGPL-3.0 line, and GitHub link', () => {
    render(<LandingFooter />);
    expect(screen.getByAltText('AgentCanvas logo')).toBeInTheDocument();
    expect(screen.getByText(/AGPL-3\.0/)).toBeInTheDocument();
    expect(screen.getByTestId('footer-github')).toHaveAttribute('href', REPO_URL);
  });
});
