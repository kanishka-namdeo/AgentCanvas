'use client';

// Top-level menu bar — wraps the already-installed shadcn menubar primitive.
//
// Renders six menus: File, Edit, View, Insert, Object, Help. Each dropdown
// lists the operations with keyboard-shortcut hints shown via the
// <MenubarShortcut> component. Items dispatch to the canvas store actions
// (sendPatch, select, undo/redo), the useClipboard hook, or to the relevant
// panel state setters.
//
// Implementation notes:
//   - The bar lives above the existing header (32px vertical).
//   - Below 1024px viewport width, the bar collapses into a hamburger button
//     that opens a dropdown — handled by a CSS media query on the parent.
//   - When Zen mode is active, the bar is hidden (the parent already hides
//     it via conditional rendering).
//   - All shortcuts shown as hints are wired in src/app/page.tsx's keydown
//     handler.

import { useState, type ReactNode } from 'react';
import { useCanvasStore, findShape } from '@/lib/canvas/store';
import { useClipboard } from '@/hooks/use-clipboard';
import type { CanvasPatch, Shape } from '@/lib/canvas/types';
import { exportSvg, exportPngDataUrl, exportJson, exportCode, downloadFile, downloadDataUrl, copyToClipboard } from '@/lib/canvas/export';
import {
  Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem,
  MenubarSeparator, MenubarShortcut, MenubarSub, MenubarSubTrigger,
  MenubarSubContent, MenubarLabel,
} from '@/components/ui/menubar';
import { toast } from 'sonner';

interface TopMenuBarProps {
  onOpenSettings?: () => void;
  onOpenCommandPalette?: () => void;
  onToggleZen?: () => void;
  onToggleTheme?: () => void;
  onToggleLeftPanel?: () => void;
  onToggleRightPanel?: () => void;
  onNewChat?: () => void;
  onExportPen?: () => void;
  onImportPen?: () => void;
  onOpenShortcuts?: () => void;
}

export function TopMenuBar(props: TopMenuBarProps) {
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const select = useCanvasStore((s) => s.select);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const document = useCanvasStore((s) => s.document);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const setToolMode = useCanvasStore((s) => s.setToolMode);
  const connected = useCanvasStore((s) => s.connected);
  const viewerCount = useCanvasStore((s) => s.viewerCount);
  const clipboard = useClipboard();

  // Helper to drop a shape at viewport center (mirrors page.tsx logic).
  const dropShape = (type: Shape['type'], w: number, h: number) => {
    const vp = document.viewport;
    const cx = (-vp.panX + (typeof window !== 'undefined' ? window.innerWidth / 2 : 600)) / vp.zoom;
    const cy = (-vp.panY + (typeof window !== 'undefined' ? window.innerHeight / 2 : 400)) / vp.zoom;
    const newId = `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const patch: CanvasPatch = {
      op: 'add',
      shape: {
        id: newId, type,
        name: type.charAt(0).toUpperCase() + type.slice(1),
        x: cx - w / 2, y: cy - h / 2,
        width: w, height: h,
        fill: type === 'line' ? '#0f172a' : '#e2e8f0',
        stroke: '#0f172a',
        strokeWidth: type === 'line' ? 2 : 0,
        text: type === 'text' ? 'Text' : undefined,
        fontSize: 16, textColor: '#0f172a', radius: 0,
      },
      summary: `Added ${type}`,
    };
    sendPatch(patch);
    select([newId]);
  };

  // Helper to emit a z-order patch against the current selection.
  const zorder = (kind: 'forward' | 'backward' | 'front' | 'back') => {
    if (selectedIds.length === 0) return;
    sendPatch({ op: 'zorder', shapeIds: selectedIds, zorderKind: kind, summary: `Z-order: ${kind}` });
  };

  // Helper to group / ungroup the current selection.
  const groupSel = () => {
    if (selectedIds.length >= 2) {
      sendPatch({ op: 'group', shapeIds: selectedIds, summary: `Grouped ${selectedIds.length} shape(s)` });
    }
  };
  const ungroupSel = () => {
    const groups = document.shapes.filter((s) => s.type === 'group' && selectedIds.includes(s.id));
    if (groups.length > 0) {
      sendPatch({ op: 'ungroup', shapeIds: groups.map((g) => g.id), summary: `Ungrouped ${groups.length} group(s)` });
    }
  };

  return (
    <div className="flex items-center h-7 px-2 border-b ac-border-subtle ac-surface-0 text-[11px] flex-shrink-0">
      <Menubar className="h-7 border-0 bg-transparent">
        {/* === File === */}
        <MenubarMenu>
          <MenubarTrigger className="h-7 px-2 text-[11px] ac-text-2 hover:ac-surface-1 ac-transition cursor-default rounded-sm">
            File
          </MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={props.onNewChat}>
              New chat <MenubarShortcut>⌘N</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={props.onImportPen}>
              Open .pen file… <MenubarShortcut>⌘O</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={props.onImportPen}>
              Import .pen file…
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={props.onExportPen}>
              Export as .pen <MenubarShortcut>⌘E</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => {
              const svg = exportSvg(document.shapes);
              if (!svg) { toast.error('Nothing to export', { description: 'Draw something first.' }); return; }
              const name = (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-');
              downloadFile(svg, `${name}.svg`, 'image/svg+xml');
              toast.success('Exported SVG', { description: `${document.shapes.length} shapes` });
            }}>
              Export as SVG
            </MenubarItem>
            <MenubarItem onClick={async () => {
              // Rasterizes via offscreen canvas (2x) — produces a REAL .png
              // download. Previously this opened an SVG data URL in a tab and
              // claimed it was a PNG export.
              const dataUrl = await exportPngDataUrl(document.shapes);
              if (!dataUrl) { toast.error('Nothing to export', { description: 'Draw something first.' }); return; }
              const name = (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-');
              if (dataUrl.startsWith('data:image/png')) {
                downloadDataUrl(dataUrl, `${name}.png`);
                toast.success('Exported PNG', { description: `${document.shapes.length} shapes @2x` });
              } else {
                // Rasterization fallback (e.g. remote image tainted the canvas)
                // — deliver the SVG instead, honestly labeled.
                downloadFile(dataUrl, `${name}.svg`, 'image/svg+xml');
                toast.success('Exported SVG instead', { description: 'PNG rasterization was blocked by a remote image; exported SVG.' });
              }
            }}>
              Export as PNG
            </MenubarItem>
            <MenubarItem onClick={() => {
              const json = exportJson(document);
              const name = (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-');
              downloadFile(json, `${name}.json`, 'application/json');
              toast.success('Exported JSON', { description: `${document.shapes.length} shapes` });
            }}>
              Export as JSON
            </MenubarItem>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger>Copy as code</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarItem onClick={async () => {
                  const code = exportCode(document.shapes, 'html');
                  if (!code) { toast.error('Nothing to copy'); return; }
                  const ok = await copyToClipboard(code);
                  if (ok) toast.success('Copied HTML', { description: `${document.shapes.length} shapes → clipboard` });
                  else toast.error('Copy failed');
                }}>HTML</MenubarItem>
                <MenubarItem onClick={async () => {
                  const code = exportCode(document.shapes, 'react');
                  if (!code) { toast.error('Nothing to copy'); return; }
                  const ok = await copyToClipboard(code);
                  if (ok) toast.success('Copied React', { description: `${document.shapes.length} shapes → clipboard` });
                  else toast.error('Copy failed');
                }}>React (JSX)</MenubarItem>
                <MenubarItem onClick={async () => {
                  const code = exportCode(document.shapes, 'tailwind');
                  if (!code) { toast.error('Nothing to copy'); return; }
                  const ok = await copyToClipboard(code);
                  if (ok) toast.success('Copied Tailwind', { description: `${document.shapes.length} shapes → clipboard` });
                  else toast.error('Copy failed');
                }}>Tailwind</MenubarItem>
              </MenubarSubContent>
            </MenubarSub>
            <MenubarSeparator />
            <MenubarItem onClick={props.onOpenSettings}>
              Settings… <MenubarShortcut>⌘,</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* === Edit === */}
        <MenubarMenu>
          <MenubarTrigger className="h-7 px-2 text-[11px] ac-text-2 hover:ac-surface-1 ac-transition cursor-default rounded-sm">
            Edit
          </MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={() => undo()}>
              Undo <MenubarShortcut>⌘Z</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => redo()}>
              Redo <MenubarShortcut>⌘⇧Z</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => {
              const sel = selectedIds.map((id) => findShape(document, id)).filter((s): s is Shape => !!s);
              clipboard.cut(sel);
            }}>
              Cut <MenubarShortcut>⌘X</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => {
              const sel = selectedIds.map((id) => findShape(document, id)).filter((s): s is Shape => !!s);
              clipboard.copy(sel);
            }}>
              Copy <MenubarShortcut>⌘C</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => clipboard.paste()}>
              Paste <MenubarShortcut>⌘V</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => clipboard.paste({ offset: { dx: 0, dy: 0 } })}>
              Paste in place <MenubarShortcut>⌘⇧V</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => {
              if (selectedIds.length > 0) {
                sendPatch({ op: 'duplicate', shapeIds: selectedIds, summary: `Duplicated ${selectedIds.length} shape(s)` });
              }
            }}>
              Duplicate <MenubarShortcut>⌘D</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => clipboard.selectAll()}>
              Select all <MenubarShortcut>⌘A</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => select([])}>
              Deselect all <MenubarShortcut>⎋</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => {
              if (selectedIds.length > 0) {
                sendPatch({ op: 'remove', shapeIds: selectedIds, summary: `Deleted ${selectedIds.length} shape(s)` });
                select([]);
              }
            }}>
              Delete <MenubarShortcut>⌫</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* === View === */}
        <MenubarMenu>
          <MenubarTrigger className="h-7 px-2 text-[11px] ac-text-2 hover:ac-surface-1 ac-transition cursor-default rounded-sm">
            View
          </MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={props.onToggleLeftPanel}>
              Toggle layers panel <MenubarShortcut>⌘⇧1</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={props.onToggleRightPanel}>
              Toggle chat panel <MenubarShortcut>⌘⇧2</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={props.onToggleZen}>
              Toggle zen / UI <MenubarShortcut>⌘\</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={props.onToggleTheme}>
              Toggle dark mode <MenubarShortcut>⌘⇧L</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => toast.message('Show grid — toggle not yet wired')}>
              Show grid
            </MenubarItem>
            <MenubarItem onClick={() => toast.message('Snap to grid — toggle not yet wired')}>
              Snap to grid
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* === Insert === */}
        <MenubarMenu>
          <MenubarTrigger className="h-7 px-2 text-[11px] ac-text-2 hover:ac-surface-1 ac-transition cursor-default rounded-sm">
            Insert
          </MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={() => dropShape('rectangle', 100, 100)}>
              Rectangle <MenubarShortcut>R</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => dropShape('ellipse', 100, 100)}>
              Ellipse <MenubarShortcut>O</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => dropShape('text', 200, 24)}>
              Text <MenubarShortcut>T</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => dropShape('line', 100, 0)}>
              Line <MenubarShortcut>L</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => dropShape('frame', 200, 200)}>
              Frame <MenubarShortcut>F</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => toast.message('Pen / path tool — use the chat panel')}>
              Path <MenubarShortcut>P</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => toast.message('Image upload — use the chat panel or drag-and-drop')}>
              Image… <MenubarShortcut>⌘⇧I</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => toast.message('Create component — use the chat panel or Layers right-click')}>
              Component… <MenubarShortcut>⌘⇧C</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* === Object === */}
        <MenubarMenu>
          <MenubarTrigger className="h-7 px-2 text-[11px] ac-text-2 hover:ac-surface-1 ac-transition cursor-default rounded-sm">
            Object
          </MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={groupSel}>
              Group <MenubarShortcut>⌘G</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={ungroupSel}>
              Ungroup <MenubarShortcut>⌘⇧G</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => zorder('forward')}>
              Bring forward <MenubarShortcut>⌘]</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => zorder('front')}>
              Bring to front <MenubarShortcut>⌘⇧]</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => zorder('backward')}>
              Send backward <MenubarShortcut>⌘[</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => zorder('back')}>
              Send to back <MenubarShortcut>⌘⇧[</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger>Align</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'left', summary: 'Align left' })}>Left</MenubarItem>
                <MenubarItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'center_h', summary: 'Align center H' })}>Center horizontally</MenubarItem>
                <MenubarItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'right', summary: 'Align right' })}>Right</MenubarItem>
                <MenubarSeparator />
                <MenubarItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'top', summary: 'Align top' })}>Top</MenubarItem>
                <MenubarItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'center_v', summary: 'Align center V' })}>Center vertically</MenubarItem>
                <MenubarItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'bottom', summary: 'Align bottom' })}>Bottom</MenubarItem>
              </MenubarSubContent>
            </MenubarSub>
            <MenubarSub>
              <MenubarSubTrigger>Distribute</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarItem onClick={() => selectedIds.length >= 3 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'distribute_h', summary: 'Distribute horizontally' })}>Horizontally</MenubarItem>
                <MenubarItem onClick={() => selectedIds.length >= 3 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'distribute_v', summary: 'Distribute vertically' })}>Vertically</MenubarItem>
              </MenubarSubContent>
            </MenubarSub>
            <MenubarSeparator />
            <MenubarItem onClick={() => {
              if (selectedIds.length === 1) {
                const s = findShape(document, selectedIds[0]);
                if (s) sendPatch({ op: 'update', shapeId: s.id, shape: { locked: !s.locked }, summary: `${s.locked ? 'Unlocked' : 'Locked'} ${s.name}` });
              }
            }}>
              Lock <MenubarShortcut>⌘L</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => {
              if (selectedIds.length === 1) {
                const s = findShape(document, selectedIds[0]);
                if (s) sendPatch({ op: 'update', shapeId: s.id, shape: { visible: !s.visible }, summary: `${s.visible ? 'Hid' : 'Showed'} ${s.name}` });
              }
            }}>
              Hide <MenubarShortcut>⌘;</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => toast.message('Reparent to… — use the Layers panel drag-and-drop or right-click')}>
              Reparent to…
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* === Help === */}
        <MenubarMenu>
          <MenubarTrigger className="h-7 px-2 text-[11px] ac-text-2 hover:ac-surface-1 ac-transition cursor-default rounded-sm">
            Help
          </MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={props.onOpenShortcuts}>
              Keyboard shortcuts <MenubarShortcut>⌘/</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => window.open('https://pen.dev', '_blank')}>
              View .pen spec
            </MenubarItem>
            <MenubarItem onClick={() => window.open('https://github.com/kanishka-namdeo/AgentCanvas', '_blank')}>
              View source on GitHub
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => window.open('https://github.com/kanishka-namdeo/AgentCanvas/issues', '_blank')}>
              Report an issue
            </MenubarItem>
            <MenubarItem onClick={() => toast.message('AgentCanvas · Figma for AI agents · MIT')}>
              About AgentCanvas
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      {/* Connection + viewer indicators — always visible (right-aligned). */}
      <div className="ml-auto flex items-center gap-2 pr-1">
        {viewerCount > 1 && (
          <span
            className="flex items-center gap-1 text-[10px] ac-text-3"
            title={`${viewerCount} viewers on this canvas`}
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            {viewerCount}
          </span>
        )}
        <span
          className={`flex items-center gap-1 text-[10px] ${connected ? 'ac-text-3' : 'ac-text-danger'}`}
          title={connected ? 'Connected — changes sync live to all viewers' : 'Offline — changes are local only'}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'ac-dot-success' : 'ac-dot-danger'}`} />
          {connected ? 'connected' : 'offline'}
        </span>
      </div>
    </div>
  );
}
