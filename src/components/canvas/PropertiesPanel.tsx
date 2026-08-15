'use client';

// Properties panel — edit the currently selected shape's style and geometry.
// All edits emit CanvasPatches through the store so the agent (and other
// viewers) see them.
//
// Extended with:
//   - Quick action buttons (group, duplicate, align, distribute) — appear
//     when multiple shapes are selected.
//   - Auto Layout section for frames/groups (direction, gap, padding).
//   - Design tokens display (when nothing is selected) — shows the current
//     palette and lets the user copy token keys.
//   - Component badge (M / I) indicator next to the shape name.

import { useCanvasStore } from '@/lib/canvas/store';
import type { CanvasPatch, AutoLayout } from '@/lib/canvas/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Copy, Group, Ungroup, AlignLeft, AlignCenterHorizontal, AlignRight,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  AlignHorizontalDistributeStart, AlignVerticalDistributeCenter, Palette,
} from 'lucide-react';

export function PropertiesPanel() {
  const document = useCanvasStore((s) => s.document);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const select = useCanvasStore((s) => s.select);

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

  // ---- Multi-selection quick actions ----------------------------------------
  const duplicateSelection = () => {
    if (selected.length === 0) return;
    sendPatch({ op: 'duplicate', shapeIds: selectedIds, summary: `Duplicated ${selected.length} shape(s)` });
  };
  const groupSelection = () => {
    if (selected.length < 2) return;
    sendPatch({ op: 'group', shapeIds: selectedIds, summary: `Grouped ${selected.length} shape(s)` });
  };
  const ungroupSelection = () => {
    const groups = selected.filter((s) => s.type === 'group');
    if (groups.length === 0) return;
    sendPatch({ op: 'ungroup', shapeIds: groups.map((g) => g.id), summary: `Ungrouped ${groups.length} group(s)` });
  };
  const alignSelection = (kind: CanvasPatch['alignKind']) => {
    if (selected.length < 2 || !kind) return;
    sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: kind, summary: `Aligned ${selected.length} shape(s) ${kind}` });
  };

  // ---- Auto-layout helpers (for selected frame/group) ----------------------
  const setAutoLayout = (changes: Partial<AutoLayout>) => {
    if (selected.length !== 1) return;
    const shape = selected[0];
    if (shape.type !== 'frame' && shape.type !== 'group') return;
    const current = shape.autoLayout ?? { direction: 'vertical', gap: 8, padding: 16, alignX: 'center', alignY: 'center' };
    const next = { ...current, ...changes };
    // Update the frame's autoLayout; the agent's tool also repositions
    // children, but here we just set the property. The user can ask the
    // agent to re-apply via canvas_apply_auto_layout if they want children
    // repositioned.
    sendPatch({ op: 'update', shapeId: shape.id, shape: { autoLayout: next }, summary: `Auto Layout: ${JSON.stringify(changes)}` });
  };

  if (selected.length === 0) {
    return (
      <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
        <div className="px-3 py-2 border-b ac-border-subtle text-[11px] font-semibold uppercase tracking-wide ac-text-2">
          Properties
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3 ac-hide-scrollbar">
          <div>
            <Label className="text-[11px] ac-text-3">Canvas Background</Label>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="color"
                value={document.background}
                onChange={(e) => setCanvasBackground(e.target.value)}
                className="h-7 w-7 rounded border ac-border-default cursor-pointer"
              />
              <Input
                value={document.background}
                onChange={(e) => setCanvasBackground(e.target.value)}
                className="h-7 text-xs ac-text-2 ac-border-default"
              />
            </div>
          </div>

          <Separator />

          {/* Design tokens panel */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Palette className="h-3 w-3 ac-text-4" />
              <Label className="text-[11px] ac-text-3">Design Tokens</Label>
              <span className="text-[10px] ac-text-4 ml-auto">{(document.tokens?.colors ?? []).length} color(s)</span>
            </div>
            {(document.tokens?.colors ?? []).length === 0 ? (
              <div className="text-[10px] ac-text-4 px-2 py-3 border border-dashed ac-border-subtle rounded text-center">
                No tokens yet. Ask the agent: <em>&quot;Generate a triadic palette from #0ea5e9&quot;</em>
              </div>
            ) : (
              <div className="space-y-1">
                {(document.tokens?.colors ?? []).map((c) => (
                  <div key={c.key} className="flex items-center gap-2 text-[10px]">
                    <div
                      className="w-4 h-4 rounded border ac-border-default flex-shrink-0"
                      style={{ background: c.value }}
                    />
                    <span className="ac-text-2 font-mono">{c.key}</span>
                    <span className="ac-text-4 ml-auto font-mono">{c.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Separator />

          <div className="px-2 py-4 text-center text-xs ac-text-4 border border-dashed ac-border-subtle rounded">
            Select a shape to edit its properties.
          </div>
        </div>
      </div>
    );
  }

  const shape = selected[0];
  const isMulti = selected.length > 1;
  const isComponentMaster = shape.componentId === shape.id;
  const isComponentInstance = !!shape.componentId && shape.componentId !== shape.id;
  const hasAutoLayout = !!shape.autoLayout && (shape.type === 'frame' || shape.type === 'group');

  return (
    <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
      <div className="px-3 py-2 border-b ac-border-subtle text-[11px] font-semibold uppercase tracking-wide ac-text-2 flex items-center gap-1.5">
        Properties{isMulti ? ` (${selected.length} selected)` : ''}
        {!isMulti && isComponentMaster && <Badge variant="outline" className="text-[9px] h-3.5 px-1 py-0 font-normal text-sky-700 border-sky-200">Master</Badge>}
        {!isMulti && isComponentInstance && <Badge variant="outline" className="text-[9px] h-3.5 px-1 py-0 font-normal text-violet-700 border-violet-200">Instance</Badge>}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 ac-hide-scrollbar">
        {/* Multi-selection quick actions */}
        {isMulti && (
          <>
            <div>
              <Label className="text-[11px] text-slate-500">Quick Actions</Label>
              <div className="grid grid-cols-2 gap-1 mt-1">
                <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={duplicateSelection}>
                  <Copy className="h-3 w-3 mr-1" /> Duplicate
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={groupSelection}>
                  <Group className="h-3 w-3 mr-1" /> Group
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-1 mt-1">
                <Button variant="outline" size="sm" className="h-7 px-0" title="Align left" onClick={() => alignSelection('left')}>
                  <AlignLeft className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-0" title="Align center H" onClick={() => alignSelection('center_h')}>
                  <AlignCenterHorizontal className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-0" title="Align right" onClick={() => alignSelection('right')}>
                  <AlignRight className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-0" title="Align top" onClick={() => alignSelection('top')}>
                  <AlignVerticalJustifyStart className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-0" title="Align center V" onClick={() => alignSelection('center_v')}>
                  <AlignVerticalJustifyCenter className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-0" title="Align bottom" onClick={() => alignSelection('bottom')}>
                  <AlignVerticalJustifyEnd className="h-3 w-3" />
                </Button>
              </div>
              {selected.length >= 3 && (
                <div className="grid grid-cols-2 gap-1 mt-1">
                  <Button variant="outline" size="sm" className="h-7 text-[11px]" title="Distribute horizontally" onClick={() => alignSelection('distribute_h')}>
                    <AlignHorizontalDistributeStart className="h-3 w-3 mr-1" /> H
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-[11px]" title="Distribute vertically" onClick={() => alignSelection('distribute_v')}>
                    <AlignVerticalDistributeCenter className="h-3 w-3 mr-1" /> V
                  </Button>
                </div>
              )}
            </div>
            <Separator />
          </>
        )}

        {/* Single-selection actions: duplicate, ungroup (if group) */}
        {!isMulti && (
          <div className="grid grid-cols-2 gap-1">
            <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={duplicateSelection}>
              <Copy className="h-3 w-3 mr-1" /> Duplicate
            </Button>
            {shape.type === 'group' && (
              <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={ungroupSelection}>
                <Ungroup className="h-3 w-3 mr-1" /> Ungroup
              </Button>
            )}
          </div>
        )}

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

        {/* Auto Layout (for frame/group only) */}
        {!isMulti && (shape.type === 'frame' || shape.type === 'group') && (
          <>
            <Separator />
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <Label className="text-[11px] text-slate-500">Auto Layout</Label>
                {hasAutoLayout && <Badge variant="outline" className="text-[9px] h-3.5 px-1 py-0 font-normal text-emerald-700 border-emerald-200">on</Badge>}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-1">
                <Button
                  variant={shape.autoLayout?.direction === 'horizontal' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => setAutoLayout({ direction: 'horizontal' })}
                >
                  Horizontal
                </Button>
                <Button
                  variant={shape.autoLayout?.direction === 'vertical' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => setAutoLayout({ direction: 'vertical' })}
                >
                  Vertical
                </Button>
              </div>
              {hasAutoLayout && (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <Label className="text-[10px] text-slate-500">Gap: {shape.autoLayout!.gap}px</Label>
                    <Slider
                      value={[shape.autoLayout!.gap]}
                      onValueChange={(v) => setAutoLayout({ gap: v[0] })}
                      min={0}
                      max={48}
                      step={1}
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-slate-500">Padding: {shape.autoLayout!.padding}px</Label>
                    <Slider
                      value={[shape.autoLayout!.padding]}
                      onValueChange={(v) => setAutoLayout({ padding: v[0] })}
                      min={0}
                      max={48}
                      step={1}
                    />
                  </div>
                </div>
              )}
              <p className="text-[10px] text-slate-400 mt-2">
                Note: changing Auto Layout here sets the property. Ask the agent
                to <em>&quot;apply auto layout to this frame&quot;</em> to also reposition children.
              </p>
            </div>
          </>
        )}

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
