// generate.ts — synthetic document generator for the DOM-renderer benchmark
// (spec docs/html-dom-renderer.md Appendix F + Phase 0).
//
// Deterministic: same {nodes, screens, seed} → byte-identical CanvasDocument
// (mulberry32 PRNG; no Date.now/Math.random anywhere). Node mix mirrors real
// agent output per Appendix F:
//   40% text, 30% rect/frame, 15% instances, 10% images, 5% paths
//
// Structure: `screens` root frames (one per screen), nodes distributed
// round-robin across them, each node parented to its screen frame so the
// document exercises real DOM nesting. Sizes/positions are random within the
// screen bounds; zIndex follows generation order (stable z-order).
//
// The browser perf runner (Phase 4) is NOT implemented here — see README.md.

import type { CanvasDocument, Layer } from '../../src/lib/canvas/types';

export interface GenerateOptions {
  /// Total node count (excluding the per-screen root frames).
  nodes: number;
  /// Number of screens (root frames).
  screens: number;
  /// PRNG seed — same seed → identical document.
  seed: number;
}

/// Deterministic 32-bit PRNG (mulberry32) — returns floats in [0, 1).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/// Node-mix roll per Appendix F: 40% text, 30% rect/frame (half each),
/// 15% instance, 10% image, 5% path.
function rollType(r: number): Layer['type'] {
  if (r < 0.4) return 'text';
  if (r < 0.55) return 'rectangle';
  if (r < 0.7) return 'frame';
  if (r < 0.85) return 'instance';
  if (r < 0.95) return 'image';
  return 'path';
}

const SCREEN_W = 1440;
const SCREEN_H = 900;
const SCREEN_GAP = 120;

export function generateDocument(opts: GenerateOptions): CanvasDocument {
  const { nodes, screens, seed } = opts;
  const rand = mulberry32(seed);
  const screenCount = Math.max(1, screens);

  const shapes: Layer[] = [];

  // Root frame per screen, laid out horizontally with a gap.
  const screenFrames: Layer[] = [];
  for (let s = 0; s < screenCount; s++) {
    const frame: Layer = {
      id: `screen-${s}`,
      type: 'frame',
      name: `Screen ${s + 1}`,
      x: s * (SCREEN_W + SCREEN_GAP),
      y: 0,
      width: SCREEN_W,
      height: SCREEN_H,
      rotation: 0,
      opacity: 1,
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidth: 0,
      radius: 0,
      fontSize: 16,
      textColor: '#0f172a',
      parentId: null,
      zIndex: s,
      locked: false,
      visible: true,
      autoLayout: null,
      tokenBinding: null,
      componentId: null,
      points: null,
      closed: false,
      src: null,
      radii: null,
      gradient: null,
      shadow: null,
      blur: 0,
      maskId: null,
      clip: true,
    };
    screenFrames.push(frame);
  }
  shapes.push(...screenFrames);

  // Component masters referenced by the instance nodes (15% of the mix).
  const componentIds = ['bench-button', 'bench-card', 'bench-input'];

  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  for (let i = 0; i < nodes; i++) {
    const screen = screenFrames[i % screenCount];
    const type = rollType(rand());
    const x = screen.x + Math.floor(rand() * (SCREEN_W - 320));
    const y = Math.floor(rand() * (SCREEN_H - 240));
    const width = 80 + Math.floor(rand() * 240);
    const height = 24 + Math.floor(rand() * 160);

    const layer: Layer = {
      id: `n${i}`,
      type,
      name: `${type}-${i}`,
      x,
      y,
      width,
      height,
      rotation: 0,
      opacity: 1,
      fill: type === 'text' ? '#0f172a' : '#e2e8f0',
      stroke: '#64748b',
      strokeWidth: 0,
      radius: type === 'rectangle' || type === 'frame' ? 8 : 0,
      text: type === 'text' ? `Label ${i}` : undefined,
      fontSize: 14 + Math.floor(rand() * 18),
      textColor: '#0f172a',
      fontWeight: type === 'text' ? pick([400, 500, 600, 700]) : undefined,
      parentId: screen.id,
      zIndex: screenCount + i, // above the screen frames, generation order
      locked: false,
      visible: true,
      autoLayout: null,
      tokenBinding: null,
      componentId: type === 'instance' ? pick(componentIds) : null,
      points:
        type === 'path'
          ? [
              { x, y },
              { x: x + width, y: y + height / 2 },
              { x, y: y + height },
            ]
          : null,
      closed: type === 'path' ? rand() < 0.5 : false,
      src: type === 'image' ? `https://example.com/bench/${i}.png` : null,
      radii: null,
      gradient: null,
      shadow: null,
      blur: 0,
      maskId: null,
    };
    shapes.push(layer);
  }

  return {
    id: `bench-${nodes}-${screens}-${seed}`,
    name: `Bench ${nodes}n/${screens}s/seed${seed}`,
    version: '2.17',
    children: [],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    background: '#ffffff',
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}
