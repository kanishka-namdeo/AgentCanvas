'use client';

// Properties panel — edit the currently selected shape's style and geometry.
// All edits emit CanvasPatches through the store so the agent (and other
// viewers) see them.

import { useCanvasStore } from '@/lib/canvas/store';
import type { CanvasPatch } from '@/lib/canvas/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';

export function PropertiesPanel() {
  const document = useCanvasStore((s) => s.document);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const sendPatch = useCanvasStore((s) => s.sendPatch);

  const selected = selectedIds
    .map((id) => document.shapes.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s);

  const update = (patch: Partial<typeof selected[number]>) => {
    if (selected.length === 0) return;
    for (const shape of selected) {
      sendPatch({ op: 'update', shapeId: shape.id, shape: patch, summary: `Updated ${Object.keys(patch).join(', ')}` });
    }
  };

  const setCanvasBackground = (color: string) => {
    const patch: CanvasPatch = { op: 'background', background: color, summary: `Set background to ${color}` };
    sendPatch(patch);
  };

  if (selected.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-slate-200 text-xs font-medium text-slate-700">
          Properties
        </div>
        <div className="p-3 space-y-3">
          <div>
            <Label className="text-[11px] text-slate-500">Canvas Background</Label>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="color"
                value={document.background}
                onChange={(e) => setCanvasBackground(e.target.value)}
                className="h-7 w-7 rounded border border-slate-200 cursor-pointer"
              />
              <Input
                value={document.background}
                onChange={(e) => setCanvasBackground(e.target.value)}
                className="h-7 text-xs"
              />
            </div>
          </div>
          <div className="px-2 py-3 text-center text-xs text-slate-400 border border-dashed border-slate-200 rounded">
            Select a shape to edit its properties.
          </div>
        </div>
      </div>
    );
  }

  const shape = selected[0];
  const isMulti = selected.length > 1;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-slate-200 text-xs font-medium text-slate-700">
        Properties{isMulti ? ` (${selected.length} selected)` : ''}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Name */}
        {!isMulti && (
          <div>
            <Label className="text-[11px] text-slate-500">Name</Label>
            <Input
              value={shape.name}
              onChange={(e) => update({ name: e.target.value })}
              className="h-7 mt-1 text-xs"
            />
          </div>
        )}

        <Separator />

        {/* Position */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[11px] text-slate-500">X</Label>
            <Input
              type="number"
              value={Math.round(shape.x)}
              onChange={(e) => update({ x: parseFloat(e.target.value) || 0 })}
              className="h-7 mt-1 text-xs"
            />
          </div>
          <div>
            <Label className="text-[11px] text-slate-500">Y</Label>
            <Input
              type="number"
              value={Math.round(shape.y)}
              onChange={(e) => update({ y: parseFloat(e.target.value) || 0 })}
              className="h-7 mt-1 text-xs"
            />
          </div>
        </div>

        {/* Size */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[11px] text-slate-500">Width</Label>
            <Input
              type="number"
              value={Math.round(shape.width)}
              onChange={(e) => update({ width: Math.max(1, parseFloat(e.target.value) || 1) })}
              className="h-7 mt-1 text-xs"
            />
          </div>
          <div>
            <Label className="text-[11px] text-slate-500">Height</Label>
            <Input
              type="number"
              value={Math.round(shape.height)}
              onChange={(e) => update({ height: Math.max(1, parseFloat(e.target.value) || 1) })}
              className="h-7 mt-1 text-xs"
            />
          </div>
        </div>

        <Separator />

        {/* Fill */}
        <div>
          <Label className="text-[11px] text-slate-500">Fill</Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="color"
              value={shape.fill}
              onChange={(e) => update({ fill: e.target.value })}
              className="h-7 w-7 rounded border border-slate-200 cursor-pointer"
            />
            <Input
              value={shape.fill}
              onChange={(e) => update({ fill: e.target.value })}
              className="h-7 text-xs"
            />
          </div>
        </div>

        {/* Stroke */}
        <div>
          <Label className="text-[11px] text-slate-500">Stroke</Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="color"
              value={shape.stroke}
              onChange={(e) => update({ stroke: e.target.value })}
              className="h-7 w-7 rounded border border-slate-200 cursor-pointer"
            />
            <Input
              type="number"
              value={shape.strokeWidth}
              onChange={(e) => update({ strokeWidth: Math.max(0, parseFloat(e.target.value) || 0) })}
              className="h-7 text-xs w-16"
              min={0}
            />
          </div>
        </div>

        {/* Radius (for rectangle/frame) */}
        {(shape.type === 'rectangle' || shape.type === 'frame') && (
          <div>
            <Label className="text-[11px] text-slate-500">Corner Radius: {Math.round(shape.radius)}px</Label>
            <Slider
              value={[shape.radius]}
              onValueChange={(v) => update({ radius: v[0] })}
              min={0}
              max={Math.min(shape.width, shape.height) / 2}
              step={1}
              className="mt-1"
            />
          </div>
        )}

        {/* Opacity */}
        <div>
          <Label className="text-[11px] text-slate-500">Opacity: {Math.round(shape.opacity * 100)}%</Label>
          <Slider
            value={[shape.opacity * 100]}
            onValueChange={(v) => update({ opacity: v[0] / 100 })}
            min={0}
            max={100}
            step={1}
            className="mt-1"
          />
        </div>

        {/* Text-specific */}
        {shape.type === 'text' && (
          <>
            <Separator />
            <div>
              <Label className="text-[11px] text-slate-500">Text Content</Label>
              <textarea
                value={shape.text ?? ''}
                onChange={(e) => update({ text: e.target.value })}
                className="w-full mt-1 text-xs border border-slate-200 rounded p-2 resize-none h-16"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-slate-500">Font Size</Label>
                <Input
                  type="number"
                  value={shape.fontSize}
                  onChange={(e) => update({ fontSize: Math.max(1, parseFloat(e.target.value) || 1) })}
                  className="h-7 mt-1 text-xs"
                />
              </div>
              <div>
                <Label className="text-[11px] text-slate-500">Text Color</Label>
                <input
                  type="color"
                  value={shape.textColor}
                  onChange={(e) => update({ textColor: e.target.value })}
                  className="h-7 w-full mt-1 rounded border border-slate-200 cursor-pointer"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
