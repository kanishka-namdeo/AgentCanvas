'use client';

// Left toolbar — quick actions to manually create shapes (for the human
// user; the agent has its own tools). Also exposes a "clear" action and
// the document name editor.

import { useCanvasStore } from '@/lib/canvas/store';
import type { CanvasPatch, ShapeType } from '@/lib/canvas/types';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Square,
  Circle,
  Type,
  Minus,
  Frame,
  Trash2,
  MousePointer2,
  Hand,
} from 'lucide-react';

const SHAPE_DEFAULTS: Record<ShapeType, Partial<{ width: number; height: number; fill: string; text: string; fontSize: number }>> = {
  rectangle: { width: 160, height: 100, fill: '#e2e8f0' },
  ellipse:   { width: 120, height: 120, fill: '#fde68a' },
  text:      { width: 200, height: 32,  fill: '#0f172a', text: 'Text', fontSize: 20 },
  line:      { width: 120, height: 0,   fill: '#0f172a' },
  frame:     { width: 320, height: 240, fill: '#ffffff' },
  group:     { width: 240, height: 160, fill: 'transparent', stroke: '#94a3b8' },
};

export function Toolbar() {
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const shapes = useCanvasStore((s) => s.document.shapes);

  const createShape = (type: ShapeType) => {
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

  return (
    <div className="flex flex-col items-center gap-1 p-2 border-r border-slate-200 bg-white">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-slate-600"
        title="Select (V)"
      >
        <MousePointer2 className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-slate-600"
        title="Pan (Hold Space)"
      >
        <Hand className="h-4 w-4" />
      </Button>
      <Separator className="my-1 w-6" />
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-slate-600 hover:bg-slate-100"
        title="Rectangle"
        onClick={() => createShape('rectangle')}
      >
        <Square className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-slate-600 hover:bg-slate-100"
        title="Ellipse"
        onClick={() => createShape('ellipse')}
      >
        <Circle className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-slate-600 hover:bg-slate-100"
        title="Text"
        onClick={() => createShape('text')}
      >
        <Type className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-slate-600 hover:bg-slate-100"
        title="Line"
        onClick={() => createShape('line')}
      >
        <Minus className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-slate-600 hover:bg-slate-100"
        title="Frame"
        onClick={() => createShape('frame')}
      >
        <Frame className="h-4 w-4" />
      </Button>
      <Separator className="my-1 w-6" />
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-rose-500 hover:bg-rose-50"
        title="Clear canvas"
        onClick={() => {
          if (confirm('Clear all shapes from the canvas?')) {
            sendPatch({ op: 'clear', summary: 'Cleared canvas' });
          }
        }}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
