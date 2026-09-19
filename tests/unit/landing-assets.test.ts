// Task 1 of the landing-page plan — asset + dependency contract.
// Everything the landing page consumes must exist on disk and in
// package.json before any component code lands.
// 2026-09-19 video pass: the two legacy `core-*.mp4` b-roll files were deleted
// (one UI generation old, referenced nowhere) and replaced by the verified
// `download/landing-uplift/selected/` cuts copied in under stable names.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

const LANDING_ASSETS = [
  'public/landing/hero-build.png',
  'public/landing/dashboard-complete.png',
  'public/landing/attention-heatmap.png',
  'public/landing/approval-dialog.png',
  'public/landing/build-reveal.mp4',
  'public/landing/build-reveal-poster.png',
  'public/landing/tooling-tour.mp4',
  'public/landing/tooling-tour-poster.png',
  'public/landing/design-pack.mp4',
  'public/landing/design-pack-poster.png',
];

// The clips are served straight from /public (no optimizer), so the byte
// budget is enforced here: ≤3 MB per cut (capture-selection.md §2 byte budget)
// and ≤700 KB for the re-encoded design-pack tile.
const VIDEO_BUDGET_BYTES: Record<string, number> = {
  'public/landing/build-reveal.mp4': 3 * 1024 * 1024,
  'public/landing/tooling-tour.mp4': 3 * 1024 * 1024,
  'public/landing/design-pack.mp4': 700 * 1024,
};

const LANDING_DEPS = [
  'motion',
  'lenis',
  'react-type-animation',
  '@number-flow/react',
  'react-wrap-balancer',
];

const MAGIC_UI_FILES = [
  'src/components/ui/marquee.tsx',
  'src/components/ui/bento-grid.tsx',
  'src/components/ui/border-beam.tsx',
  'src/components/ui/blur-fade.tsx',
  'src/components/ui/scroll-progress.tsx',
];

describe('landing: assets and dependencies', () => {
  it.each(LANDING_ASSETS)('has %s', (asset) => {
    expect(existsSync(resolve(ROOT, asset)), `${asset} must exist`).toBe(true);
  });

  it.each(Object.entries(VIDEO_BUDGET_BYTES))('%s stays inside its byte budget', (asset, budget) => {
    const bytes = statSync(resolve(ROOT, asset)).size;
    expect(bytes, `${asset} is ${Math.round(bytes / 1024)} KB`).toBeLessThanOrEqual(budget);
  });

  it('no longer ships the deleted legacy b-roll', () => {
    for (const asset of ['public/landing/core-agent-chat.mp4', 'public/landing/core-trust-loop.mp4']) {
      expect(existsSync(resolve(ROOT, asset)), `${asset} must stay deleted`).toBe(false);
    }
  });

  it('declares every landing dependency in package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const dep of LANDING_DEPS) {
      expect(pkg.dependencies[dep], `dependencies["${dep}"]`).toBeTruthy();
    }
  });

  it('pins motion to the v12 line (spec decision)', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['motion']).toMatch(/^\^?12\./);
  });

  it('installs the five Magic UI primitives', () => {
    for (const file of MAGIC_UI_FILES) {
      expect(existsSync(resolve(ROOT, file)), `${file} must exist`).toBe(true);
    }
  });
});
