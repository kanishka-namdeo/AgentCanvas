// Task 1 of the landing-page plan — asset + dependency contract.
// Everything the landing page consumes must exist on disk and in
// package.json before any component code lands.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

const LANDING_ASSETS = [
  'public/landing/hero-build.png',
  'public/landing/dashboard-complete.png',
  'public/landing/attention-heatmap.png',
  'public/landing/approval-dialog.png',
  'public/landing/core-agent-chat.mp4',
  'public/landing/core-trust-loop.mp4',
];

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
