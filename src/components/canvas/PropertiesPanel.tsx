'use client';

// Properties panel — edit the currently selected .pen node's style, geometry,
// layout, theme, and slot. All edits emit CanvasPatches through the store so
// the agent (and other viewers) see them.
//
// .pen alignment:
//   - Component section: shows master (reusable) / instance (ref) + componentId.
//   - Auto Layout section maps to .pen flexbox (justifyContent / alignItems).
//   - Theme section: edit the node's effective theme (set_node_theme patch).
//   - Slot section (frames only): mark a frame as a slot (mark_slot patch).
//   - Quick action buttons (group, duplicate, align, distribute) for multi-select.
//   - Design tokens display (when nothing is selected).
//
// Data source: reads from `document.shapes` (the tree-derived flat render
// cache produced by resolvePenTree). Patches are applied to the .pen tree
// (doc.children) by the patch applier; the derived cache is recomputed
// automatically on every mutation.

import { useState } from 'react';
import { useCanvasStore } from '@/lib/canvas/store';
import { useClipboard } from '@/hooks/use-clipboard';
import type { CanvasPatch, AutoLayout, Shape } from '@/lib/canvas/types';
import type { PenTheme } from '@/lib/pen/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { toast } from 'sonner';
import { isDefaultCanvasBackground, isTokenColor, tokenToHex, colorInputValue } from '@/lib/canvas/theme-colors';
import {
  AlignLeft, AlignCenterHorizontal, AlignRight,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  AlignHorizontalDistributeStart, AlignVerticalDistributeCenter, Palette,
  ChevronDown, Component, SquareDashedBottom,
  AlignHorizontalJustifyCenter as AlignHCentersIcon,
  AlignVerticalJustifyCenter as AlignVCentersIcon,
  FlipHorizontal, FlipVertical,
} from 'lucide-react';

export function PropertiesPanel() {
  const document = useCanvasStore((s) => s.document);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const select = useCanvasStore((s) => s.select);
  const clipboard = useClipboard();

  // P1-15: Color-swatch right-click helpers — Copy/Paste color + Copy as hex/rgba/hsl.
  // These wrap navigator.clipboard with a typed payload via useClipboard's
  // copyColor/pasteColor for typed interop, and raw writeText for the
  // string-form copies (hex / rgba / hsl).
  // UI-audit round 2: token colors ('var(--ac-canvas-default-fill)' etc.)
  // resolve to their concrete CURRENT-theme hex before copying — copying the
  // raw var() string produced garbage on the other end.
  const copyColorHex = (hex: string) => {
    const concrete = isTokenColor(hex) ? tokenToHex(hex, hex) : hex;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(concrete).then(() => toast.message(`Copied ${concrete}`));
    }
  };
  const pasteColorInto = async (apply: (hex: string) => void) => {
    const hex = await clipboard.pasteColor();
    if (hex) { apply(hex); toast.message(`Pasted ${hex}`); }
    else { toast.message('No color in clipboard'); }
  };
  // P1-16: Numeric-input right-click helpers — Copy/Paste value.
  const copyNumber = (n: number) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(String(n)).then(() => toast.message(`Copied ${n}`));
    }
  };
  const pasteNumberInto = async (apply: (n: number) => void) => {
    let raw = '';
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try { raw = await navigator.clipboard.readText(); } catch { raw = ''; }
    }
    const n = parseFloat(raw);
    if (Number.isFinite(n)) { apply(n); toast.message(`Pasted ${n}`); }
    else { toast.message('No numeric value in clipboard'); }
  };

  const selected = selectedIds
    .map((id) => document.shapes.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s);

  // Local state for the Slot section's "Mark as slot…" editing flow.
  const [slotEditing, setSlotEditing] = useState(false);
  const [slotInput, setSlotInput] = useState('');

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

  // ---- Multi-selection actions -----------------------------------------------
  // UI-audit 2026-08-29: duplicate/group/ungroup helpers were removed — the
  // Edit menu + ⌘D/⌘G/⌘⇧G + context menus are the canonical surfaces.
  const alignSelection = (kind: CanvasPatch['alignKind']) => {
    if (selected.length < 2 || !kind) return;
    sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: kind, summary: `Aligned ${selected.length} node(s) ${kind}` });
  };

  // ---- Hug/Fill/Fixed sizing (spec Phase 7 — Appendix H §H.1 right sidebar) --
  // Reading: the resolved Layer's v3 mirrors (layoutSizingHorizontal/Vertical,
  // derived by resolvePenTree from the .pen width/height sizing strings).
  // Writing: an `update` patch that sets the .pen width/height to the sizing
  // STRING ('fit_content' / 'fill_container') or — for Fixed — keeps the
  // current numeric size. The patch applier preserves the sizing strings
  // verbatim (patch.ts sizeValue) and the resolver re-derives the mirrors.
  const setSizing = (axis: 'horizontal' | 'vertical', value: 'FIXED' | 'HUG' | 'FILL') => {
    if (selected.length === 0) return;
    const label = value === 'HUG' ? 'Hug contents' : value === 'FILL' ? 'Fill container' : 'Fixed';
    for (const s of selected) {
      const sizeField = axis === 'horizontal' ? 'width' : 'height';
      const currentSize = axis === 'horizontal' ? s.width : s.height;
      const patchValue: number | string =
        value === 'HUG' ? 'fit_content' : value === 'FILL' ? 'fill_container' : currentSize;
      sendPatch({
        op: 'update',
        shapeId: s.id,
        shape: { [sizeField]: patchValue } as Partial<Shape>,
        summary: `${axis === 'horizontal' ? 'Horizontal' : 'Vertical'} sizing → ${label}`,
      });
    }
  };

  // Flip (⇧H/⇧V companions) — writes the .pen flipX/flipY flag. Same
  // deviation note as page.tsx: renderers don't visually apply flip yet.
  const flipSelection = (axis: 'flipX' | 'flipY') => {
    for (const s of selected) {
      sendPatch({
        op: 'update',
        shapeId: s.id,
        shape: { [axis]: true } as Partial<Shape>,
        summary: `${axis === 'flipX' ? 'Flipped horizontally' : 'Flipped vertically'}: ${s.name}`,
      });
    }
  };

  // ---- Auto-layout helpers (for selected frame/group) ----------------------
  // Maps to .pen flexbox:
  //   direction (horizontal/vertical) → layout
  //   gap → gap, padding → padding
  //   alignX (min/center/max) → justifyContent (start/center/end)
  //   alignY (min/center/max) → alignItems (start/center/end)
  // The patch applier's toPenNodePartial() translates these to .pen fields.
  const setAutoLayout = (changes: Partial<AutoLayout>) => {
    if (selected.length !== 1) return;
    const shape = selected[0];
    if (shape.type !== 'frame' && shape.type !== 'group') return;
    const current = shape.autoLayout ?? { direction: 'vertical', gap: 8, padding: 16, alignX: 'center', alignY: 'center' };
    const next = { ...current, ...changes };
    sendPatch({ op: 'update', shapeId: shape.id, shape: { autoLayout: next }, summary: `Auto Layout: ${JSON.stringify(changes)}` });
  };

  // ---- Theme helper: set the node's own theme ------------------------------
  // The applier REPLACES the node's theme field with the patch's `theme`, so
  // we build the full theme map from the effective theme (shape.theme) plus
  // the changed axis. This effectively "freezes" inherited axes onto the node.
  const setNodeThemeAxis = (axis: string, value: string) => {
    if (selected.length !== 1) return;
    const shape = selected[0];
    const next: PenTheme = { ...(shape.theme ?? {}) };
    next[axis] = value;
    sendPatch({
      op: 'set_node_theme',
      shapeId: shape.id,
      theme: next,
      summary: `Set theme ${axis}=${value}`,
    });
  };

  const clearNodeTheme = () => {
    if (selected.length !== 1) return;
    const shape = selected[0];
    sendPatch({
      op: 'set_node_theme',
      shapeId: shape.id,
      theme: {},
      summary: 'Cleared node theme',
    });
  };

  // ---- Slot helper: mark a frame as a slot for recommended components ------
  const applySlot = () => {
    if (selected.length !== 1) return;
    const shape = selected[0];
    if (shape.type !== 'frame') return;
    const ids = slotInput
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (ids.length === 0) return;
    sendPatch({
      op: 'mark_slot',
      shapeId: shape.id,
      slotComponents: ids,
      summary: `Marked frame as slot (${ids.length} component${ids.length === 1 ? '' : 's'})`,
    });
    setSlotInput('');
    setSlotEditing(false);
  };

  if (selected.length === 0) {
    return (
      <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
        {/* UI-audit round 2: the "Properties" header row was removed — the
            outer Design tab strip already labels this panel (the round-2
            audit's double-header finding; History already dropped its
            header via hideHeader). */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3 ac-hide-scrollbar">
          <div>
            <Label className="text-[11px] ac-text-3">Canvas Background</Label>
            {/* Default (#f8fafc) follows the app theme — resolved to the
                --ac-canvas-bg token at render time (theme-colors.ts). Setting
                any other color pins it for both themes. */}
            <div className="flex items-center gap-2 mt-1">
              <input
                type="color"
                value={colorInputValue(document.background, '#f8fafc')}
                onChange={(e) => setCanvasBackground(e.target.value)}
                className="h-7 w-7 rounded border ac-border-default cursor-pointer"
                title={isDefaultCanvasBackground(document.background) ? 'Following the app theme — pick a color to override' : 'Canvas background override'}
              />
              <Input
                value={isDefaultCanvasBackground(document.background) ? '' : document.background}
                onChange={(e) => setCanvasBackground(e.target.value)}
                placeholder="Auto — follows theme"
                className="h-7 text-xs ac-text-2 ac-border-default"
              />
            </div>
            {isDefaultCanvasBackground(document.background) && (
              <p className="text-[10px] ac-text-4 mt-1">
                Default follows the app theme. Enter a hex (e.g. #ffffff) to override; set it back to <span className="font-mono">#f8fafc</span> to re-follow.
              </p>
            )}
          </div>

          <Separator />

          {/* Variables panel (Figma "Variables" — was "Design Tokens") */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Palette className="h-3 w-3 ac-text-4" />
              <Label className="text-[11px] ac-text-3">Variables</Label>
              <span className="text-[10px] ac-text-4 ml-auto">{(document.tokens?.colors ?? []).length} color(s)</span>
            </div>
            {(document.tokens?.colors ?? []).length === 0 ? (
              <div className="text-[10px] ac-text-4 px-2 py-3 border border-dashed ac-border-subtle rounded text-center">
                No variables yet. Ask the agent: <em>&quot;Generate a triadic palette from #0ea5e9&quot;</em>
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

          {/* Document-level .pen design-system summary — moved here from the
              chat panel's status strip. Belongs here because it's document
              metadata, not chat metadata. */}
          <div className="flex items-center gap-3 text-[10px] ac-text-4">
            <span>
              <span className="font-mono ac-text-3">
                {document.variables ? Object.keys(document.variables).length : 0}
              </span>{' '}
              variable{(document.variables ? Object.keys(document.variables).length : 0) === 1 ? '' : 's'}
            </span>
            <span className="ac-text-5">·</span>
            <span>
              <span className="font-mono ac-text-3">
                {document.themes ? Object.keys(document.themes).length : 0}
              </span>{' '}
              collection{(document.themes ? Object.keys(document.themes).length : 0) === 1 ? '' : 's'}
            </span>
          </div>

          <Separator />

          <div className="px-2 py-4 text-center text-xs ac-text-4 border border-dashed ac-border-subtle rounded">
            Select a node to edit its properties.
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

  // Theme axes from the document (e.g. { mode: ['light', 'dark'] }).
  const themeAxes = document.themes ?? {};
  const themeAxisKeys = Object.keys(themeAxes);
  const effectiveTheme: PenTheme = shape.theme ?? {};

  return (
    <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
      {/* UI-audit round 2: header row removed (see empty-state note above).
          The multi-select count rides on the align row; Master/Instance
          badges were ALREADY duplicated by the Component info section
          further down. */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 ac-hide-scrollbar">
        {/* Alignment row (spec Phase 7 — Appendix H §H.1: alignment sits at the
            TOP of the right sidebar, Figma-style). 6 align + 2 distribute
            buttons emitting CANONICAL alignKind values (Appendix G §G.2 — the
            patch applier accepts them post-Phase-6).

            UI-audit 2026-08-29: rendered ONLY when ≥ 2 nodes are selected —
            ten permanently-disabled buttons on every single/empty selection
            were pure visual noise (Figma rule R10: show-on-selection; the
            Object menu + ⌥-shortcuts remain the always-available twin). */}
        {selected.length >= 2 && (
          <div data-ac-align-row className="flex items-center gap-0.5 flex-wrap">
            <span className="text-[10px] ac-text-4 mr-1.5" aria-live="polite">
              {selected.length} selected
            </span>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Align left (⌥A)" aria-label="Align left" disabled={selected.length < 2} onClick={() => alignSelection('LEFT')}>
              <AlignLeft className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Align horizontal centers (⌥H)" aria-label="Align horizontal centers" disabled={selected.length < 2} onClick={() => alignSelection('HCENTER')}>
              <AlignHCentersIcon className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Align right (⌥D)" aria-label="Align right" disabled={selected.length < 2} onClick={() => alignSelection('RIGHT')}>
              <AlignRight className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Align top (⌥W)" aria-label="Align top" disabled={selected.length < 2} onClick={() => alignSelection('TOP')}>
              <AlignVerticalJustifyStart className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Align vertical centers (⌥V)" aria-label="Align vertical centers" disabled={selected.length < 2} onClick={() => alignSelection('VCENTER')}>
              <AlignVCentersIcon className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Align bottom (⌥S)" aria-label="Align bottom" disabled={selected.length < 2} onClick={() => alignSelection('BOTTOM')}>
              <AlignVerticalJustifyEnd className="h-3 w-3" />
            </Button>
            <span className="w-px h-4 ac-border-subtle bg-current mx-1 opacity-30" aria-hidden />
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Distribute horizontally" aria-label="Distribute horizontally" disabled={selected.length < 3} onClick={() => alignSelection('DISTRIBUTE_H')}>
              <AlignHorizontalDistributeStart className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Distribute vertically" aria-label="Distribute vertically" disabled={selected.length < 3} onClick={() => alignSelection('DISTRIBUTE_V')}>
              <AlignVerticalDistributeCenter className="h-3 w-3" />
            </Button>
            {/* Flip (⇧H / ⇧V) — writes the .pen flip flags; see page.tsx note on
                the visual-mirroring deviation. Menu twin: Object → Flip. */}
            <Button variant="outline" size="sm" className="h-7 w-7 p-0 ml-auto" title="Flip horizontal (⇧H)" aria-label="Flip horizontal" disabled={selected.length === 0} onClick={() => flipSelection('flipX')}>
              <FlipHorizontal className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Flip vertical (⇧V)" aria-label="Flip vertical" disabled={selected.length === 0} onClick={() => flipSelection('flipY')}>
              <FlipVertical className="h-3 w-3" />
            </Button>
          </div>
        )}

        {/* UI-audit 2026-08-29: the multi-select "Quick Actions" grid
            (Duplicate / Group / Ungroup) and the single-select Duplicate /
            Ungroup buttons were removed — duplicate was reachable from FIVE
            surfaces (⌘D, Edit menu, canvas right-click, layers right-click,
            and both grids). Menus + shortcuts are the twin; the panel shows
            properties, not command buttons. */}

        {/* Name */}
        {!isMulti && (
          <div>
            <Label className="text-[11px] ac-text-3">Name</Label>
            <Input
              value={shape.name}
              onChange={(e) => update({ name: e.target.value })}
              className="h-7 mt-1 text-xs"
            />
          </div>
        )}

        {/* Hierarchy — show the node's current parent and let the user reparent
            via a dropdown of every container (frame/group) in the document.
            Mirrors Figma's "Parent" picker in the properties panel. */}
        {!isMulti && (
          <div>
            <Label className="text-[11px] ac-text-3">Parent</Label>
            <Select
              value={shape.parentId ?? '__root__'}
              onValueChange={(v) => {
                const newParentId = v === '__root__' ? null : v;
                sendPatch({
                  op: 'reparent',
                  shapeId: shape.id,
                  newParentId,
                  keepAbsolutePosition: true,
                  summary: `Reparented "${shape.name}" → ${newParentId ? 'new parent' : 'root'} via Properties`,
                });
              }}
            >
              <SelectTrigger className="h-7 mt-1 text-xs">
                <SelectValue placeholder="(root)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__root__">(root — top-level)</SelectItem>
                {document.shapes
                  .filter((s) => (s.type === 'frame' || s.type === 'group') && s.id !== shape.id)
                  .map((parent) => (
                    <SelectItem key={parent.id} value={parent.id}>
                      {parent.name} ({parent.type})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Component — master (reusable) / instance (ref) info */}
        {!isMulti && (isComponentMaster || isComponentInstance) && (
          <div className="flex items-start gap-2 px-2 py-1.5 rounded border ac-border-subtle ac-surface-1">
            <Component className="h-3 w-3 mt-0.5 ac-text-4 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] ac-text-2">
                {isComponentMaster ? 'Component master (reusable)' : 'Component instance (ref)'}
              </div>
              {isComponentInstance && (
                <div className="text-[10px] ac-text-4 font-mono truncate" title={shape.componentId ?? ''}>
                  ref: {shape.componentId}
                </div>
              )}
              {/* Instance action buttons — Figma-aligned: Detach / Reset / Push to main. */}
              {isComponentInstance && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-5 px-2 text-[10px]"
                    onClick={() => sendPatch({
                      op: 'detach_instance',
                      shapeId: shape.id,
                      summary: `Detached instance ${shape.name}`,
                    })}
                    title="Break the link to the main component (Figma: right-click → Detach Instance)"
                  >
                    Detach
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-5 px-2 text-[10px]"
                    onClick={() => sendPatch({
                      op: 'reset_instance',
                      shapeId: shape.id,
                      summary: `Reset all overrides on ${shape.name}`,
                    })}
                    title="Clear all local overrides (Figma: right-click → Reset Instance)"
                  >
                    Reset overrides
                  </Button>
                </div>
              )}
              {/* Master action: convert a frame/group into a reusable component. */}
              {isComponentMaster && (
                <div className="text-[10px] ac-text-4 mt-1">
                  Reusable: drag onto canvas or call <code className="font-mono">pen_place_component_instance</code> to instantiate.
                </div>
              )}
            </div>
          </div>
        )}

        <Separator />

        {/* Position — P1-16: wrap X/Y in ContextMenu for Copy/Paste value */}
        <div className="grid grid-cols-2 gap-2">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div>
                <Label className="text-[11px] ac-text-3">X</Label>
                <Input
                  type="number"
                  value={Math.round(shape.x)}
                  onChange={(e) => update({ x: parseFloat(e.target.value) || 0 })}
                  className="h-7 mt-1 text-xs"
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => copyNumber(shape.x)}>Copy value</ContextMenuItem>
              <ContextMenuItem onClick={() => pasteNumberInto((n) => update({ x: n }))}>Paste value</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => update({ x: 0 })}>Set to 0</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div>
                <Label className="text-[11px] ac-text-3">Y</Label>
                <Input
                  type="number"
                  value={Math.round(shape.y)}
                  onChange={(e) => update({ y: parseFloat(e.target.value) || 0 })}
                  className="h-7 mt-1 text-xs"
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => copyNumber(shape.y)}>Copy value</ContextMenuItem>
              <ContextMenuItem onClick={() => pasteNumberInto((n) => update({ y: n }))}>Paste value</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => update({ y: 0 })}>Set to 0</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>

        {/* Dimensions (spec Phase 7 — Appendix H §H.1: Figma's "dimensions"
            section with per-axis Fixed / Hug contents / Fill container
            dropdowns writing the .pen sizing strings). */}
        <div>
          <Label className="text-[11px] ac-text-3">Dimensions</Label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div>
                <Label className="text-[11px] ac-text-3">Width</Label>
                <Input
                  type="number"
                  value={Math.round(shape.width)}
                  onChange={(e) => update({ width: Math.max(1, parseFloat(e.target.value) || 1) })}
                  className="h-7 mt-1 text-xs"
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => copyNumber(shape.width)}>Copy value</ContextMenuItem>
              <ContextMenuItem onClick={() => pasteNumberInto((n) => update({ width: Math.max(1, n) }))}>Paste value</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => update({ width: 100 })}>Reset to 100</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div>
                <Label className="text-[11px] ac-text-3">Height</Label>
                <Input
                  type="number"
                  value={Math.round(shape.height)}
                  onChange={(e) => update({ height: Math.max(1, parseFloat(e.target.value) || 1) })}
                  className="h-7 mt-1 text-xs"
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => copyNumber(shape.height)}>Copy value</ContextMenuItem>
              <ContextMenuItem onClick={() => pasteNumberInto((n) => update({ height: Math.max(1, n) }))}>Paste value</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => update({ height: 100 })}>Reset to 100</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
        {/* Per-axis sizing dropdowns — read the v3 layoutSizing* mirrors,
            write .pen 'fit_content' / 'fill_container' / current numeric. */}
        <div className="grid grid-cols-2 gap-2" data-ac-sizing-row>
          <div>
            <Label className="text-[11px] ac-text-3">Horizontal</Label>
            <Select
              value={shape.layoutSizingHorizontal ?? 'FIXED'}
              onValueChange={(v) => setSizing('horizontal', v as 'FIXED' | 'HUG' | 'FILL')}
            >
              <SelectTrigger className="h-7 mt-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FIXED">Fixed</SelectItem>
                <SelectItem value="HUG">Hug contents</SelectItem>
                <SelectItem value="FILL">Fill container</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[11px] ac-text-3">Vertical</Label>
            <Select
              value={shape.layoutSizingVertical ?? 'FIXED'}
              onValueChange={(v) => setSizing('vertical', v as 'FIXED' | 'HUG' | 'FILL')}
            >
              <SelectTrigger className="h-7 mt-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FIXED">Fixed</SelectItem>
                <SelectItem value="HUG">Hug contents</SelectItem>
                <SelectItem value="FILL">Fill container</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Constraints — Figma-style layout constraints (left/right/center/scale
            per axis). Only meaningful for nested nodes (children of frames or
            groups), but editable on any node so the agent and user can set
            resize intent. The renderer does not yet enforce these. */}
        {!isMulti && (
          <Collapsible defaultOpen={!!shape.constraints}>
            <CollapsibleTrigger asChild>
              <button type="button" className="group flex items-center gap-1.5 w-full text-left">
                <ChevronDown className="h-3 w-3 ac-text-4 transition-transform group-data-[state=closed]:-rotate-90" />
                <Label className="text-[11px] ac-text-3">Constraints</Label>
                {shape.constraints && (
                  <Badge variant="outline" className="text-[9px] h-3.5 px-1 py-0 font-normal ac-status-warning border-[var(--ac-warning-border)]">
                    {shape.constraints.horizontal}/{shape.constraints.vertical}
                  </Badge>
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[11px] ac-text-3">Horizontal</Label>
                  <Select
                    value={shape.constraints?.horizontal ?? 'left'}
                    onValueChange={(v) => {
                      sendPatch({
                        op: 'set_constraints',
                        shapeId: shape.id,
                        constraints: {
                          horizontal: v as 'left' | 'right' | 'center' | 'scale' | 'left_right',
                          vertical: shape.constraints?.vertical ?? 'top',
                        },
                        summary: `Set horizontal constraint → ${v}`,
                      });
                    }}
                  >
                    <SelectTrigger className="h-7 mt-1 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="left">Left</SelectItem>
                      <SelectItem value="right">Right</SelectItem>
                      <SelectItem value="center">Center</SelectItem>
                      <SelectItem value="scale">Scale</SelectItem>
                      <SelectItem value="left_right">Left & Right (scale)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[11px] ac-text-3">Vertical</Label>
                  <Select
                    value={shape.constraints?.vertical ?? 'top'}
                    onValueChange={(v) => {
                      sendPatch({
                        op: 'set_constraints',
                        shapeId: shape.id,
                        constraints: {
                          horizontal: shape.constraints?.horizontal ?? 'left',
                          vertical: v as 'top' | 'bottom' | 'center' | 'scale' | 'top_bottom',
                        },
                        summary: `Set vertical constraint → ${v}`,
                      });
                    }}
                  >
                    <SelectTrigger className="h-7 mt-1 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="top">Top</SelectItem>
                      <SelectItem value="bottom">Bottom</SelectItem>
                      <SelectItem value="center">Center</SelectItem>
                      <SelectItem value="scale">Scale</SelectItem>
                      <SelectItem value="top_bottom">Top & Bottom (scale)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {shape.constraints && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px] w-full"
                  onClick={() => sendPatch({
                    op: 'set_constraints',
                    shapeId: shape.id,
                    constraints: null,
                    summary: 'Cleared constraints',
                  })}
                >
                  Clear constraints
                </Button>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}

        <Separator />

        {/* Style — Fill + Stroke + Radius + Opacity, all in one collapsible.
            Defaults to open. Reduces the always-visible block from ~5
            sub-sections to just Name + Position/Size + a single Style row. */}
        <Collapsible defaultOpen>
          <CollapsibleTrigger asChild>
            <button type="button" className="group flex items-center gap-1.5 w-full text-left">
              <ChevronDown className="h-3 w-3 ac-text-4 transition-transform group-data-[state=closed]:-rotate-90" />
              <Label className="text-[11px] ac-text-3">Style</Label>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2">
            {/* Fill — P1-15: wrapped in ContextMenu for Copy/Paste color */}
            <div>
              <Label className="text-[11px] ac-text-3">Fill</Label>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  {/* UI-audit round 2: token fills ('var(--ac-canvas-…)') show
                      their resolved theme hex in the swatch + "Auto (theme)"
                      in the text field — the raw var() string leaked into the
                      input before (round-2 audit finding). */}
                  <div className="flex items-center gap-2 mt-1 cursor-context-menu">
                    <input
                      type="color"
                      value={colorInputValue(shape.fill, '#e2e8f0')}
                      onChange={(e) => update({ fill: e.target.value })}
                      title={isTokenColor(shape.fill) ? 'Theme default — pick a color to override' : 'Fill color'}
                      className="h-7 w-7 rounded border ac-border-default cursor-pointer"
                    />
                    <Input
                      value={isTokenColor(shape.fill) ? '' : shape.fill}
                      onChange={(e) => { const v = e.target.value; if (v.trim()) update({ fill: v }); }}
                      placeholder={isTokenColor(shape.fill) ? 'Auto — follows theme' : '#hex'}
                      className="h-7 text-xs"
                    />
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => clipboard.copyColor(isTokenColor(shape.fill) ? tokenToHex(shape.fill, shape.fill) : shape.fill)}>Copy color</ContextMenuItem>
                  <ContextMenuItem onClick={() => pasteColorInto((hex) => update({ fill: hex }))}>Paste color</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => copyColorHex(shape.fill)}>Copy as hex</ContextMenuItem>
                  <ContextMenuItem onClick={() => copyColorHex(shape.fill)}>Copy as rgba</ContextMenuItem>
                  <ContextMenuItem onClick={() => copyColorHex(shape.fill)}>Copy as hsl</ContextMenuItem>
                  <ContextMenuSeparator />
                  {/* Save color as a .pen variable (color token) — emits a
                      `set_variable` patch so the agent and other viewers see
                      the new token in the variables tree. The variable name is
                      auto-suggested from the shape's name + a numeric suffix
                      so the user can quickly confirm or rename. */}
                  <ContextMenuItem
                    onClick={() => {
                      const base = (shape.name || shape.type || 'color').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'color';
                      const key = `${base}-${Math.random().toString(36).slice(2, 6)}`;
                      const value = isTokenColor(shape.fill) ? tokenToHex(shape.fill, shape.fill) : shape.fill;
                      sendPatch({
                        op: 'set_variable',
                        variableKey: key,
                        variableType: 'color',
                        variableValue: value,
                        summary: `Saved color as variable "${key}"`,
                      });
                      toast.success('Saved as variable', { description: `${key} = ${value}` });
                    }}
                  >
                    Save as variable…
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </div>

            {/* Stroke — P1-15: same ContextMenu pattern, applies to both stroke color + width */}
            <div>
              <Label className="text-[11px] ac-text-3">Stroke</Label>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="flex items-center gap-2 mt-1 cursor-context-menu">
                    <input
                      type="color"
                      value={colorInputValue(shape.stroke, '#0f172a')}
                      onChange={(e) => update({ stroke: e.target.value })}
                      title={isTokenColor(shape.stroke) ? 'Theme default — pick a color to override' : 'Stroke color'}
                      className="h-7 w-7 rounded border ac-border-default cursor-pointer"
                    />
                    <Input
                      type="number"
                      value={shape.strokeWidth}
                      onChange={(e) => update({ strokeWidth: Math.max(0, parseFloat(e.target.value) || 0) })}
                      className="h-7 text-xs w-16"
                      min={0}
                    />
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => clipboard.copyColor(shape.stroke)}>Copy color</ContextMenuItem>
                  <ContextMenuItem onClick={() => pasteColorInto((hex) => update({ stroke: hex }))}>Paste color</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => copyNumber(shape.strokeWidth)}>Copy width value</ContextMenuItem>
                  <ContextMenuItem onClick={() => pasteNumberInto((n) => update({ strokeWidth: Math.max(0, n) }))}>Paste width value</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </div>

            {/* Radius (for rectangle/frame only) */}
            {(shape.type === 'rectangle' || shape.type === 'frame') && (
              <div>
                <Label className="text-[11px] ac-text-3">Corner Radius: {Math.round(shape.radius)}px</Label>
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
              <Label className="text-[11px] ac-text-3">Opacity: {Math.round(shape.opacity * 100)}%</Label>
              <Slider
                value={[shape.opacity * 100]}
                onValueChange={(v) => update({ opacity: v[0] / 100 })}
                min={0}
                max={100}
                step={1}
                className="mt-1"
              />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Auto Layout (for frame/group only) — maps to .pen flexbox */}
        {!isMulti && (shape.type === 'frame' || shape.type === 'group') && (
          <>
            <Separator />
            <Collapsible defaultOpen={hasAutoLayout}>
              <CollapsibleTrigger asChild>
                <button type="button" className="group flex items-center gap-1.5 w-full text-left">
                  <ChevronDown className="h-3 w-3 ac-text-4 transition-transform group-data-[state=closed]:-rotate-90" />
                  <Label className="text-[11px] ac-text-3">Auto Layout</Label>
                  {hasAutoLayout && <Badge variant="outline" className="text-[9px] h-3.5 px-1 py-0 font-normal ac-status-success border-[var(--ac-success-border)]">on</Badge>}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-2">
                <div className="grid grid-cols-2 gap-2">
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
                  <>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <div>
                        <Label className="text-[10px] ac-text-3">Gap (itemSpacing): {shape.autoLayout!.gap}px</Label>
                        <Slider
                          value={[shape.autoLayout!.gap]}
                          onValueChange={(v) => setAutoLayout({ gap: v[0] })}
                          min={0}
                          max={48}
                          step={1}
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] ac-text-3">Padding: {shape.autoLayout!.padding}px</Label>
                        <Slider
                          value={[shape.autoLayout!.padding]}
                          onValueChange={(v) => setAutoLayout({ padding: v[0] })}
                          min={0}
                          max={48}
                          step={1}
                        />
                      </div>
                    </div>
                    {/* Justify (alignX → justifyContent): start/center/end */}
                    <div className="mt-1">
                      <Label className="text-[10px] ac-text-3">Justify</Label>
                      <div className="grid grid-cols-3 gap-1 mt-1">
                        {(['min', 'center', 'max'] as const).map((v) => (
                          <Button
                            key={v}
                            variant={shape.autoLayout!.alignX === v ? 'default' : 'outline'}
                            size="sm"
                            className="h-6 text-[10px]"
                            onClick={() => setAutoLayout({ alignX: v })}
                          >
                            {v === 'min' ? 'Start' : v === 'max' ? 'End' : 'Center'}
                          </Button>
                        ))}
                      </div>
                    </div>
                    {/* Align (alignY → alignItems): start/center/end */}
                    <div className="mt-1">
                      <Label className="text-[10px] ac-text-3">Align</Label>
                      <div className="grid grid-cols-3 gap-1 mt-1">
                        {(['min', 'center', 'max'] as const).map((v) => (
                          <Button
                            key={v}
                            variant={shape.autoLayout!.alignY === v ? 'default' : 'outline'}
                            size="sm"
                            className="h-6 text-[10px]"
                            onClick={() => setAutoLayout({ alignY: v })}
                          >
                            {v === 'min' ? 'Start' : v === 'max' ? 'End' : 'Center'}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                <p className="text-[10px] ac-text-4 mt-1">
                  Maps to .pen flexbox (justifyContent / alignItems). Ask the
                  agent to <em>&quot;apply auto layout to this frame&quot;</em> to also reposition children.
                </p>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}

        {/* Variables · Modes — edit the node's explicit variable modes (set_node_theme patch) */}
        {!isMulti && (
          <>
            <Separator />
            <Collapsible defaultOpen={themeAxisKeys.length > 0}>
              <CollapsibleTrigger asChild>
                <button type="button" className="group flex items-center gap-1.5 w-full text-left">
                  <ChevronDown className="h-3 w-3 ac-text-4 transition-transform group-data-[state=closed]:-rotate-90" />
                  <Label className="text-[11px] ac-text-3">Variables · Modes</Label>
                  {Object.keys(effectiveTheme).length > 0 && (
                    <Badge variant="outline" className="text-[9px] h-3.5 px-1 py-0 font-normal ac-text-3 ac-border-subtle">
                      {Object.entries(effectiveTheme).map(([k, v]) => `${k}:${v}`).join(' · ')}
                    </Badge>
                  )}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-2">
                {themeAxisKeys.length === 0 ? (
                  <p className="text-[10px] ac-text-4 px-2 py-2 border border-dashed ac-border-subtle rounded">
                    No collections defined. Use <em>pen_set_variable_modes</em> to define one (e.g. mode: light/dark).
                  </p>
                ) : (
                  <>
                    {themeAxisKeys.map((axis) => {
                      const values = themeAxes[axis] ?? [];
                      const current = effectiveTheme[axis] ?? '';
                      return (
                        <div key={axis} className="flex items-center gap-2">
                          <Label className="text-[10px] ac-text-3 w-20 truncate" title={axis}>{axis}</Label>
                          <Select
                            value={current}
                            onValueChange={(v) => setNodeThemeAxis(axis, v)}
                          >
                            <SelectTrigger size="sm" className="h-7 text-[11px] flex-1">
                              <SelectValue placeholder="inherit" />
                            </SelectTrigger>
                            <SelectContent>
                              {values.map((v) => (
                                <SelectItem key={v} value={v} className="text-[11px]">
                                  {v}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                    {Object.keys(effectiveTheme).length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[10px] w-full"
                        onClick={clearNodeTheme}
                      >
                        Clear node modes
                      </Button>
                    )}
                  </>
                )}
              </CollapsibleContent>
            </Collapsible>
          </>
        )}

        {/* Slot — mark a frame as a slot for recommended components (mark_slot patch) */}
        {!isMulti && shape.type === 'frame' && (
          <>
            <Separator />
            <Collapsible defaultOpen={false}>
              <CollapsibleTrigger asChild>
                <button type="button" className="group flex items-center gap-1.5 w-full text-left">
                  <ChevronDown className="h-3 w-3 ac-text-4 transition-transform group-data-[state=closed]:-rotate-90" />
                  <SquareDashedBottom className="h-3 w-3 ac-text-4" />
                  <Label className="text-[11px] ac-text-3">Slot</Label>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-2">
                {!slotEditing ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px] w-full"
                    onClick={() => setSlotEditing(true)}
                  >
                    <SquareDashedBottom className="h-3 w-3 mr-1" /> Mark as slot…
                  </Button>
                ) : (
                  <div className="space-y-1.5">
                    <Input
                      value={slotInput}
                      onChange={(e) => setSlotInput(e.target.value)}
                      placeholder="component-id-1, component-id-2"
                      className="h-7 text-[11px]"
                    />
                    <p className="text-[10px] ac-text-4">
                      Comma-separated component IDs that may fill this slot.
                    </p>
                    <div className="grid grid-cols-2 gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[10px]"
                        onClick={() => { setSlotEditing(false); setSlotInput(''); }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-6 text-[10px]"
                        onClick={applySlot}
                        disabled={slotInput.trim().length === 0}
                      >
                        Apply
                      </Button>
                    </div>
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          </>
        )}

        {/* Text-specific */}
        {shape.type === 'text' && (
          <>
            <Separator />
            <div>
              <Label className="text-[11px] ac-text-3">Text Content</Label>
              <textarea
                value={shape.text ?? ''}
                onChange={(e) => update({ text: e.target.value })}
                className="w-full mt-1 text-xs border ac-border-default rounded p-2 resize-none h-16"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] ac-text-3">Font Size</Label>
                <Input
                  type="number"
                  value={shape.fontSize}
                  onChange={(e) => update({ fontSize: Math.max(1, parseFloat(e.target.value) || 1) })}
                  className="h-7 mt-1 text-xs"
                />
              </div>
              <div>
                <Label className="text-[11px] ac-text-3">Text Color</Label>
                <input
                  type="color"
                  value={shape.textColor}
                  onChange={(e) => update({ textColor: e.target.value })}
                  className="h-7 w-full mt-1 rounded border ac-border-default cursor-pointer"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
