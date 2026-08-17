'use client';

// Layers panel — lists every node in the .pen tree (resolved flat render
// list, ordered depth-first by zIndex), grouped by parent/child.
// Click to select; double-click to rename; eye icon to toggle visibility.
//
// Tree-aware (.pen model):
//   - Parent/child indentation (frames and groups contain children).
//   - Per-type lucide icons covering every resolved ShapeType value (incl.
//     path, image); frame/group use container-style icons.
//   - Badges: component master (M), component instance (◆ ref), auto-layout
//     (AL), effective theme (e.g. 🌙 dark), token-binding dot.
//   - Footer: document variable + theme-axis counts (the .pen design-system
//     layer).
//   - Right-click menu: Delete, Rename, Duplicate.

import { useState, type ReactNode, type ComponentType } from 'react';
import { useCanvasStore } from '@/lib/canvas/store';
import type { CanvasPatch, Shape, ShapeType } from '@/lib/canvas/types';
import {
  Eye, EyeOff, Lock, Unlock, Trash2, Layers, Copy,
  Frame, Group, Square, Circle, Type, Slash, Spline, Image as ImageIcon, Braces,
  PanelLeft, PanelLeftClose,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

// Per-type icon. Frame and group (the .pen containers) use container-style
// icons. All 8 resolved ShapeType values are covered, so the lookup never
// falls back to the placeholder.
const TYPE_ICON: Record<ShapeType, ComponentType<{ className?: string }>> = {
  rectangle: Square,
  ellipse: Circle,
  text: Type,
  line: Slash,
  frame: Frame,
  group: Group,
  path: Spline,
  image: ImageIcon,
};

/**
 * Render a compact, human-friendly label for a node's effective theme.
 *   { mode: 'dark' }                       -> "🌙 dark"
 *   { mode: 'light' }                      -> "☀️ light"
 *   { mode: 'dark', spacing: 'compact' }   -> "mode:dark · spacing:compact"
 * Returns null when the theme is empty/absent (badge stays hidden).
 */
function themeLabel(theme: Record<string, string> | undefined | null): string | null {
  if (!theme) return null;
  const entries = Object.entries(theme).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return null;
  if (entries.length === 1 && entries[0][0] === 'mode') {
    const v = entries[0][1];
    const emoji = v === 'dark' ? '🌙' : v === 'light' ? '☀️' : '🎨';
    return `${emoji} ${v}`;
  }
  return entries.map(([k, v]) => `${k}:${v}`).join(' · ');
}

export function LayersPanel({
  collapsed = false,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
} = {}) {
  const document = useCanvasStore((s) => s.document);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const select = useCanvasStore((s) => s.select);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Build a tree: top-level shapes (parentId null) first, with children
  // indented under their parent. Render top-to-bottom = highest z-index first.
  const shapes = document.shapes ?? [];
  const sortedTop = [...shapes]
    .filter((s) => !s.parentId)
    .sort((a, b) => b.zIndex - a.zIndex);
  const childrenOf = (id: string) =>
    shapes.filter((s) => s.parentId === id).sort((a, b) => b.zIndex - a.zIndex);

  const renderShape = (shape: Shape, depth: number): ReactNode => {
    const selected = selectedIds.includes(shape.id);
    const children = childrenOf(shape.id);
    const isComponentMaster = shape.componentId === shape.id;
    const isComponentInstance = !!shape.componentId && shape.componentId !== shape.id;
    const hasAutoLayout = !!shape.autoLayout;
    const hasTokenBinding = !!shape.tokenBinding && (!!shape.tokenBinding.fillToken || !!shape.tokenBinding.textToken);
    const themeStr = themeLabel(shape.theme);
    const TypeIcon = TYPE_ICON[shape.type] ?? Square;
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
            <span className="w-4 flex items-center justify-center ac-text-4">
              <TypeIcon className="h-3 w-3" />
            </span>
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
            {/* Badges — priority order: Master > Instance > AL > theme > token.
                At most ONE badge is rendered visually; the rest go into the
                row's `title` attribute so they're still discoverable on hover
                without crowding the row. */}
            {(() => {
              // Build the list of all applicable badges for this row.
              type Badge = { label: string; node: ReactNode };
              const all: Badge[] = [];
              if (isComponentMaster) all.push({ label: 'Master', node: <span className="text-[9px] px-1 py-0 rounded bg-sky-100 text-sky-700 font-medium">M</span> });
              if (isComponentInstance) all.push({ label: 'Instance (ref)', node: <span className="text-[9px] px-1 py-0 rounded bg-violet-100 text-violet-700 font-medium">◆</span> });
              if (hasAutoLayout) all.push({ label: 'Auto Layout', node: <span className="text-[9px] px-1 py-0 rounded bg-emerald-100 text-emerald-700 font-medium">AL</span> });
              if (themeStr) all.push({ label: `theme: ${themeStr}`, node: <span className="text-[9px] px-1 py-0 rounded ac-surface-2 ac-text-3 font-medium">{themeStr}</span> });
              if (hasTokenBinding) all.push({ label: 'Bound to design token', node: <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-500" /> });

              if (all.length === 0) return null;
              // Render only the highest-priority badge visually; collect the
              // rest into a hover tooltip string for the row's title attribute
              // (which we compose into the parent <div> via aria-label below).
              const primary = all[0];
              const restStr = all.length > 1
                ? ' · also: ' + all.slice(1).map((b) => b.label).join(', ')
                : '';
              return (
                <span
                  className="flex-shrink-0"
                  title={all.map((b) => b.label).join(' · ')}
                  aria-label={all.map((b) => b.label).join(' · ')}
                  data-extra-badges={restStr}
                >
                  {primary.node}
                </span>
              );
            })()}
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

  // .pen design-system summary: document variables (count of keys) + theme
  // axes (count of axes in `document.themes`). Both are optional on a .pen
  // document; absent means zero.
  const nodeCount = shapes.length;
  const variableCount = document.variables ? Object.keys(document.variables).length : 0;
  const themeAxisCount = document.themes ? Object.keys(document.themes).length : 0;

  return (
    <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
      <div className="flex items-center justify-between px-3 py-2 border-b ac-border-subtle">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ac-text-2 min-w-0">
          <Layers className="h-3.5 w-3.5 ac-text-3 flex-shrink-0" />
          <span className="truncate">Layers</span>
          <span className="text-[10px] ac-text-4 font-normal normal-case tracking-normal">{nodeCount}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {onToggleCollapse && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleCollapse}
              title="Toggle layers (⌘2)"
              aria-label="Toggle layers panel"
              className="h-6 w-6 p-0 ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring"
            >
              {collapsed ? <PanelLeft className="h-3 w-3" /> : <PanelLeftClose className="h-3 w-3" />}
            </Button>
          )}
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0 ac-hide-scrollbar">
        <div className="p-1">
          {sortedTop.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <p className="text-[11px] font-medium ac-text-3 mb-1">No nodes yet</p>
              <p className="text-[11px] ac-text-4">Ask the agent to create something, or use the toolbar.</p>
            </div>
          ) : (
            sortedTop.map((shape) => renderShape(shape, 0))
          )}
        </div>
      </ScrollArea>
      {/* .pen design-system summary footer */}
      <div className="border-t ac-border-subtle px-3 py-1.5 flex items-center gap-1.5 text-[10px] ac-text-4">
        <Braces className="h-3 w-3 ac-text-4" aria-hidden />
        <span>
          {variableCount} variable{variableCount === 1 ? '' : 's'}
          {' · '}
          {themeAxisCount} theme axis{themeAxisCount === 1 ? '' : 'es'}
        </span>
      </div>
    </div>
  );
}
