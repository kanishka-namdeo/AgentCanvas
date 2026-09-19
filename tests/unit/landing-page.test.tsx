// Task 8 of the landing-page plan — the landing shell at /.
// lenis is mocked (jsdom has no real layout for a smooth-scroll engine);
// every other piece is the real component tree composed through next/dynamic
// (dynamic chunks resolve async → assertions use findBy*).
// 2026-09-19 uplift: the page fetches GitHub proof stats inside a Suspense
// boundary — global fetch is mocked here so the unit test stays offline and
// deterministic.

import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { render, screen, configure } from '@testing-library/react';
import { metadata, default as LandingPage } from '@/app/page';

// The below-fold sections resolve through real next/dynamic chunks and the
// hero/gallery videos mount effects on top; under full-suite parallel load
// that can exceed RTL's 1s async default (observed flake: section-magic not
// yet mounted). 5s keeps the assertion meaningful while being load-proof.
configure({ asyncUtilTimeout: 5000 });

vi.mock('lenis/react', () => ({
  ReactLenis: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="lenis-root">{children}</div>
  ),
  useLenis: () => null,
}));

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
    return <img src={src} alt={props.alt} width={props.width} height={props.height} className={props.className} />;
  },
}));

vi.mock('@number-flow/react', () => ({
  default: (props: { value: number; suffix?: string; className?: string }) => (
    <span className={props.className}>
      {props.value}
      {props.suffix ?? ''}
    </span>
  ),
}));

const realFetch = global.fetch;
beforeAll(() => {
  // GitHub repo API mock — the page must degrade gracefully without it too
  // (all star segments just disappear), but the happy path exercises wiring.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ stargazers_count: 1234, forks_count: 21, open_issues_count: 7 }),
  }) as unknown as typeof fetch;
});
afterEach(() => {
  vi.clearAllMocks();
});
afterAll(() => {
  global.fetch = realFetch;
});

describe('landing: page metadata', () => {
  it('exports the landing title and description', () => {
    expect(metadata.title).toBe('AgentCanvas — Figma for AI agents');
    expect(typeof metadata.description).toBe('string');
    expect(metadata.description).toContain('AI agents');
  });

  it('opts into the large twitter card', () => {
    // Next 16 types `twitter` as a discriminated union (card is not a shared
    // property of every variant), so assert via toHaveProperty.
    expect(metadata.twitter).toHaveProperty('card', 'summary_large_image');
  });

  it('ships the absolute-URL metadata pack (canonical + OG, 2026-09-19 uplift)', () => {
    expect(metadata.alternates?.canonical).toBe('/');
    expect(metadata.openGraph).toMatchObject({ type: 'website', url: '/', siteName: 'AgentCanvas' });
  });
});

// 20s test budget: the six findBy* waits above can serialize to >5s (vitest
// default) when the suite saturates every worker.
describe('landing: page composition', { timeout: 20000 }, () => {
  it('renders all six sections with their stable ids', async () => {
    render(<LandingPage />);
    expect(await screen.findByTestId('section-hero')).toHaveAttribute('id', 'top');
    expect(await screen.findByTestId('section-magic')).toHaveAttribute('id', 'magic');
    expect(await screen.findByTestId('section-tool')).toHaveAttribute('id', 'tool');
    expect(await screen.findByTestId('section-trust')).toHaveAttribute('id', 'trust');
    expect(await screen.findByTestId('section-how-it-works')).toHaveAttribute('id', 'how-it-works');
    expect(await screen.findByTestId('section-open-source')).toHaveAttribute('id', 'open-source');
  });

  it('renders the header and footer around the sections', async () => {
    render(<LandingPage />);
    expect(await screen.findByTestId('landing-header')).toBeInTheDocument();
    expect(await screen.findByTestId('landing-footer')).toBeInTheDocument();
  });

  it('forces the dark token subtree via the .dark class on the root div', async () => {
    render(<LandingPage />);
    const root = await screen.findByTestId('landing-root');
    expect(root).toHaveClass('dark');
  });

  it('wraps the page in the lenis smooth-scroll provider', async () => {
    render(<LandingPage />);
    expect(await screen.findByTestId('lenis-root')).toBeInTheDocument();
  });

  it('renders exactly one h1 on the page (the hero headline)', async () => {
    render(<LandingPage />);
    await screen.findByTestId('section-open-source');
    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Design at the speed of thought');
  });
});
