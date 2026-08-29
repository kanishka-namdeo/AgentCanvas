'use client';

// Floating toolbar — quick actions to manually create shapes (for the human
// user; the agent has its own tools). Rendered as a horizontal pill that
// floats at the bottom-center of the canvas, following the tldraw / Excalidraw
// pattern. The toolbar sits above canvas content (high z-index) and uses
// subtle shadow + border for separation from the canvas background.
//
// Tool mode buttons (Select / Pan) toggle the canvas store's `toolMode`
// field. The Canvas component reads this to decide whether click-drag
// selects shapes or pans the viewport. Space-held still overrides to pan
// temporarily (see Canvas.tsx).
//
// Placement note: the parent (in page.tsx) renders <Toolbar /> inside the
// canvas's relatively-positioned container, so `absolute bottom-4 left-1/2`
// here is relative to that container — i.e. the toolbar floats over the
// canvas, not the whole window.

import { useCanvasStore } from '@/lib/canvas/store';
import type { CanvasPatch, LayerType } from '@/lib/canvas/types';
import { Button } from '@/components/ui/button';
import {
  Square,
  Circle,
  Type,
  Minus,
  Frame,
  MousePointer2,
  Hand,
  Scaling,
  Section as SectionIcon,
} from 'lucide-react';

const SHAPE_DEFAULTS: Record<LayerType, Partial<{ width: number; height: number; fill: string; text: string; fontSize: number; stroke: string }>> = {
  rectangle: { width: 160, height: 100, fill: 'var(--ac-canvas-default-fill)' },
  ellipse:   { width: 120, height: 120, fill: 'var(--ac-canvas-accent-fill)' },
  text:      { width: 200, height: 32,  fill: 'var(--ac-canvas-default-text)', text: 'Text', fontSize: 20 },
  line:      { width: 120, height: 0,   fill: 'var(--ac-canvas-default-text)' },
  frame:     { width: 320, height: 240, fill: 'var(--ac-canvas-bg)' },
  group:     { width: 240, height: 160, fill: 'transparent', stroke: 'var(--ac-canvas-default-stroke)' },
  path:      { width: 120, height: 120, fill: 'var(--ac-canvas-default-fill)' },
  image:     { width: 160, height: 100, fill: 'var(--ac-canvas-default-fill)' },
  // Figma ontology types (not in the default toolbar, but supported by the
  // agent tools and by the `add` patch op).
  section:           { width: 480, height: 320, fill: 'transparent', stroke: 'var(--ac-canvas-default-stroke)' },
  component:         { width: 200, height: 48,  fill: 'var(--ac-canvas-default-fill)' },
  component_set:     { width: 400, height: 200, fill: 'transparent', stroke: 'var(--ac-canvas-default-stroke)' },
  instance:          { width: 200, height: 48,  fill: 'var(--ac-canvas-default-fill)' },
  boolean_operation: { width: 120, height: 120, fill: 'var(--ac-canvas-default-fill)' },
  slice:             { width: 200, height: 120, fill: 'transparent', stroke: 'var(--ac-canvas-component)' },
  star:              { width: 120, height: 120, fill: 'var(--ac-canvas-accent-fill)' },
  polygon:           { width: 120, height: 120, fill: 'var(--ac-canvas-accent-fill)' },
  // Library icon node (lucide) — default glyph + neutral stroke (the human
  // toolbar doesn't expose it; agent tools + pen_search_icons create icons).
  icon:              { width: 24, height: 24, fill: 'transparent', stroke: 'var(--ac-canvas-default-text)' },
};

export function Toolbar() {
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const shapes = useCanvasStore((s) => s.document.shapes);
  const toolMode = useCanvasStore((s) => s.toolMode);
  const setToolMode = useCanvasStore((s) => s.setToolMode);
  const agentBusy = useCanvasStore((s) => s.agentBusy);

  const createShape = (type: LayerType) => {
    const defaults = SHAPE_DEFAULTS[type];
    // Place at the center of the visible viewport. We don't know the exact
    // viewport here without reaching into the Canvas component — use a
    // reasonable default around the document origin.
    const offset = shapes.length * 20;
    const patch: CanvasPatch = {
      op: 'add',
      shape: {
        type,
        name: `${type[0].toUpperCase()}${type.slice(1)} ${shapes.length + 1}`,
        x: 200 + offset,
        y: 160 + offset,
        width: defaults.width ?? 100,
        height: defaults.height ?? 100,
        fill: defaults.fill ?? 'var(--ac-canvas-default-fill)',
        text: defaults.text,
        fontSize: defaults.fontSize ?? 16,
        stroke: type === 'group' ? 'var(--ac-canvas-default-stroke)' : 'var(--ac-canvas-default-text)',
        strokeWidth: type === 'group' ? 1 : 0,
      },
      summary: `Created ${type}`,
    };
    sendPatch(patch);
  };

  // Shared button class for shape-creation tools.
  const btnCls =
    'h-8 w-8 ac-text-2 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring rounded-full';

  // Select/Pan/Scale toggle button class — active state gets a filled background.
  // Dark-mode audit fix: surface-3 (not 2) so the active pill stays clearly
  // visible on the translucent dark toolbar (L .28 vs .17 chrome).
  const modeBtnCls = (active: boolean) =>
    `h-8 w-8 ac-transition ac-focus-ring rounded-full ${
      active
        ? 'ac-surface-3 ac-text-1 shadow-sm'
        : 'ac-text-2 hover:ac-text-1 hover:ac-surface-2'
    }`;

  return (
    // Floating pill — absolutely positioned at bottom-center of the canvas container.
    // `pointer-events-none` on the wrapper means clicks pass through to the canvas
    // when not on a button; we re-enable pointer events on the pill itself.
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
      <div
        className="pointer-events-auto flex items-center gap-0.5 px-1.5 py-1 rounded-full border ac-border-default shadow-lg ac-transition"
        style={{
          backgroundColor: 'color-mix(in oklch, var(--ac-surface-0) 92%, transparent)',
          backdropFilter: 'blur(8px) saturate(140%)',
          WebkitBackdropFilter: 'blur(8px) saturate(140%)',
        }}
        role="toolbar"
        aria-label="Canvas toolbar"
      >
        <Button
          variant="ghost"
          size="icon"
          className={modeBtnCls(toolMode === 'select')}
          title="Select tool (V) — click to select shapes"
          aria-label="Select tool"
          aria-pressed={toolMode === 'select'}
          onClick={() => setToolMode('select')}
        >
          <MousePointer2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={modeBtnCls(toolMode === 'pan')}
          title="Pan tool (H) — drag to move the canvas"
          aria-label="Pan tool"
          aria-pressed={toolMode === 'pan'}
          onClick={() => setToolMode('pan')}
        >
          <Hand className="h-4 w-4" />
        </Button>
        {/* Phase 7: Scale tool (K) — resize handles scale the layer
            proportionally (width/height/fontSize/strokeWidth, Figma
            rescale() semantics; see lib/canvas/scale.ts). */}
        <Button
          variant="ghost"
          size="icon"
          className={modeBtnCls(toolMode === 'scale')}
          title="Scale tool (K) — drag a corner handle to scale proportionally"
          aria-label="Scale tool"
          aria-pressed={toolMode === 'scale'}
          onClick={() => setToolMode('scale')}
        >
          <Scaling className="h-4 w-4" />
        </Button>

        {/* Separator between H.1 tool groups. */}
        <div className="w-px h-5 ac-border-subtle bg-current mx-0.5 opacity-30" />

        {/* H.1 group 2: Frame (F) / Section (⇧S). */}
        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Frame (F)"
          aria-label="Add frame"
          disabled={agentBusy}
          onClick={() => createShape('frame')}
        >
          <Frame className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Section (⇧S)"
          aria-label="Add section"
          disabled={agentBusy}
          onClick={() => createShape('section')}
        >
          <SectionIcon className="h-4 w-4" />
        </Button>

        {/* Separator between H.1 tool groups. */}
        <div className="w-px h-5 ac-border-subtle bg-current mx-0.5 opacity-30" />

        {/* H.1 group 3: shapes (R / O / L). */}
        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Rectangle (R)"
          aria-label="Add rectangle"
          disabled={agentBusy}
          onClick={() => createShape('rectangle')}
        >
          <Square className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Ellipse (O)"
          aria-label="Add ellipse"
          disabled={agentBusy}
          onClick={() => createShape('ellipse')}
        >
          <Circle className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Line (L)"
          aria-label="Add line"
          disabled={agentBusy}
          onClick={() => createShape('line')}
        >
          <Minus className="h-4 w-4" />
        </Button>

        {/* Separator between H.1 tool groups. */}
        <div className="w-px h-5 ac-border-subtle bg-current mx-0.5 opacity-30" />

        {/* H.1 group 4: Text (T) — last group; nothing after it. */}
        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Text (T)"
          aria-label="Add text"
          disabled={agentBusy}
          onClick={() => createShape('text')}
        >
          <Type className="h-4 w-4" />
        </Button>

        {/* UI-audit 2026-08-29: Undo/Redo/Trash were removed from the
            floating pill (12 → 8 buttons). Figma/Excalidraw ship no undo,
            redo, or destructive-clear buttons in persistent chrome — they
            live on ⌘Z / ⌘⇧Z / Delete / File menu instead. */}
      </div>
    </div>
  );
}
