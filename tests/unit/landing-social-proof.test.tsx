// 2026-09-19 landing uplift — the SocialProof band: GitHub-derived stats
// (disappear entirely when the fetch failed) + the "Built on" marquee whose
// duplicated loop copies are aria-hidden with a single accessible label.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SocialProof } from '@/components/landing/SocialProof';

describe('landing: SocialProof', () => {
  it('renders the GitHub-derived stat tiles plus the AGPL tile when stats exist', () => {
    render(<SocialProof stats={{ stars: 1234, forks: 21, openIssues: 7 }} />);
    expect(screen.getByText('★ 1,234')).toBeInTheDocument();
    expect(screen.getByText('GitHub stars')).toBeInTheDocument();
    expect(screen.getByText('21')).toBeInTheDocument();
    expect(screen.getByText('forks')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('open issues & PRs')).toBeInTheDocument();
    expect(screen.getByText('AGPL-3.0')).toBeInTheDocument();
  });

  it('drops the GitHub tiles when the fetch failed — never fabricated numbers', () => {
    render(<SocialProof stats={null} />);
    expect(screen.queryByText(/GitHub stars/)).not.toBeInTheDocument();
    expect(screen.queryByText('forks')).not.toBeInTheDocument();
    // The band never looks broken: the license tile + marquee remain.
    expect(screen.getByText('AGPL-3.0')).toBeInTheDocument();
  });

  it('hides zero-valued tiles on a fresh repo — shows only real positives', () => {
    render(<SocialProof stats={{ stars: 0, forks: 0, openIssues: 1 }} />);
    expect(screen.queryByText('GitHub stars')).not.toBeInTheDocument();
    expect(screen.queryByText('forks')).not.toBeInTheDocument();
    expect(screen.queryByText('★ 0')).not.toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('open issues & PRs')).toBeInTheDocument();
    expect(screen.getByText('AGPL-3.0')).toBeInTheDocument();
  });

  it('is a non-anchored band (not registered in LANDING_SECTIONS)', () => {
    render(<SocialProof stats={null} />);
    const section = screen.getByTestId('section-social-proof');
    expect(section).not.toHaveAttribute('id');
  });

  it('renders real "Built on" tech names and hides the marquee loop from a11y', () => {
    render(<SocialProof stats={null} />);
    // One accessible source of truth for the list...
    expect(screen.getByText(/Built on: Next.js, React, TypeScript/)).toBeInTheDocument();
    // ...while the looping marquee (each chip duplicated 4x) is decorative.
    const marquee = screen.getByTestId('section-social-proof').querySelector('[aria-hidden="true"]');
    expect(marquee).not.toBeNull();
    expect(marquee?.textContent).toContain('Prisma');
    expect(marquee?.textContent).toContain('Socket.IO');
  });
});
