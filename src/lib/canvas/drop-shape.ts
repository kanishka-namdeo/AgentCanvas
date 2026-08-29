// Shared "drop a shape at the viewport center" helper (UI-audit round 2).
//
// Previously this 25-line payload existed TWICE — page.tsx's keymap handler
// and TopMenuBar.tsx's Insert menu — with DIVERGENT color systems: the
// keymap/menu copies hardcoded light-slate hexes (#0f172a / #e2e8f0) while
// Toolbar.tsx used theme tokens. The menu/keyboard copies rendered wrong
// (light) colors in dark mode. This module is the single source of truth,
// token-based like the Toolbar, so every shape-drop surface (Insert menu,
// ⌘K palette, R/O/T/L/F/⇧S/S keyboard chords) creates identical,
// theme-adaptive shapes.

import { useCanvasStore } from '@/lib/canvas/store';
import type { CanvasPatch, Shape } from '@/lib/canvas/types';

/// Per-type drop spec: default size + which token fills the shape. Sizes
/// mirror the keyboard-chord payloads previously hardcoded in page.tsx (the
/// Toolbar's slightly larger click-to-create sizes stay in Toolbar.tsx).
interface DropSpec {
  w?: number;
  h?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  text?: string;
  fontSize?: number;
}

const DROP_SPECS: Partial<Record<Shape['type'], DropSpec>> = {
  rectangle: { w: 100, h: 100, fill: 'var(--ac-canvas-default-fill)', stroke: 'var(--ac-canvas-default-stroke)', strokeWidth: 0 },
  ellipse:   { w: 100, h: 100, fill: 'var(--ac-canvas-accent-fill)', stroke: 'var(--ac-canvas-default-stroke)', strokeWidth: 0 },
  text:      { w: 200, h: 24,  fill: 'var(--ac-canvas-default-text)', stroke: 'var(--ac-canvas-default-stroke)', strokeWidth: 0, text: 'Text', fontSize: 16 },
  line:      { w: 100, h: 0,   fill: 'var(--ac-canvas-default-text)', stroke: 'var(--ac-canvas-default-text)', strokeWidth: 2 },
  frame:     { w: 200, h: 200, fill: 'var(--ac-canvas-bg)', stroke: 'var(--ac-canvas-default-stroke)', strokeWidth: 0 },
  section:   { w: 480, h: 320, fill: 'transparent', stroke: 'var(--ac-canvas-default-stroke)', strokeWidth: 0 },
  slice:     { w: 200, h: 120, fill: 'transparent', stroke: 'var(--ac-canvas-default-stroke)', strokeWidth: 0 },
};

/// Drop `type` at the center of the visible viewport and select it. Reads
/// live store state (no stale closures), emits one `add` patch.
export function dropShapeAtCenter(type: Shape['type'], wOverride?: number, hOverride?: number): void {
  const state = useCanvasStore.getState();
  const spec: DropSpec = DROP_SPECS[type] ?? {};
  const w = wOverride ?? spec.w ?? 100;
  const h = hOverride ?? spec.h ?? 100;
  const vp = state.document.viewport;
  const cx = (-vp.panX + (typeof window !== 'undefined' ? window.innerWidth / 2 : 600)) / vp.zoom;
  const cy = (-vp.panY + (typeof window !== 'undefined' ? window.innerHeight / 2 : 400)) / vp.zoom;
  const newId = `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const patch: CanvasPatch = {
    op: 'add',
    shape: {
      id: newId,
      type,
      name: type.charAt(0).toUpperCase() + type.slice(1),
      x: cx - w / 2,
      y: cy - h / 2,
      width: w,
      height: h,
      fill: spec.fill ?? 'var(--ac-canvas-default-fill)',
      stroke: spec.stroke ?? 'var(--ac-canvas-default-stroke)',
      strokeWidth: spec.strokeWidth ?? 0,
      text: type === 'text' ? (spec.text ?? 'Text') : undefined,
      fontSize: spec.fontSize ?? 16,
      textColor: 'var(--ac-canvas-default-text)',
      radius: 0,
    },
    summary: `Added ${type}`,
  };
  state.sendPatch(patch);
  state.select([newId]);
}

/// The insertable types exposed by the Insert menu / ⌘K palette (pen/path
/// and image intentionally omitted — they route to the chat panel).
export const INSERTABLE_SHAPES: { type: Shape['type']; label: string; shortcut?: string }[] = [
  { type: 'rectangle', label: 'Rectangle', shortcut: 'R' },
  { type: 'ellipse', label: 'Ellipse', shortcut: 'O' },
  { type: 'text', label: 'Text', shortcut: 'T' },
  { type: 'line', label: 'Line', shortcut: 'L' },
  { type: 'frame', label: 'Frame', shortcut: 'F' },
  { type: 'section', label: 'Section', shortcut: '⇧S' },
];
