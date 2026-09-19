import { REPO_URL } from './repo-url';

/**
 * GitHub proof furniture (2026-09-19 landing-uplift P0).
 *
 * `fetchGitHubStats` is the server half: ONE GET to the GitHub repo API with
 * ISR (`next: { revalidate: 3600 }`), parsed from REPO_URL so the URL literal
 * is never re-typed. It returns `null` on ANY failure (network, rate limit,
 * unexpected payload) — callers must degrade gracefully and must NEVER fall
 * back to a hardcoded count (a wrong number is worse than no number).
 *
 * `GitHubStars` is the presentational half — a small `★ 1,234` segment that
 * renders nothing when no count is available. The landing sections are client
 * components, so `src/app/page.tsx` (server) awaits the fetch and passes the
 * numbers down as props.
 */

interface GitHubRepo {
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
}

export interface GitHubStats {
  stars: number;
  forks: number;
  /** Includes PRs — GitHub's `open_issues_count` semantics; labeled honestly. */
  openIssues: number;
}

function parseOwnerRepo(): string | null {
  const match = REPO_URL.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/);
  return match ? `${match[1]}/${match[2]}` : null;
}

export async function fetchGitHubStats(): Promise<GitHubStats | null> {
  const repo = parseOwnerRepo();
  if (!repo) return null;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: 3600 },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as GitHubRepo;
    const { stargazers_count: stars, forks_count: forks, open_issues_count: openIssues } = data;
    if (typeof stars !== 'number' || stars < 0) return null;
    return {
      stars,
      forks: typeof forks === 'number' && forks >= 0 ? forks : 0,
      openIssues: typeof openIssues === 'number' && openIssues >= 0 ? openIssues : 0,
    };
  } catch {
    return null;
  }
}

/** `1234` → `1,234`. */
export function formatStarCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Star PROOF only exists above zero: `★ 0` is anti-proof, so every star
 * segment across the page is gated on this — a fresh repo shows the rest of
 * the proof row (license, tools, providers) and simply omits the count. */
export function hasStars(stars?: number | null): stars is number {
  return typeof stars === 'number' && stars > 0;
}

export function GitHubStars({ stars, className }: { stars?: number | null; className?: string }) {
  if (!hasStars(stars)) return null;
  return (
    <span
      data-testid="github-stars"
      className={`inline-flex items-center gap-1 [font-family:var(--font-geist-mono),monospace] ${className ?? ''}`}
    >
      <span aria-hidden="true">★</span>
      {formatStarCount(stars)}
    </span>
  );
}
