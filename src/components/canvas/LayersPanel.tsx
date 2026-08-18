'use client';

// Layers panel — lists every node in the .pen tree (resolved flat render
// list, ordered depth-first by zIndex), grouped by parent/child.
// Click to select; double-click to rename; eye icon to toggle visibility.
//
// Figma-hierarchy features (research: developers.figma.com/docs/plugins/api/FrameNode):
//   - Parent/child indentation (frames and groups contain children).
//   - Per-type lucide icons covering every resolved ShapeType value (incl.
//     path, image); frame/group use container-style icons.
//   - EXPAND / COLLAPSE: each container row has a chevron toggle. Default is
//     expanded. State is persisted per-document in localStorage so it survives
//     reloads. Mirrors Figma's layers panel behavior.
//   - DRAG-TO-REPARENT: rows are HTML5-draggable. Dropping a row onto another
//     frame/group row emits a `reparent` patch (keepAbsolutePosition=true,
//     so the dragged node visually stays put). Dropping onto the empty area
//     below the list promotes the node to root.
//   - Badges: component master (M), component instance (◆ ref), auto-layout
//     (AL), effective theme (e.g. 🌙 dark), token-binding dot.
//   - Footer: document variable + theme-axis counts (the .pen design-system
//     layer).
//   - Right-click menu: Delete, Rename, Duplicate.

import { useState, useMemo, type ReactNode, type ComponentType } from 'react';
import { useCanvasStore } from '@/lib/canvas/store';
import { useClipboard } from '@/hooks/use-clipboard';
import type { CanvasPatch, Shape, ShapeType } from '@/lib/canvas/types';
import {
  Eye, EyeOff, Lock, Unlock, Trash2, Layers, Copy, Scissors, ClipboardPaste, Search,
  Frame, Group, Square, Circle, Type, Slash, Spline, Image as ImageIcon, Braces,
  ChevronRight, ChevronDown, ChevronsUpDown, ChevronsDownUp,
  BringToFront, SendToBack, ArrowUp, ArrowDown, SquareStack, Component as ComponentIcon,
  FileCode, FileDown, Edit2,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
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

// ---- Expand/collapse state (persisted per-document in localStorage) -------

const COLLAPSED_KEY = 'ac:layers-collapsed';

function loadCollapsed(docId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(`${COLLAPSED_KEY}:${docId}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveCollapsed(docId: string, collapsed: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${COLLAPSED_KEY}:${docId}`, JSON.stringify([...collapsed]));
  } catch {
    // localStorage may be unavailable (private mode, quota) — silently ignore.
  }
}

export function LayersPanel() {
  const document = useCanvasStore((s) => s.document);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const select = useCanvasStore((s) => s.select);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const clipboard = useClipboard();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(document.id));
  const [searchQuery, setSearchQuery] = useState('');

  // Persist the collapsed set whenever it changes.
  const updateCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    saveCollapsed(document.id, next);
  };

  // Build a tree: top-level shapes (parentId null) first, with children
  // indented under their parent. Render top-to-bottom = highest z-index first.
  const shapes = document.shapes ?? [];

  // P0-12: search filter — a shape matches if its name contains the query
  // (case-insensitive), OR any descendant matches. Matching shapes and their
  // ancestors are shown; non-matching siblings are hidden.
  const filteredShapes = useMemo(() => {
    if (!searchQuery.trim()) return shapes;
    const q = searchQuery.toLowerCase();
    const matches = (s: Shape) => s.name.toLowerCase().includes(q);
    // Compute the set of "visible" ids: any shape that matches OR is an
    // ancestor of a matching shape.
    const visible = new Set<string>();
    const byId = new Map(shapes.map((s) => [s.id, s] as const));
    const childrenOfMap = new Map<string | null, Shape[]>();
    for (const s of shapes) {
      const key = s.parentId ?? null;
      if (!childrenOfMap.has(key)) childrenOfMap.set(key, []);
      childrenOfMap.get(key)!.push(s);
    }
    // Mark a shape + all its ancestors visible.
    const markVisible = (s: Shape) => {
      let cur: Shape | undefined = s;
      while (cur && !visible.has(cur.id)) {
        visible.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    };
    for (const s of shapes) {
      if (matches(s)) markVisible(s);
    }
    return shapes.filter((s) => visible.has(s.id));
  }, [shapes, searchQuery]);

  const sortedTop = useMemo(
    () => [...filteredShapes].filter((s) => !s.parentId).sort((a, b) => b.zIndex - a.zIndex),
    [filteredShapes],
  );
  const childrenOf = (id: string) =>
    filteredShapes.filter((s) => s.parentId === id).sort((a, b) => b.zIndex - a.zIndex);

  // Containers (frame / group) can be expanded/collapsed and are valid drop
  // targets for reparent.
  const isContainer = (s: Shape) => s.type === 'frame' || s.type === 'group';

  const toggleExpand = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateCollapsed(next);
  };

  // P0-12: Expand-all / Collapse-all helpers.
  const expandAll = () => {
    const allContainerIds = shapes.filter(isContainer).map((s) => s.id);
    updateCollapsed(new Set()); // nothing collapsed = all expanded
    void allContainerIds; // referenced for clarity; we want all expanded
  };
  const collapseAll = () => {
    const allContainerIds = new Set(shapes.filter(isContainer).map((s) => s.id));
    updateCollapsed(allContainerIds);
  };

  // ---- Drag-to-reparent ------------------------------------------------------
  // We use HTML5 DnD. The dragged row's shapeId is stored in dataTransfer.
  // Drop targets are container rows (frame/group) and the empty area below
  // the list (which means "move to root"). We emit an `op:'reparent'` patch
  // with keepAbsolutePosition=true (default) so the dragged node visually
  // stays put.
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const onRowDragStart = (e: React.DragEvent, shape: Shape) => {
    e.dataTransfer.setData('text/plain', shape.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const onRowDragOver = (e: React.DragEvent, shape: Shape) => {
    if (!isContainer(shape)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverId !== shape.id) setDragOverId(shape.id);
  };

  const onRowDragLeave = (shape: Shape) => {
    if (dragOverId === shape.id) setDragOverId(null);
  };

  const onRowDrop = (e: React.DragEvent, target: Shape | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(null);
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId) return;
    if (target && !isContainer(target)) return;
    if (target && target.id === draggedId) return; // can't reparent into self
    const newParentId = target ? target.id : null;
    const patch: CanvasPatch = {
      op: 'reparent',
      shapeId: draggedId,
      newParentId,
      keepAbsolutePosition: true,
      summary: `Reparented via layers drag → ${target ? `"${target.name}"` : 'root'}`,
    };
    sendPatch(patch);
  };

  const renderShape = (shape: Shape, depth: number): ReactNode => {
    const selected = selectedIds.includes(shape.id);
    const children = childrenOf(shape.id);
    const isContainerNode = isContainer(shape);
    const isExpanded = !collapsed.has(shape.id);
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
            // NOTE: draggable + onClick conflict — but the LayersPanel rows
            // don't have a text input (except when editing the name), so the
            // HTML5 DnD click-to-select still works fine.
            draggable={editingId !== shape.id}
            onDragStart={(e) => onRowDragStart(e, shape)}
            onDragOver={(e) => onRowDragOver(e, shape)}
            onDragLeave={() => onRowDragLeave(shape)}
            onDrop={(e) => onRowDrop(e, shape)}
            className={`group flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-pointer ac-transition ${
              selected ? 'bg-sky-50 text-sky-900' : 'hover:ac-surface-1 ac-text-2'
            }${dragOverId === shape.id ? ' ring-2 ring-sky-300' : ''}`}
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
            {/* Expand/collapse chevron — only for containers with children. */}
            {isContainerNode && children.length > 0 ? (
              <button
                className="w-3 h-3 flex items-center justify-center ac-text-4 hover:ac-text-1 ac-transition"
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
                title={isExpanded ? 'Collapse' : 'Expand'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(shape.id);
                }}
              >
                {isExpanded
                  ? <ChevronDown className="h-3 w-3" />
                  : <ChevronRight className="h-3 w-3" />}
              </button>
            ) : (
              <span className="w-3 h-3 inline-block" />
            )}
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
              // Constraints badge (small "C" pill) — surfaces that the node has
              // Figma-style layout constraints set.
              if (shape.constraints) {
                all.push({
                  label: `constraints: ${shape.constraints.horizontal}/${shape.constraints.vertical}`,
                  node: <span className="text-[9px] px-1 py-0 rounded bg-amber-100 text-amber-700 font-medium">C</span>,
                });
              }

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
              aria-label={shape.visible ? `Hide ${shape.name}` : `Show ${shape.name}`}
              aria-pressed={!shape.visible}
              title={shape.visible ? 'Hide layer' : 'Show layer'}
              onClick={(e) => {
                e.stopPropagation();
                sendPatch({ op: 'update', shapeId: shape.id, shape: { visible: !shape.visible }, summary: `${shape.visible ? 'Hid' : 'Showed'} ${shape.name}` });
              }}
            >
              {shape.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            </button>
            <button
              className="opacity-0 group-hover:opacity-100 ac-text-4 hover:ac-text-1 ac-transition"
              aria-label={shape.locked ? `Unlock ${shape.name}` : `Lock ${shape.name}`}
              aria-pressed={shape.locked}
              title={shape.locked ? 'Unlock layer' : 'Lock layer'}
              onClick={(e) => {
                e.stopPropagation();
                sendPatch({ op: 'update', shapeId: shape.id, shape: { locked: !shape.locked }, summary: `${shape.locked ? 'Unlocked' : 'Locked'} ${shape.name}` });
              }}
            >
              {shape.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {/* ── Group 1: Clipboard (P0-03) ───────────────────────────── */}
          <ContextMenuItem onClick={() => clipboard.cut([shape])}>
            <Scissors className="h-3.5 w-3.5 mr-2" /> Cut <span className="ml-auto text-[10px] ac-text-4">⌘X</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => clipboard.copy([shape])}>
            <Copy className="h-3.5 w-3.5 mr-2" /> Copy <span className="ml-auto text-[10px] ac-text-4">⌘C</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => clipboard.paste()}>
            <ClipboardPaste className="h-3.5 w-3.5 mr-2" /> Paste <span className="ml-auto text-[10px] ac-text-4">⌘V</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => clipboard.paste({ offset: { dx: 0, dy: 0 } })}>
            <ClipboardPaste className="h-3.5 w-3.5 mr-2" /> Paste in place <span className="ml-auto text-[10px] ac-text-4">⌘⇧V</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => sendPatch({ op: 'duplicate', shapeIds: [shape.id], summary: `Duplicated ${shape.name}` })}>
            <Copy className="h-3.5 w-3.5 mr-2" /> Duplicate here <span className="ml-auto text-[10px] ac-text-4">⌘D</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* ── Group 2: Z-order (P0-07) ─────────────────────────────── */}
          <ContextMenuItem onClick={() => sendPatch({ op: 'zorder', shapeIds: [shape.id], zorderKind: 'forward', summary: `Bring forward ${shape.name}` })}>
            <ArrowUp className="h-3.5 w-3.5 mr-2" /> Bring forward <span className="ml-auto text-[10px] ac-text-4">⌘]</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => sendPatch({ op: 'zorder', shapeIds: [shape.id], zorderKind: 'front', summary: `Bring to front ${shape.name}` })}>
            <BringToFront className="h-3.5 w-3.5 mr-2" /> Bring to front <span className="ml-auto text-[10px] ac-text-4">⌘⇧]</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => sendPatch({ op: 'zorder', shapeIds: [shape.id], zorderKind: 'backward', summary: `Send backward ${shape.name}` })}>
            <ArrowDown className="h-3.5 w-3.5 mr-2" /> Send backward <span className="ml-auto text-[10px] ac-text-4">⌘[</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => sendPatch({ op: 'zorder', shapeIds: [shape.id], zorderKind: 'back', summary: `Send to back ${shape.name}` })}>
            <SendToBack className="h-3.5 w-3.5 mr-2" /> Send to back <span className="ml-auto text-[10px] ac-text-4">⌘⇧[</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* ── Group 3: Structure (P0-05) ───────────────────────────── */}
          {selectedIds.length >= 2 && (
            <ContextMenuItem onClick={() => sendPatch({ op: 'group', shapeIds: selectedIds, summary: `Grouped ${selectedIds.length} shape(s)` })}>
              <Group className="h-3.5 w-3.5 mr-2" /> Group <span className="ml-auto text-[10px] ac-text-4">⌘G</span>
            </ContextMenuItem>
          )}
          {shape.type === 'group' && (
            <ContextMenuItem onClick={() => sendPatch({ op: 'ungroup', shapeIds: [shape.id], summary: `Ungrouped ${shape.name}` })}>
              <SquareStack className="h-3.5 w-3.5 mr-2" /> Ungroup <span className="ml-auto text-[10px] ac-text-4">⌘⇧G</span>
            </ContextMenuItem>
          )}
          {/* ── Group 4: Visibility ──────────────────────────────────── */}
          <ContextMenuItem onClick={() => sendPatch({ op: 'update', shapeId: shape.id, shape: { locked: !shape.locked }, summary: `${shape.locked ? 'Unlocked' : 'Locked'} ${shape.name}` })}>
            <Lock className="h-3.5 w-3.5 mr-2" /> {shape.locked ? 'Unlock' : 'Lock'} <span className="ml-auto text-[10px] ac-text-4">⌘L</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => sendPatch({ op: 'update', shapeId: shape.id, shape: { visible: !shape.visible }, summary: `${shape.visible ? 'Hid' : 'Showed'} ${shape.name}` })}>
            <Eye className="h-3.5 w-3.5 mr-2" /> {shape.visible ? 'Hide' : 'Show'} <span className="ml-auto text-[10px] ac-text-4">⌘;</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* ── Group 5: Components ──────────────────────────────────── */}
          <ContextMenuItem onClick={() => sendPatch({ op: 'update', shapeId: shape.id, shape: { componentId: shape.id } as Partial<Shape>, summary: `Marked ${shape.name} as component master` })}>
            <ComponentIcon className="h-3.5 w-3.5 mr-2" /> Create component <span className="ml-auto text-[10px] ac-text-4">⌘⇧C</span>
          </ContextMenuItem>
          {shape.type === 'frame' && (
            <ContextMenuItem onClick={() => sendPatch({ op: 'mark_slot', shapeId: shape.id, slotComponents: [], summary: `Marked ${shape.name} as slot` })}>
              <SquareStack className="h-3.5 w-3.5 mr-2" /> Mark as slot
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {/* ── Group 6: Copy as / Export (submenus) ─────────────────── */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FileCode className="h-3.5 w-3.5 mr-2" /> Copy as
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={() => toast.message('Copy as HTML — not yet implemented in the UI layer.')}>HTML</ContextMenuItem>
              <ContextMenuItem onClick={() => toast.message('Copy as React — not yet implemented in the UI layer.')}>React</ContextMenuItem>
              <ContextMenuItem onClick={() => toast.message('Copy as Tailwind — not yet implemented in the UI layer.')}>Tailwind</ContextMenuItem>
              <ContextMenuItem onClick={() => toast.message('Copy as SVG — not yet implemented in the UI layer.')}>SVG</ContextMenuItem>
              <ContextMenuItem onClick={() => toast.message('Copy as JSON — not yet implemented in the UI layer.')}>JSON</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FileDown className="h-3.5 w-3.5 mr-2" /> Export
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={() => toast.message('Export PNG — not yet implemented in the UI layer.')}>PNG</ContextMenuItem>
              <ContextMenuItem onClick={() => toast.message('Export SVG — not yet implemented in the UI layer.')}>SVG</ContextMenuItem>
              <ContextMenuItem onClick={() => toast.message('Export .pen — not yet implemented in the UI layer.')}>.pen</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          {/* ── Group 7: Tree ops ───────────────────────────────────── */}
          {isContainerNode && children.length > 0 && (
            <ContextMenuItem onClick={() => select(children.map((c) => c.id))}>
              <SquareStack className="h-3.5 w-3.5 mr-2" /> Select all children
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => { const next = new Set(collapsed); next.delete(shape.id); updateCollapsed(next); }}>
            <ChevronsUpDown className="h-3.5 w-3.5 mr-2" /> Expand subtree
          </ContextMenuItem>
          <ContextMenuItem onClick={() => { const next = new Set(collapsed); next.add(shape.id); updateCollapsed(next); }}>
            <ChevronsDownUp className="h-3.5 w-3.5 mr-2" /> Collapse subtree
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* P2-42/43/44: Submenus for theme axis / token binding / reparent-to */}
          {document.themes && Object.keys(document.themes).length > 0 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Braces className="h-3.5 w-3.5 mr-2" /> Apply theme axis
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {Object.entries(document.themes).map(([axis, values]) => (
                  values.map((val: string) => (
                    <ContextMenuItem
                      key={`${axis}=${val}`}
                      onClick={() => sendPatch({ op: 'set_node_theme', shapeId: shape.id, theme: { [axis]: val } as Record<string, string>, summary: `Set ${axis}=${val} on ${shape.name}` })}
                    >
                      {axis} = {val}
                    </ContextMenuItem>
                  ))
                )).flat()}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {document.tokens?.colors && document.tokens.colors.length > 0 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Braces className="h-3.5 w-3.5 mr-2" /> Bind to token
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {document.tokens.colors.map((tok) => (
                  <ContextMenuItem
                    key={tok.key}
                    onClick={() => sendPatch({
                      op: 'update',
                      shapeId: shape.id,
                      shape: { tokenBinding: { fillToken: tok.key } } as Partial<Shape>,
                      summary: `Bound ${shape.name} fill to ${tok.key}`,
                    })}
                  >
                    {tok.name} ({tok.value})
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Braces className="h-3.5 w-3.5 mr-2" /> Reparent to…
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={() => sendPatch({ op: 'reparent', shapeId: shape.id, newParentId: null, keepAbsolutePosition: true, summary: `Reparented ${shape.name} → root` })}>
                (root — top-level)
              </ContextMenuItem>
              {shapes.filter((s) => (s.type === 'frame' || s.type === 'group') && s.id !== shape.id).map((parent) => (
                <ContextMenuItem
                  key={parent.id}
                  onClick={() => sendPatch({ op: 'reparent', shapeId: shape.id, newParentId: parent.id, keepAbsolutePosition: true, summary: `Reparented ${shape.name} → ${parent.name}` })}
                >
                  {parent.name} ({parent.type})
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          {/* ── Group 8: Existing items (Rename / Delete / Duplicate) ── */}
          <ContextMenuItem onClick={() => setEditingId(shape.id)}>
            <Edit2 className="h-3.5 w-3.5 mr-2" /> Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={() => sendPatch({ op: 'duplicate', shapeIds: [shape.id], summary: `Duplicated ${shape.name}` })}>
            <Copy className="h-3.5 w-3.5 mr-2" /> Duplicate
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              sendPatch({ op: 'remove', shapeIds: [shape.id], summary: `Deleted ${shape.name}` });
              if (selectedIds.includes(shape.id)) select(selectedIds.filter((id) => id !== shape.id));
            }}
            className="text-rose-600"
          >
            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete <span className="ml-auto text-[10px] ac-text-4">⌫</span>
          </ContextMenuItem>
        </ContextMenuContent>
        {isContainerNode && children.length > 0 && isExpanded && (
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
        {/* P0-12: Expand-all / Collapse-all buttons in the header. */}
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={expandAll}
            title="Expand all containers"
            aria-label="Expand all"
            className="h-6 w-6 p-0 ac-text-3 hover:ac-text-1 hover:ac-surface-1"
          >
            <ChevronsUpDown className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={collapseAll}
            title="Collapse all containers"
            aria-label="Collapse all"
            className="h-6 w-6 p-0 ac-text-3 hover:ac-text-1 hover:ac-surface-1"
          >
            <ChevronsDownUp className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {/* P0-12: Search-by-name input. Filters layers in real time. */}
      <div className="px-2 py-1.5 border-b ac-border-subtle">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 ac-text-4" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search layers…"
            className="h-6 text-[11px] pl-7 pr-2 ac-text-2 ac-surface-1 ac-border-subtle"
          />
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0 ac-hide-scrollbar">
        {/* The scroll area's inner div is the drop target for "move to root".
            We attach onDrop here so that dropping into the empty area below
            the list (or between rows) promotes the dragged node to root. */}
        <div
          className="p-1 min-h-full"
          onDragOver={(e) => {
            // Allow drop only if the drag wasn't already handled by a row.
            // We always preventDefault so the drop fires here when no row
            // caught it.
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            // Only handle if no row consumed the drop first. Rows call
            // stopPropagation, so this only fires when dropping on empty area.
            onRowDrop(e, null);
          }}
        >
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
