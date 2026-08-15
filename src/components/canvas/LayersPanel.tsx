'use client';

// Layers panel — lists every shape on the canvas, grouped by z-order.
// Click to select; double-click to rename; eye icon to toggle visibility.
//
// Extended with:
//   - Parent/child indentation (groups and frames contain children)
//   - Badges for component master (M), component instance (I), auto-layout (AL)
//   - Token-binding dot indicator
//   - Right-click menu: Delete, Rename, Duplicate

import { useState } from 'react';
import { useCanvasStore } from '@/lib/canvas/store';
import type { CanvasPatch, Shape } from '@/lib/canvas/types';
import { Eye, EyeOff, Lock, Unlock, Trash2, Layers, Copy } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

const TYPE_ICON: Record<string, string> = {
  rectangle: '▭',
  ellipse: '◯',
  text: 'T',
  line: '╱',
  frame: '▢',
  group: '▤',
};

export function LayersPanel() {
  const document = useCanvasStore((s) => s.document);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const select = useCanvasStore((s) => s.select);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Build a tree: top-level shapes (parentId null) first, with children
  // indented under their parent. Render top-to-bottom = highest z-index first.
  const sortedTop = [...(document.shapes ?? [])]
    .filter((s) => !s.parentId)
    .sort((a, b) => b.zIndex - a.zIndex);
  const childrenOf = (id: string) =>
    (document.shapes ?? []).filter((s) => s.parentId === id).sort((a, b) => b.zIndex - a.zIndex);

  const renderShape = (shape: Shape, depth: number): React.ReactNode => {
    const selected = selectedIds.includes(shape.id);
    const children = childrenOf(shape.id);
    const isComponentMaster = shape.componentId === shape.id;
    const isComponentInstance = !!shape.componentId && shape.componentId !== shape.id;
    const hasAutoLayout = !!shape.autoLayout;
    const hasTokenBinding = !!shape.tokenBinding && (!!shape.tokenBinding.fillToken || !!shape.tokenBinding.textToken);
    return (
      <ContextMenu key={shape.id}>
        <ContextMenuTrigger asChild>
          <div
            className={`group flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-pointer ac-transition ${
              selected ? 'bg-sky-50 text-sky-900' : 'hover:ac-surface-1 ac-text-2'
            }`}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            onClick={(e) => {
              if (e.shiftKey) {
                select(selectedIds.includes(shape.id)
                  ? selectedIds.filter((id) => id !== shape.id)
                  : [...selectedIds, shape.id]);
              } else {
                select([shape.id]);
              }
            }}
            onDoubleClick={() => setEditingId(shape.id)}
          >
            <span className="text-[10px] w-4 text-center ac-text-4">{TYPE_ICON[shape.type] ?? '?'}</span>
            {editingId === shape.id ? (
              <Input
                autoFocus
                defaultValue={shape.name}
                className="h-5 text-xs px-1 py-0 flex-1"
                onBlur={(e) => {
                  const newName = e.target.value.trim() || shape.name;
                  sendPatch({ op: 'update', shapeId: shape.id, shape: { name: newName }, summary: `Renamed to "${newName}"` });
                  setEditingId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingId(null);
                }}
              />
            ) : (
              <span className="flex-1 truncate">{shape.name}</span>
            )}
            {/* Badges */}
            {hasTokenBinding && (
              <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-500" title="Bound to design token" />
            )}
            {hasAutoLayout && (
              <span className="text-[9px] px-1 py-0 rounded bg-emerald-100 text-emerald-700 font-medium" title="Auto Layout applied">AL</span>
            )}
            {isComponentMaster && (
              <span className="text-[9px] px-1 py-0 rounded bg-sky-100 text-sky-700 font-medium" title="Component master">M</span>
            )}
            {isComponentInstance && (
              <span className="text-[9px] px-1 py-0 rounded bg-violet-100 text-violet-700 font-medium" title="Component instance">I</span>
            )}
            <button
              className="opacity-0 group-hover:opacity-100 ac-text-4 hover:ac-text-1 ac-transition"
              onClick={(e) => {
                e.stopPropagation();
                sendPatch({ op: 'update', shapeId: shape.id, shape: { visible: !shape.visible }, summary: `${shape.visible ? 'Hid' : 'Showed'} ${shape.name}` });
              }}
            >
              {shape.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            </button>
            <button
              className="opacity-0 group-hover:opacity-100 ac-text-4 hover:ac-text-1 ac-transition"
              onClick={(e) => {
                e.stopPropagation();
                sendPatch({ op: 'update', shapeId: shape.id, shape: { locked: !shape.locked }, summary: `${shape.locked ? 'Unlocked' : 'Locked'} ${shape.name}` });
              }}
            >
              {shape.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              const patch: CanvasPatch = { op: 'remove', shapeIds: [shape.id], summary: `Deleted ${shape.name}` };
              sendPatch(patch);
              if (selectedIds.includes(shape.id)) select(selectedIds.filter((id) => id !== shape.id));
            }}
          >
            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              const patch: CanvasPatch = { op: 'duplicate', shapeIds: [shape.id], summary: `Duplicated ${shape.name}` };
              sendPatch(patch);
            }}
          >
            <Copy className="h-3.5 w-3.5 mr-2" /> Duplicate
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setEditingId(shape.id)}>
            Rename
          </ContextMenuItem>
        </ContextMenuContent>
        {children.length > 0 && (
          <div>{children.map((c) => renderShape(c, depth + 1))}</div>
        )}
      </ContextMenu>
    );
  };

  return (
    <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
      <div className="flex items-center justify-between px-3 py-2 border-b ac-border-subtle">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ac-text-2">
          <Layers className="h-3.5 w-3.5 ac-text-3" />
          Layers
        </div>
        <span className="text-[10px] ac-text-4">{(document.shapes ?? []).length} shape{(document.shapes ?? []).length === 1 ? '' : 's'}</span>
      </div>
      <ScrollArea className="flex-1 min-h-0 ac-hide-scrollbar">
        <div className="p-1">
          {sortedTop.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <p className="text-[11px] font-medium ac-text-3 mb-1">No layers yet</p>
              <p className="text-[11px] ac-text-4">Ask the agent to create something, or use the toolbar.</p>
            </div>
          ) : (
            sortedTop.map((shape) => renderShape(shape, 0))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
