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
  Trash2,
  MousePointer2,
  Hand,
  Undo2,
  Redo2,
} from 'lucide-react';

const SHAPE_DEFAULTS: Record<LayerType, Partial<{ width: number; height: number; fill: string; text: string; fontSize: number; stroke: string }>> = {
  rectangle: { width: 160, height: 100, fill: '#e2e8f0' },
  ellipse:   { width: 120, height: 120, fill: '#fde68a' },
  text:      { width: 200, height: 32,  fill: '#0f172a', text: 'Text', fontSize: 20 },
  line:      { width: 120, height: 0,   fill: '#0f172a' },
  frame:     { width: 320, height: 240, fill: '#ffffff' },
  group:     { width: 240, height: 160, fill: 'transparent', stroke: '#94a3b8' },
  path:      { width: 120, height: 120, fill: '#e2e8f0' },
  image:     { width: 160, height: 100, fill: '#e2e8f0' },
  // Figma ontology types (not in the default toolbar, but supported by the
  // agent tools and by the `add` patch op).
  section:           { width: 480, height: 320, fill: 'transparent', stroke: '#94a3b8' },
  component:         { width: 200, height: 48,  fill: '#e2e8f0' },
  component_set:     { width: 400, height: 200, fill: 'transparent', stroke: '#94a3b8' },
  instance:          { width: 200, height: 48,  fill: '#e2e8f0' },
  boolean_operation: { width: 120, height: 120, fill: '#e2e8f0' },
  slice:             { width: 200, height: 120, fill: 'transparent', stroke: '#0ea5e9' },
  star:              { width: 120, height: 120, fill: '#fde68a' },
  polygon:           { width: 120, height: 120, fill: '#fde68a' },
};

export function Toolbar() {
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const shapes = useCanvasStore((s) => s.document.shapes);
  const toolMode = useCanvasStore((s) => s.toolMode);
  const setToolMode = useCanvasStore((s) => s.setToolMode);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const undoStack = useCanvasStore((s) => s.undoStack);
  const redoStack = useCanvasStore((s) => s.redoStack);
  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

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
        fill: defaults.fill ?? '#e2e8f0',
        text: defaults.text,
        fontSize: defaults.fontSize ?? 16,
        stroke: type === 'group' ? '#94a3b8' : '#0f172a',
        strokeWidth: type === 'group' ? 1 : 0,
      },
      summary: `Created ${type}`,
    };
    sendPatch(patch);
  };

  // Shared button class for shape-creation tools.
  const btnCls =
    'h-8 w-8 ac-text-2 hover:ac-text-1 hover:ac-surface-2 ac-transition ac-focus-ring rounded-full';

  // Select/Pan toggle button class — active state gets a filled background.
  const modeBtnCls = (active: boolean) =>
    `h-8 w-8 ac-transition ac-focus-ring rounded-full ${
      active
        ? 'ac-surface-2 ac-text-1 shadow-sm'
        : 'ac-text-2 hover:ac-text-1 hover:ac-surface-2'
    }`;

  const canvasEmpty = shapes.length === 0;

  return (
    // Floating pill — absolutely positioned at bottom-center of the canvas container.
    // `pointer-events-none` on the wrapper means clicks pass through to the canvas
    // when not on a button; we re-enable pointer events on the pill itself.
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
      <div
        className="pointer-events-auto flex items-center gap-0.5 px-1.5 py-1 rounded-full border ac-border-default ac-surface-0 shadow-lg ac-transition"
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

        <div className="w-px h-5 ac-border-subtle bg-current mx-0.5 opacity-30" />

        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Rectangle"
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
          title="Ellipse"
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
          title="Text"
          aria-label="Add text"
          disabled={agentBusy}
          onClick={() => createShape('text')}
        >
          <Type className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Line"
          aria-label="Add line"
          disabled={agentBusy}
          onClick={() => createShape('line')}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Frame"
          aria-label="Add frame"
          disabled={agentBusy}
          onClick={() => createShape('frame')}
        >
          <Frame className="h-4 w-4" />
        </Button>

        <div className="w-px h-5 ac-border-subtle bg-current mx-0.5 opacity-30" />

        {/* Undo / Redo — discoverable buttons (keyboard: ⌘Z / ⌘⇧Z). */}
        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Undo (⌘Z)"
          aria-label="Undo"
          disabled={!canUndo || agentBusy}
          onClick={() => undo()}
        >
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`${btnCls} disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Redo (⌘⇧Z)"
          aria-label="Redo"
          disabled={!canRedo || agentBusy}
          onClick={() => redo()}
        >
          <Redo2 className="h-4 w-4" />
        </Button>

        <div className="w-px h-5 ac-border-subtle bg-current mx-0.5 opacity-30" />

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-rose-500 hover:bg-rose-50 hover:text-rose-600 ac-transition ac-focus-ring rounded-full disabled:opacity-30 disabled:cursor-not-allowed"
          title="Clear canvas"
          aria-label="Clear canvas"
          disabled={canvasEmpty || agentBusy}
          onClick={() => {
            if (confirm('Clear all shapes from the canvas?')) {
              sendPatch({ op: 'clear', summary: 'Cleared canvas' });
            }
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
