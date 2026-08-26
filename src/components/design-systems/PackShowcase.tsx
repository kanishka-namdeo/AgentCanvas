'use client';

// Live preview of components styled with a single design-system pack.
//
// Implementation: render an <iframe srcDoc=...> containing:
//   1. A <style> tag with the pack's tokens.css (raw, using :root —
//      scoped to the iframe's document, so perfectly isolated).
//   2. A small <style> tag with showcase CSS that uses var(--*) tokens.
//   3. HTML for buttons, inputs, cards, tables, badges, avatars —
//      each styled by the showcase CSS, which inherits the active
//      pack's token values.
//
// Why an iframe instead of a wrapper class?
//   - The pack tokens.css uses `:root { ... }` selectors, intended
//     to be injected into a real document root. To preview in the
//     host app, we'd have to rewrite every `:root` to a wrapper
//     class. The iframe gives us a real `:root` for free.
//   - Perfect isolation: switching packs doesn't bleed token changes
//     into the host AgentCanvas (which has its own --ac-* palette).
//   - The agent can use the same srcDoc HTML when committing to a
//     pack: just inject the tokens.css into globals.css and the
//     showcase HTML/CSS into a real page.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PackDetail } from '@/lib/design-systems/types';

interface PackShowcaseProps {
  pack: PackDetail;
  /** Compact = single column of components (for side panels). */
  variant?: 'full' | 'compact';
  className?: string;
}

// Static showcase CSS — uses var(--*) tokens that every pack must define.
// Matches the `Iron rule: never hardcode values`.
const SHOWCASE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 16px;
    background: var(--color-bg);
    color: var(--color-text-primary);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.5;
  }
  h2 {
    margin: 0 0 8px;
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--color-text-primary);
  }
  h3 {
    margin: 16px 0 4px;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  p { margin: 0 0 12px; color: var(--color-text-secondary); }
  .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    margin-bottom: 12px;
  }
  .ds-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: var(--button-padding-y) var(--button-padding-x);
    background: var(--button-bg-secondary);
    color: var(--button-fg-secondary);
    border: 1px solid var(--button-border);
    border-radius: var(--radius-button);
    font-size: var(--button-font-size);
    font-weight: var(--button-font-weight);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: background 120ms ease;
  }
  .ds-button.ds-btn-primary {
    background: var(--button-bg-primary);
    color: var(--button-fg-primary);
    border-color: transparent;
  }
  .ds-button.ds-btn-primary:hover { background: var(--button-bg-primary-hover); }
  .ds-button.ds-btn-secondary:hover { background: var(--color-bg-subtle); }
  .ds-button.ds-btn-ghost {
    background: var(--button-bg-ghost);
    color: var(--button-fg-ghost);
    border-color: transparent;
  }
  .ds-button.ds-btn-ghost:hover { background: var(--color-bg-subtle); }
  .ds-input {
    padding: var(--input-padding-y) var(--input-padding-x);
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: var(--input-radius);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    outline: none;
    min-width: 200px;
  }
  .ds-input:focus {
    border-color: var(--input-border-focus);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--input-border-focus) 25%, transparent);
  }
  .ds-card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius);
    box-shadow: var(--card-shadow);
    padding: var(--card-padding);
    margin-bottom: 12px;
  }
  .ds-card-title {
    margin: 0 0 4px;
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .ds-card-desc {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .ds-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
    background: var(--color-bg);
  }
  .ds-table th {
    background: var(--table-header-bg);
    color: var(--table-header-fg);
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid var(--table-border);
    font-weight: 600;
  }
  .ds-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--table-border);
    color: var(--color-text-primary);
  }
  .ds-table tr:nth-child(odd) td { background: var(--table-row-bg-odd); }
  .ds-table tr:nth-child(even) td { background: var(--table-row-bg-even); }
  .ds-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .ds-badge-success { background: var(--color-success); color: var(--color-text-on-accent); }
  .ds-badge-warning { background: var(--color-warning); color: var(--color-text-primary); }
  .ds-badge-error { background: var(--color-error); color: var(--color-text-on-accent); }
  .ds-avatar {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-pill);
    background: var(--color-accent);
    color: var(--color-accent-fg);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .ds-swatch-row {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }
  .ds-swatch {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-border-default);
  }
  .ds-tabs-list {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--color-border-default);
    margin-bottom: 12px;
  }
  .ds-tab {
    padding: 6px 12px;
    font-size: var(--text-sm);
    background: transparent;
    border: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .ds-tab.ds-tab-active {
    color: var(--color-text-primary);
    border-bottom-color: var(--color-accent);
    font-weight: 600;
  }
`;

// Showcase HTML — references the ds-* classes above.
function showcaseHtml(variant: 'full' | 'compact' = 'full') {
  const compactOnly = variant === 'compact';
  return `
    <h2>Component showcase</h2>
    <p>Every value below comes from this pack's <code>var(--*)</code> tokens — zero hardcoded colors or spacing.</p>

    <h3>Buttons</h3>
    <div class="row">
      <button class="ds-button ds-btn-primary">Primary</button>
      <button class="ds-button ds-btn-secondary">Secondary</button>
      <button class="ds-button ds-btn-ghost">Ghost</button>
      <button class="ds-button ds-btn-primary" disabled>Disabled</button>
    </div>

    <h3>Input</h3>
    <div class="row">
      <input class="ds-input" type="text" placeholder="Type something…" />
    </div>

    ${compactOnly ? '' : `
    <h3>Card</h3>
    <div class="ds-card">
      <div class="ds-card-title">Project status</div>
      <p class="ds-card-desc">3 of 5 tasks complete. On track for Friday release.</p>
      <div class="row" style="margin-bottom:0">
        <button class="ds-button ds-btn-primary">View details</button>
        <button class="ds-button ds-btn-ghost">Dismiss</button>
      </div>
    </div>

    <h3>Table</h3>
    <table class="ds-table">
      <thead>
        <tr><th>Name</th><th>Role</th><th>Status</th></tr>
      </thead>
      <tbody>
        <tr><td>Alex Rivera</td><td>Engineer</td><td><span class="ds-badge ds-badge-success">Active</span></td></tr>
        <tr><td>Sam Cohen</td><td>Designer</td><td><span class="ds-badge ds-badge-warning">Pending</span></td></tr>
        <tr><td>Jordan Lee</td><td>PM</td><td><span class="ds-badge ds-badge-error">Blocked</span></td></tr>
      </tbody>
    </table>
    `}

    <h3>Palette</h3>
    <div class="ds-swatch-row">
      <div class="ds-swatch" style="background: var(--color-bg)" title="bg"></div>
      <div class="ds-swatch" style="background: var(--color-surface)" title="surface"></div>
      <div class="ds-swatch" style="background: var(--color-border-default)" title="border"></div>
      <div class="ds-swatch" style="background: var(--color-text-primary)" title="text"></div>
      <div class="ds-swatch" style="background: var(--color-accent)" title="accent"></div>
      <div class="ds-swatch" style="background: var(--color-success)" title="success"></div>
      <div class="ds-swatch" style="background: var(--color-warning)" title="warning"></div>
      <div class="ds-swatch" style="background: var(--color-error)" title="error"></div>
    </div>

    <h3>Avatars</h3>
    <div class="row">
      <div class="ds-avatar">AR</div>
      <div class="ds-avatar">SC</div>
      <div class="ds-avatar">JL</div>
    </div>

    ${compactOnly ? '' : `
    <h3>Tabs</h3>
    <div class="ds-tabs-list">
      <button class="ds-tab ds-tab-active">Overview</button>
      <button class="ds-tab">Activity</button>
      <button class="ds-tab">Settings</button>
    </div>
    `}
  `;
}

export function PackShowcase({ pack, variant = 'full', className }: PackShowcaseProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(280);

  // Build the srcDoc: tokens + showcase CSS + showcase HTML.
  const srcDoc = useMemo(() => {
    const html = showcaseHtml(variant);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${pack.tokensCss}</style>
  <style>${SHOWCASE_CSS}</style>
</head>
<body>
  ${html}
</body>
</html>`;
  }, [pack.tokensCss, variant]);

  // Auto-resize iframe to fit content (no inner scrollbar).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const resize = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        const height = Math.max(
          doc.body?.scrollHeight ?? 0,
          doc.documentElement?.scrollHeight ?? 0,
        );
        if (height > 0) setIframeHeight(height + 4);
      } catch {
        // Cross-origin — shouldn't happen (srcDoc is same-origin).
      }
    };
    // Run after load + a small delay for fonts/images.
    const onLoad = () => {
      resize();
      setTimeout(resize, 100);
      setTimeout(resize, 500);
    };
    iframe.addEventListener('load', onLoad);
    // Initial resize.
    setTimeout(onLoad, 50);
    return () => iframe.removeEventListener('load', onLoad);
  }, [srcDoc]);

  return (
    <iframe
      ref={iframeRef}
      title={`Live preview of ${pack.name} pack`}
      srcDoc={srcDoc}
      style={{
        width: '100%',
        height: `${iframeHeight}px`,
        border: '1px solid var(--ac-border-default, #e4e4e7)',
        borderRadius: '8px',
        background: pack.palette.background,
      }}
      sandbox="allow-same-origin"
      className={className}
    />
  );
}
