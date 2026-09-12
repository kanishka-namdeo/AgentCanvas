// Task 2 of the landing-page plan — route-move contract.
// The workspace must live at src/app/app/page.tsx, be a verbatim copy of the
// old src/app/page.tsx (same client component, same 3-column tabbed layout),
// and carry exactly one functional edit: the brand block links back to /.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function workspaceSource(): string {
  return readFileSync(resolve(ROOT, 'src/app/app/page.tsx'), 'utf8');
}

describe('landing: workspace route move', () => {
  it('serves the workspace from src/app/app/page.tsx', () => {
    expect(existsSync(resolve(ROOT, 'src/app/app/page.tsx'))).toBe(true);
  });

  it('is still the verbatim workspace — client component with the tabbed 3-column layout', () => {
    const source = workspaceSource();
    expect(source.startsWith("'use client'")).toBe(true);
    // Body markers from the moved file (present in the original verbatim).
    expect(source).toContain('ResizablePanelGroup');
    expect(source).toContain('<LeftPanel');
    expect(source).toContain('<RightToolsPanel');
    expect(source).toContain('<Canvas');
  });

  it('does not export metadata (it is a client component — layout metadata applies)', () => {
    const source = workspaceSource();
    expect(source).not.toContain('export const metadata');
    expect(source).not.toContain('generateMetadata');
  });

  it('links the workspace brand back to the landing page', () => {
    const source = workspaceSource();
    expect(source).toContain("import Link from 'next/link'");
    expect(source).toContain('href="/"');
    // The link wraps the brand mark.
    expect(source).toMatch(/<Link href="\/"[\s\S]*AgentCanvas<\/span>\s*<\/Link>/);
  });
});
