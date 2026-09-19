// Example tool visualizer for `pen_create_node` — proves the registry pattern.
//
// Instead of the default `<pre>{prettyArgs}</pre>` JSON dump, this card shows
// a compact visual preview: a colored chip with the shape silhouette + the
// dimensions + the layer name. The JSON still renders below (the registry is
// additive — the dispatcher's output sits BETWEEN the existing args pre-block
// and the summary inside `ToolCallEntry`).
//
// This is the template every new visualizer should follow: parse defensively
// (argsPreview may be truncated mid-JSON), render tokens-only (no hardcoded
// colors), and stay O(args) — no store reads, no fetches, no side effects.

import { useMemo } from 'react';
import { defineToolVisualizer, type ToolVisualizerProps } from '../registry';

interface CreateNodeArgs {
  type?: string;
  name?: string;
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  fill?: string;
  stroke?: string;
  textColor?: string;
  text?: string;
  fontSize?: number;
  icon?: string;
  radius?: number;
  rotation?: number;
  [key: string]: unknown;
}

/// Parse `tc.argsPreview` as a CreateNodeArgs object. Returns `null` on any
/// parse failure — the visualizer then renders nothing and the default JSON
/// dump below carries the load. NEVER throw: the parent React tree would
/// unmount the whole tool card.
function parseArgs(raw: string | undefined | null): CreateNodeArgs | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CreateNodeArgs;
    }
    return null;
  } catch {
    // Truncated JSON from the translator (args preview cap) — fall through to
    // the default JSON dump; do not render a broken preview.
    return null;
  }
}

/// Coerce a width/height value that may be a number or a sizing string
/// ("fit_content" / "fill_container") to a short display label.
function sizeLabel(v: number | string | undefined): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v)) : '—';
  // sizing strings — show the raw token; it's the meaningful contract
  return String(v);
}

/// Validate a hex / css color string enough to safely inline as a CSS value.
/// Accepts #rgb / #rrggbb / #rrggbbaa / named colors / var(--…). Rejects
/// anything containing `;` or `}` to prevent CSS injection (defensive — the
/// agent controls this string, not the user).
function safeColor(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  if (v.includes(';') || v.includes('}')) return undefined;
  return v;
}

/// Silhouette path for the shape-type chip — gives the user a glanceable
/// hint of WHAT shape is being created without rendering a full canvas node.
function shapeGlyph(type: string | undefined): string {
  switch (type) {
    case 'ellipse':
      return 'circle';
    case 'text':
      return 'text';
    case 'line':
      return 'line';
    case 'frame':
    case 'group':
    case 'section':
      return 'frame';
    case 'icon':
      return 'icon';
    case 'path':
    case 'polygon':
    case 'star':
      return 'path';
    case 'rectangle':
    default:
      return 'rect';
  }
}

function CreateNodeVisualizer({ tc }: ToolVisualizerProps) {
  const args = useMemo(() => parseArgs(tc.argsPreview), [tc.argsPreview]);

  // useMemo so React doesn't recompute the glyph/safe-color on every parent
  // re-render (the parent re-renders frequently during streaming).
  const view = useMemo(() => {
    if (!args) return null;
    const fill = safeColor(args.fill) ?? 'var(--ac-canvas-default-fill)';
    const stroke = safeColor(args.stroke);
    const textColor = safeColor(args.textColor);
    const type = args.type ?? 'rectangle';
    const glyph = shapeGlyph(type);
    const w = sizeLabel(args.width);
    const h = sizeLabel(args.height);
    const name = typeof args.name === 'string' && args.name ? args.name : null;
    const text = typeof args.text === 'string' && args.text ? args.text : null;
    const icon = typeof args.icon === 'string' && args.icon ? args.icon : null;
    return { fill, stroke, textColor, type, glyph, w, h, name, text, icon };
  }, [args]);

  if (!view) return null;

  return (
    <div
      className="mt-1 flex items-center gap-2 rounded border ac-border-subtle ac-surface-1 p-1.5"
      role="group"
      aria-label={`Visual preview of ${view.type} node`}
    >
      {/* Preview chip — a fixed 32px square showing the actual fill color and
          a shape silhouette. This is the visually distinct part: a glanceable
          colored chip instead of a JSON key/value pair. */}
      <div className="relative h-8 w-8 flex-shrink-0 rounded ac-border-subtle border overflow-hidden ac-surface-2">
        <div
          className="absolute inset-0"
          style={{
            backgroundColor: view.fill,
            borderRadius: view.type === 'ellipse' ? '9999px' : view.type === 'rectangle' ? '2px' : '0',
            border: view.stroke ? `1.5px solid ${view.stroke}` : undefined,
          }}
        />
        {/* Silhouette glyph — text/icon/line types overlay a tiny indicator so
            the chip isn't just an empty color block for non-fill shapes. */}
        {view.glyph === 'text' && (
          <span
            className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold leading-none"
            style={{ color: view.textColor ?? 'var(--ac-text-primary)' }}
            aria-hidden="true"
          >
            T
          </span>
        )}
        {view.glyph === 'icon' && view.icon && (
          <span className="absolute inset-0 flex items-center justify-center text-[7px] ac-text-2 leading-none font-mono truncate px-0.5" aria-hidden="true">
            {view.icon}
          </span>
        )}
        {view.glyph === 'line' && (
          <span
            className="absolute left-1 right-1 top-1/2 h-px -translate-y-1/2"
            style={{ backgroundColor: view.stroke ?? view.fill }}
            aria-hidden="true"
          />
        )}
      </div>

      {/* Metadata column — type + dimensions + optional layer name. */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 text-[10px]">
          <code className="ac-text-1 font-mono uppercase tracking-wide">{view.type}</code>
          <span className="ac-text-4">·</span>
          <span className="ac-text-3 tabular-nums" title="Width × Height in canvas-space px">
            {view.w} × {view.h}
          </span>
          {view.icon && (
            <>
              <span className="ac-text-4">·</span>
              <code className="ac-text-3 font-mono truncate">{view.icon}</code>
            </>
          )}
        </div>
        {(view.name || view.text) && (
          <div className="text-[10px] ac-text-4 truncate" title={view.name ?? view.text ?? ''}>
            {view.name ?? view.text}
          </div>
        )}
      </div>
    </div>
  );
}

// 3-line registration — no edit to dispatcher.tsx required.
defineToolVisualizer({
  toolName: 'pen_create_node',
  Body: CreateNodeVisualizer,
});
