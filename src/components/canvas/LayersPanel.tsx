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

import { useState, useEffect, useMemo, type ReactNode, type ComponentType } from 'react';
import { useCanvasStore } from '@/lib/canvas/store';
import { useClipboard } from '@/hooks/use-clipboard';
import type { CanvasPatch, Shape, LayerType } from '@/lib/canvas/types';
import { exportSvg, exportPngDataUrl, exportJson, exportCode, downloadFile, downloadDataUrl, copyToClipboard } from '@/lib/canvas/export';
import { collectComponents } from '@/lib/pen/document';
import { COMPONENT_DRAG_MIME } from '@/lib/canvas/assets-drag';
import type { PenChild } from '@/lib/pen/types';
import {
  Eye, EyeOff, Lock, Unlock, Trash2, Layers, Copy, Scissors, ClipboardPaste, Search,
  Frame, Group, Square, Circle, Type, Slash, Spline, Image as ImageIcon, Braces,
  ChevronRight, ChevronDown, ChevronsUpDown, ChevronsDownUp,
  BringToFront, SendToBack, ArrowUp, ArrowDown, SquareStack, Component as ComponentIcon,
  FileCode, FileDown, Edit2,
  // Figma ontology icons:
  Section as SectionIcon,
  Boxes,                   // component_set (stack of variants)
  GitBranch,               // boolean_operation
  Crop,                    // slice (export region)
  Star as StarIcon,        // star
  Hexagon,                 // polygon
  CornerDownRight,         // instance (component instance)
  Gem,                     // icon (library glyph node — lucide)
  // Phase 2 component-system icons (instance actions):
  Unlink,                  // detach instance
  RotateCcw,               // reset overrides
  // Phase 7 Pages column icons:
  Plus,                    // add page
  Files,                   // page chip
  // Phase 7 §H.1 Assets tab icon:
  Package,                 // assets grid empty state
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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

// Per-type icon. Covers every resolved LayerType value (the Figma-canonical
// node type union).
const TYPE_ICON: Record<LayerType, ComponentType<{ className?: string }>> = {
  // Containers:
  frame: Frame,
  group: Group,
  section: SectionIcon,
  component: ComponentIcon,
  component_set: Boxes,
  instance: CornerDownRight,
  boolean_operation: GitBranch,
  // Leaves:
  rectangle: Square,
  ellipse: Circle,
  text: Type,
  line: Slash,
  path: Spline,
  star: StarIcon,
  polygon: Hexagon,
  slice: Crop,
  image: ImageIcon,
  icon: Gem,
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

// ---- Assets tab thumbnail (spec Phase 7 §H.1) ----------------------------
//
// The Assets grid cards show a small visual preview of each reusable
// component. We can't run the full DOM renderer recursively inside a 64px
// card (perf + layout cost), so we render a tinted box whose color is the
// first concrete paint we can find on the component (or any descendant).
// This is the same "color swatch" Figma shows in the Assets panel for
// components that don't carry a baked preview image — it's enough for the
// user to recognize the component; the full preview appears on hover/canvas
// after the instance is placed.
const NEUTRAL_THUMBNAIL = 'var(--ac-surface-2)';

function nodeFill(node: PenChild): string | null {
  // Prefer the explicit .pen v3 `fills` array (Figma REST-aligned); fall
  // back to the legacy `fill` string. Either may be unset on a frame with
  // only child graphics (common for icon-style components).
  const anyNode = node as unknown as {
    fill?: string | null;
    fills?: Array<{ color?: string; type?: string; opacity?: number }>;
  };
  if (Array.isArray(anyNode.fills) && anyNode.fills.length > 0) {
    const solid = anyNode.fills.find((p) => p && p.color && (!p.type || p.type === 'SOLID'));
    if (solid?.color) return solid.color;
  }
  if (typeof anyNode.fill === 'string' && anyNode.fill) return anyNode.fill;
  return null;
}

/// Find a representative paint color for a component card thumbnail.
/// 1. The component's own fill.
/// 2. The first descendant (BFS) with a fill — components typically wrap
///    a colored rect or text node; we surface that color so "Button"
///    components look blue, "Card" components look white, etc.
/// 3. Fallback neutral surface token.
function componentThumbnailColor(node: PenChild): string {
  const direct = nodeFill(node);
  if (direct) return direct;
  // BFS one level deep into the component's children — covers the common
  // "frame with a colored rect inside" shape without a full tree walk.
  const children = (node as { children?: PenChild[] }).children ?? [];
  for (const child of children) {
    const c = nodeFill(child);
    if (c) return c;
    const grandChildren = (child as { children?: PenChild[] }).children ?? [];
    for (const gc of grandChildren) {
      const g = nodeFill(gc);
      if (g) return g;
    }
  }
  return NEUTRAL_THUMBNAIL;
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

  // ---- ⌘R rename (spec Phase 7) ----------------------------------------------
  // page.tsx's registry dispatch for 'rename' fires this CustomEvent; we
  // focus the first selected layer's inline rename input.
  useEffect(() => {
    const onRenameRequest = () => {
      const sel = useCanvasStore.getState().selectedIds;
      if (sel.length > 0) setEditingId(sel[0]);
    };
    window.addEventListener('ac:layers-rename', onRenameRequest);
    return () => window.removeEventListener('ac:layers-rename', onRenameRequest);
  }, []);

  // ---- ⌥1 / ⌥2 tab switching (spec Phase 7 §H.1, Appendix H §H.3 #1) --------
  // page.tsx dispatches `ac:layers-set-tab` when the registry matches the
  // 'panel.layers-tab' (⌥1) or 'panel.assets-tab' (⌥2) action. We keep the
  // tab state LOCAL to the panel session (no store field) — Figma tracks it
  // per-session too; on reload it resets to Layers (the default).
  const [activeTab, setActiveTab] = useState<'layers' | 'assets'>('layers');
  useEffect(() => {
    const onSetTab = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail === 'layers' || detail === 'assets') setActiveTab(detail);
    };
    window.addEventListener('ac:layers-set-tab', onSetTab);
    return () => window.removeEventListener('ac:layers-set-tab', onSetTab);
  }, []);

  // ---- Pages column state (spec Phase 7 — Appendix H §H.1 left sidebar) ------
  const [editingPageId, setEditingPageId] = useState<string | null>(null);

  // Persist the collapsed set whenever it changes.
  const updateCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    saveCollapsed(document.id, next);
  };

  // Build a tree: top-level shapes (parentId null) first, with children
  // indented under their parent. Render top-to-bottom = highest z-index first.
  const shapes = document.shapes ?? [];

  // Phase 7 §H.1 Assets tab — index every reusable Component node in the
  // active page's .pen tree. Memoized against the tree so tab switches and
  // unrelated re-renders don't re-walk. The map is keyed by component id;
  // entries are the live PenChild nodes (so card previews read the same
  // fills array the renderer reads).
  const componentsMap = useMemo(
    () => collectComponents(document.children ?? []),
    [document.children],
  );
  const componentEntries = useMemo(
    () => Array.from(componentsMap.entries()),
    [componentsMap],
  );

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
  const isContainer = (s: Shape) =>
    s.type === 'frame' || s.type === 'group' ||
    s.type === 'section' || s.type === 'component' ||
    s.type === 'component_set' || s.type === 'boolean_operation';

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

  // ---- Assets tab drag-to-canvas (spec Phase 7 §H.1) ------------------------
  // HTML5 DnD: the card sets a custom MIME payload carrying the component id;
  // Canvas.tsx's onDrop reads it (via readComponentIdFromDrop) and builds a
  // `place_instance` patch — the same op the agent uses. We also stash a
  // text/plain copy so external drop targets (the chat panel, third-party
  // apps) get a sensible fallback. effectAllowed='copy' tells the browser
  // this is a copy gesture, not a move (the component isn't consumed).
  const onAssetDragStart = (e: React.DragEvent, componentId: string, name: string) => {
    e.dataTransfer.setData(COMPONENT_DRAG_MIME, componentId);
    e.dataTransfer.setData('text/plain', `${name} (#${componentId})`);
    e.dataTransfer.effectAllowed = 'copy';
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
              selected ? 'bg-[var(--ac-accent-soft)] ac-text-1' : 'hover:ac-surface-1 ac-text-2'
            }${dragOverId === shape.id ? ' ring-2 ring-[var(--ac-accent)]' : ''}`}
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
              if (isComponentMaster) all.push({ label: 'Master', node: <span className="text-[9px] px-1 py-0 rounded ac-status-info font-medium">M</span> });
              if (isComponentInstance) all.push({ label: 'Instance (ref)', node: <span className="text-[9px] px-1 py-0 rounded ac-status-warning font-medium">◆</span> });
              if (hasAutoLayout) all.push({ label: 'Auto Layout', node: <span className="text-[9px] px-1 py-0 rounded ac-status-success font-medium">AL</span> });
              if (themeStr) all.push({ label: `modes: ${themeStr}`, node: <span className="text-[9px] px-1 py-0 rounded ac-surface-2 ac-text-3 font-medium">{themeStr}</span> });
              if (hasTokenBinding) all.push({ label: 'Bound to variable', node: <span className="w-1.5 h-1.5 rounded-full ac-dot-info" /> });
              // Constraints badge (small "C" pill) — surfaces that the node has
              // Figma-style layout constraints set.
              if (shape.constraints) {
                all.push({
                  label: `constraints: ${shape.constraints.horizontal}/${shape.constraints.vertical}`,
                  node: <span className="text-[9px] px-1 py-0 rounded ac-status-warning font-medium">C</span>,
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
          {/* Phase 7: Lock/Hide rebound to Figma chords ⌘⇧L / ⌘⇧H (legacy
              ⌘L / ⌘; kept as registry aliases — Appendix H §H.3 #3). */}
          <ContextMenuItem onClick={() => sendPatch({ op: 'update', shapeId: shape.id, shape: { locked: !shape.locked }, summary: `${shape.locked ? 'Unlocked' : 'Locked'} ${shape.name}` })}>
            <Lock className="h-3.5 w-3.5 mr-2" /> {shape.locked ? 'Unlock' : 'Lock'} <span className="ml-auto text-[10px] ac-text-4">⌘⇧L</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => sendPatch({ op: 'update', shapeId: shape.id, shape: { visible: !shape.visible }, summary: `${shape.visible ? 'Hid' : 'Showed'} ${shape.name}` })}>
            <Eye className="h-3.5 w-3.5 mr-2" /> {shape.visible ? 'Hide' : 'Show'} <span className="ml-auto text-[10px] ac-text-4">⌘⇧H</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* ── Group 5: Components ──────────────────────────────────── */}
          {/* Phase 2 component-system: use the new convert_to_component op
              (proper PenComponent node, reusable=true) for frames/groups.
              Legacy "mark as component master" was a stub that just set
              componentId — keep it only for non-frame/group shapes. */}
          {(shape.type === 'frame' || shape.type === 'group') && (
            <ContextMenuItem onClick={() => sendPatch({ op: 'convert_to_component', shapeId: shape.id, summary: `Promoted ${shape.name} to reusable Component` })}>
              <ComponentIcon className="h-3.5 w-3.5 mr-2" /> Create component <span className="ml-auto text-[10px] ac-text-4">⌥⌘K</span>
            </ContextMenuItem>
          )}
          {shape.type !== 'frame' && shape.type !== 'group' && (
            <ContextMenuItem onClick={() => sendPatch({ op: 'update', shapeId: shape.id, shape: { componentId: shape.id } as Partial<Shape>, summary: `Marked ${shape.name} as component master` })}>
              <ComponentIcon className="h-3.5 w-3.5 mr-2" /> Mark as component master
            </ContextMenuItem>
          )}
          {/* Instance-specific actions (only when shape is a component instance) */}
          {isComponentInstance && (
            <>
              <ContextMenuItem onClick={() => sendPatch({ op: 'detach_instance', shapeId: shape.id, summary: `Detached instance ${shape.name}` })}>
                <Unlink className="h-3.5 w-3.5 mr-2" /> Detach instance
              </ContextMenuItem>
              <ContextMenuItem onClick={() => sendPatch({ op: 'reset_instance', shapeId: shape.id, summary: `Reset overrides on ${shape.name}` })}>
                <RotateCcw className="h-3.5 w-3.5 mr-2" /> Reset overrides
              </ContextMenuItem>
            </>
          )}
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
              <ContextMenuItem onClick={async () => {
                const code = exportCode(shapes, 'html', { frameId: isContainerNode ? shape.id : undefined });
                if (!code) { toast.error('Nothing to copy'); return; }
                const ok = await copyToClipboard(code);
                if (ok) toast.success('Copied HTML', { description: `${shape.name}` });
                else toast.error('Copy failed');
              }}>HTML</ContextMenuItem>
              <ContextMenuItem onClick={async () => {
                const code = exportCode(shapes, 'react', { frameId: isContainerNode ? shape.id : undefined });
                if (!code) { toast.error('Nothing to copy'); return; }
                const ok = await copyToClipboard(code);
                if (ok) toast.success('Copied React', { description: `${shape.name}` });
                else toast.error('Copy failed');
              }}>React</ContextMenuItem>
              <ContextMenuItem onClick={async () => {
                const code = exportCode(shapes, 'tailwind', { frameId: isContainerNode ? shape.id : undefined });
                if (!code) { toast.error('Nothing to copy'); return; }
                const ok = await copyToClipboard(code);
                if (ok) toast.success('Copied Tailwind', { description: `${shape.name}` });
                else toast.error('Copy failed');
              }}>Tailwind</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={async () => {
                const svg = exportSvg(shapes, { frameId: isContainerNode ? shape.id : undefined });
                if (!svg) { toast.error('Nothing to copy'); return; }
                const ok = await copyToClipboard(svg);
                if (ok) toast.success('Copied SVG', { description: `${shape.name}` });
                else toast.error('Copy failed');
              }}>SVG</ContextMenuItem>
              <ContextMenuItem onClick={async () => {
                const json = exportJson(shape);
                const ok = await copyToClipboard(json);
                if (ok) toast.success('Copied JSON', { description: `${shape.name}` });
                else toast.error('Copy failed');
              }}>JSON (this layer)</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FileDown className="h-3.5 w-3.5 mr-2" /> Export
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={async () => {
                // Phase 5 §5.4: DOM-capture path captures the frame's DOM
                // subtree via html-to-image (located by [data-node-id]).
                // Falls back to SVG projection when no DOM world is mounted.
                const dataUrl = await exportPngDataUrl(shapes, {
                  frameId: isContainerNode ? shape.id : undefined,
                  worldElement: useCanvasStore.getState().worldElement,
                  backgroundColor: document.background,
                });
                if (!dataUrl) { toast.error('Nothing to export'); return; }
                const safeName = shape.name.replace(/[^a-z0-9-_]+/gi, '-');
                if (dataUrl.startsWith('data:image/png')) {
                  downloadDataUrl(dataUrl, `${safeName}.png`);
                  toast.success('Exported PNG', { description: `${shape.name} @2x` });
                } else {
                  downloadFile(dataUrl, `${safeName}.svg`, 'image/svg+xml');
                  toast.success('Exported SVG instead', { description: 'PNG rasterization was blocked; exported SVG.' });
                }
              }}>PNG</ContextMenuItem>
              <ContextMenuItem onClick={() => {
                const svg = exportSvg(shapes, { frameId: isContainerNode ? shape.id : undefined });
                if (!svg) { toast.error('Nothing to export'); return; }
                const name = shape.name.replace(/[^a-z0-9-_]+/gi, '-');
                downloadFile(svg, `${name}.svg`, 'image/svg+xml');
                toast.success('Exported SVG', { description: `${shape.name}` });
              }}>SVG</ContextMenuItem>
              <ContextMenuItem onClick={() => {
                const json = exportJson(document);
                const name = (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-');
                downloadFile(json, `${name}.pen`, 'application/json');
                toast.success('Exported .pen', { description: `${shapes.length} nodes` });
              }}>.pen (full canvas)</ContextMenuItem>
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
            <Edit2 className="h-3.5 w-3.5 mr-2" /> Rename <span className="ml-auto text-[10px] ac-text-4">⌘R</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => sendPatch({ op: 'duplicate', shapeIds: [shape.id], summary: `Duplicated ${shape.name}` })}>
            <Copy className="h-3.5 w-3.5 mr-2" /> Duplicate
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              sendPatch({ op: 'remove', shapeIds: [shape.id], summary: `Deleted ${shape.name}` });
              if (selectedIds.includes(shape.id)) select(selectedIds.filter((id) => id !== shape.id));
            }}
            className="ac-text-danger"
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
  // UI-audit 2026-08-29: variableCount / themeAxisCount were only consumed by
  // the removed summary footer — counts remain visible in the Properties
  // panel's empty state where the variables themselves are listed.
  const pages = document.pages ?? [];

  return (
    <div className="flex h-full ac-surface-0 ac-hide-scrollbar" data-ac-layers-panel>
      {/* ---- Pages column (spec Phase 7 — Appendix H §H.1) --------------------
          Left-edge vertical strip, rendered only when the document carries a
          pages array. Chip = click activates (set_active_page patch),
          double-click renames inline, + adds a page (add_page patch), and the
          chip context menu duplicates / deletes. NOTE (v1): duplicate creates
          a same-named EMPTY page — copying a page's layer tree needs a
          page-children patch op that doesn't exist yet. */}
      {pages.length > 0 && (
        <div className="w-24 flex-shrink-0 border-r ac-border-subtle flex flex-col" data-ac-pages-column>
          <div className="px-2 py-2 border-b ac-border-subtle text-[9px] font-semibold uppercase tracking-wide ac-text-4">
            Pages
          </div>
          <div className="flex-1 overflow-y-auto py-1 ac-hide-scrollbar">
            {pages.map((page, idx) => (
              <ContextMenu key={page.id}>
                <ContextMenuTrigger asChild>
                  <div
                    data-ac-page={page.id}
                    className={`mx-1 mb-0.5 px-1.5 py-1 rounded text-[10px] cursor-pointer ac-transition flex items-center gap-1 ${
                      idx === (document.activePageIndex ?? 0)
                        ? 'bg-[var(--ac-accent-soft)] ac-text-1 font-medium'
                        : 'ac-text-3 hover:ac-surface-1'
                    }`}
                    title={`${page.name} (${page.children?.length ?? 0} nodes)`}
                    onClick={() =>
                      sendPatch({ op: 'set_active_page', pageId: page.id, summary: `Switched to page "${page.name}"` })
                    }
                    onDoubleClick={() => setEditingPageId(page.id)}
                  >
                    <Files className="h-3 w-3 flex-shrink-0 ac-text-4" />
                    {editingPageId === page.id ? (
                      <Input
                        autoFocus
                        defaultValue={page.name}
                        className="h-4 text-[10px] px-1 py-0 flex-1 min-w-0"
                        onBlur={(e) => {
                          const name = e.target.value.trim() || page.name;
                          sendPatch({ op: 'rename_page', pageId: page.id, pageName: name, summary: `Renamed page to "${name}"` });
                          setEditingPageId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') setEditingPageId(null);
                        }}
                      />
                    ) : (
                      <span className="truncate">{page.name}</span>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-44">
                  <ContextMenuItem onClick={() => setEditingPageId(page.id)}>
                    <Edit2 className="h-3.5 w-3.5 mr-2" /> Rename page
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() =>
                      sendPatch({ op: 'add_page', pageName: `${page.name} copy`, summary: `Duplicated page "${page.name}" (empty v1)` })
                    }
                  >
                    <Copy className="h-3.5 w-3.5 mr-2" /> Duplicate page <span className="ml-auto text-[9px] ac-text-4">empty</span>
                  </ContextMenuItem>
                  {pages.length > 1 && (
                    <ContextMenuItem
                      className="ac-text-danger"
                      onClick={() => sendPatch({ op: 'delete_page', pageId: page.id, summary: `Deleted page "${page.name}"` })}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete page
                    </ContextMenuItem>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
          <div className="p-1 border-t ac-border-subtle">
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-6 text-[10px] ac-text-3 hover:ac-text-1"
              title="Add a page"
              aria-label="Add page"
              onClick={() => sendPatch({ op: 'add_page', summary: 'Added a page' })}
            >
              <Plus className="h-3 w-3 mr-1" /> Page
            </Button>
          </div>
        </div>
      )}

      {/* ---- Layers column — tabs (Layers tree / Assets grid) -------------------
          Phase 7 §H.1 — the left sidebar's Layers/Assets tabs. Tab state lives
          in the panel (see `activeTab` above) so the cheat-sheet ⌥1/⌥2 chords
          can drive it via the `ac:layers-set-tab` CustomEvent without a store
          round-trip. Radix Tabs unmounts the inactive content so the grid
          never pays for tree reconciliation while the user is on Layers, and
          vice-versa. */}
      <div className="flex flex-col flex-1 min-w-0 ac-hide-scrollbar">
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v === 'assets' ? 'assets' : 'layers')}
          className="flex-1 flex flex-col min-h-0 gap-0"
          data-ac-layers-tabs=""
        >
          {/* UI-audit 2026-08-29: merged-look header — the inner tabs row
              lost its border-b + vertical padding so it reads as part of ONE
              header block with the outer Chats/Layers strip instead of two
              stacked 40px tab bars (~80px → ~52px). */}
          <div className="flex items-center justify-between px-2 pt-1 pb-0.5 gap-1">
            <TabsList className="h-6" data-ac-tabs-list="">
              <TabsTrigger value="layers" data-ac-tab-trigger="layers" className="text-[11px] gap-1 px-2 h-6">
                <Layers className="h-3 w-3" />
                Layers
                <span className="text-[9px] ac-text-4 font-normal">{nodeCount}</span>
              </TabsTrigger>
              <TabsTrigger value="assets" data-ac-tab-trigger="assets" className="text-[11px] gap-1 px-2 h-6">
                <Boxes className="h-3 w-3" />
                Assets
                <span className="text-[9px] ac-text-4 font-normal">{componentEntries.length}</span>
              </TabsTrigger>
            </TabsList>
            {/* Expand-all / Collapse-all buttons in the header — Layers only. */}
            {activeTab === 'layers' && (
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
            )}
          </div>

          <TabsContent value="layers" className="flex-1 flex flex-col min-h-0 outline-none" data-ac-layers-tab="">
            {/* P0-12: Search-by-name input. Filters layers in real time. */}
            <div className="px-2 pt-1 pb-1.5 border-b ac-border-subtle">
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
              {/* The scroll area's inner div is the drop target for "move to
                  root". We attach onDrop here so that dropping into the empty
                  area below the list (or between rows) promotes the dragged
                  node to root. */}
              <div
                className="p-1 min-h-full"
                onDragOver={(e) => {
                  // Allow drop only if the drag wasn't already handled by a
                  // row. We always preventDefault so the drop fires here when
                  // no row caught it.
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  // Only handle if no row consumed the drop first. Rows call
                  // stopPropagation, so this only fires when dropping on
                  // empty area.
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
            {/* UI-audit 2026-08-29: the .pen design-system summary footer
                ("N variables · N theme axes · N pages") was removed — a
                permanent readout of zero-value stats. Variables are browsable
                in the Properties panel's empty state; pages in the pages
                column when present. */}
          </TabsContent>

          <TabsContent value="assets" className="flex-1 min-h-0 outline-none" data-ac-assets-tab="">
            {/* Assets grid — Phase 7 §H.1. Each card is an HTML5-draggable
                component master; dropping on the canvas places an instance
                (PenRef) at the cursor via the `place_instance` patch. */}
            <ScrollArea className="h-full min-h-0 ac-hide-scrollbar">
              {componentEntries.length === 0 ? (
                <div className="px-4 py-10 text-center" data-ac-assets-empty="">
                  <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-md ac-surface-2 ac-text-4">
                    <Package className="h-4 w-4" />
                  </div>
                  <p className="text-[11px] font-medium ac-text-3 mb-1">No components yet</p>
                  <p className="text-[11px] ac-text-4 leading-relaxed">
                    Create a component via the agent (<kbd className="text-[9px] px-1 rounded ac-surface-2">⌥⌘K</kbd>)
                    or the <code className="text-[10px] px-1 rounded ac-surface-2">pen_create_component</code> tool,
                    then drag a card onto the canvas to place an instance.
                  </p>
                </div>
              ) : (
                <div
                  className="p-2 grid grid-cols-2 gap-2"
                  data-ac-assets-grid=""
                >
                  {componentEntries.map(([id, node]) => {
                    const name = (node as { name?: string }).name ?? 'Component';
                    const color = componentThumbnailColor(node);
                    return (
                      <div
                        key={id}
                        data-ac-asset-card=""
                        data-ac-asset-id={id}
                        draggable
                        onDragStart={(e) => onAssetDragStart(e, id, name)}
                        title={`${name} — drag onto the canvas to place an instance`}
                        aria-label={`Component: ${name}`}
                        className="group rounded-md border ac-border-subtle ac-surface-1 hover:ac-surface-2 hover:border-[var(--ac-accent-border)] cursor-grab active:cursor-grabbing ac-transition overflow-hidden flex flex-col"
                      >
                        <div
                          className="aspect-[4/3] w-full flex items-center justify-center"
                          style={{
                            backgroundColor: 'color-mix(in oklch, var(--ac-surface-0) 65%, transparent)',
                            backgroundImage:
                              'radial-gradient(circle, color-mix(in oklch, var(--ac-text-primary) 8%, transparent) 1px, transparent 1px)',
                            backgroundSize: '8px 8px',
                          }}
                        >
                          <div
                            className="h-10 w-10 rounded shadow-sm"
                            style={{ backgroundColor: color }}
                            aria-hidden
                          />
                        </div>
                        <div className="px-1.5 py-1 text-[10px] ac-text-2 truncate flex items-center gap-1">
                          <ComponentIcon className="h-2.5 w-2.5 ac-text-4 flex-shrink-0" />
                          <span className="truncate" data-ac-asset-name={id}>{name}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
