'use client';

// App menu — the single menu button in the app header (UI-audit round 2).
//
// Replaces the classic six-menu menubar (File / Edit / View / Insert / Object
// / Help — 28px of permanent top chrome). Figma (UI3), tldraw and Excalidraw
// all ship NO classic menubar; Figma folds the same content into one
// hamburger-style menu on the nav bar. We do the same: every item the old
// menubar exposed lives here, organized under six section labels inside ONE
// dropdown — plus every action is also reachable via the ⌘K command palette
// (see page.tsx's paletteCommands) and keyboard chords.
//
// Round-2 fixes folded in:
//   - "Toggle dark mode" is wired (was a no-op stub in the old View menu).
//   - Flip horizontal/vertical TOGGLE like ⇧H/⇧V (the old menu wrote
//     `flipX: true` one-way — flip twice did nothing).
//   - Insert shapes go through the shared token-based dropShapeAtCenter
//     (the old copy hardcoded light-slate hexes and rendered wrong colors in
//     dark mode).
//   - ⌘N / ⌘O / ⌘E shortcut hints are honest — page.tsx wires all three.

import { useState } from 'react';
import { useCanvasStore, findShape } from '@/lib/canvas/store';
import { useClipboard } from '@/hooks/use-clipboard';
import type { Shape } from '@/lib/canvas/types';
import { exportSvg, exportPngDataUrl, exportJson, exportCode, downloadFile, downloadDataUrl, copyToClipboard } from '@/lib/canvas/export';
import { exportBackgroundColor } from '@/lib/canvas/theme-colors';
import { dropShapeAtCenter } from '@/lib/canvas/drop-shape';
import { chordFor, SHORTCUTS_BY_ACTION, currentPlatform } from '@/lib/canvas/shortcuts';
import { useSettings } from '@/lib/settings/store';
import { VersionHistoryDialog } from '@/components/canvas/VersionHistoryDialog';
import { Menu as MenuIcon } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubTrigger,
  DropdownMenuSubContent, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';

interface AppMenuProps {
  onOpenSettings?: () => void;
  onOpenCommandPalette?: () => void;
  onToggleZen?: () => void;
  onToggleLeftPanel?: () => void;
  onToggleRightPanel?: () => void;
  onNewChat?: () => void;
  onExportPen?: () => void;
  onImportPen?: () => void;
  onOpenShortcuts?: () => void;
  onOpenDesignSystems?: () => void;
}

export function AppMenu(props: AppMenuProps) {
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const select = useCanvasStore((s) => s.select);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const document = useCanvasStore((s) => s.document);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  // 2026-09-05 consistency contract: the menu's document-mutating verbs
  // (Clear / Undo / Redo) carry the SAME busy gate as the toolbar buttons,
  // ⌘Z and the slash commands — the store guard backstops every handler,
  // the disabled affordance states the rule.
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const pixelGridVisible = useCanvasStore((s) => s.pixelGridVisible);
  const snapToPixel = useCanvasStore((s) => s.snapToPixel);
  const outlineMode = useCanvasStore((s) => s.outlineMode);
  const rulersVisible = useCanvasStore((s) => s.rulersVisible);
  const toggleViewFlag = useCanvasStore((s) => s.toggleViewFlag);
  const clipboard = useClipboard();
  const setSetting = useSettings((s) => s.set);
  const [open, setOpen] = useState(false);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const platform = currentPlatform();
  const chord = (action: string) => {
    const def = SHORTCUTS_BY_ACTION.get(action);
    return def ? chordFor(def, platform) : undefined;
  };

  // Zoom routes through the Canvas shell (viewport state is shell-local).
  const zoomTo = (kind: 'fit' | 'selection' | '100' | 'in' | 'out') =>
    window.dispatchEvent(new CustomEvent('ac:canvas-zoom', { detail: { kind } }));

  // Theme cycling — flips light↔dark based on the CURRENTLY resolved state
  // (system mode counts as whatever it resolved to). NOTE: uses the GLOBAL
  // document — the store's `document` shadows it in this scope.
  const toggleDarkMode = () => {
    const isDark =
      typeof globalThis.document !== 'undefined' &&
      globalThis.document.documentElement.classList.contains('dark');
    setSetting('themePreference', isDark ? 'light' : 'dark');
  };

  const zorder = (kind: 'forward' | 'backward' | 'front' | 'back') => {
    if (selectedIds.length === 0) return;
    sendPatch({ op: 'zorder', shapeIds: selectedIds, zorderKind: kind, summary: `Z-order: ${kind}` });
  };

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
  const frameSelection = () => {
    if (selectedIds.length === 0) return;
    const frameId = `frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sendPatch({ op: 'group', groupId: frameId, shapeIds: selectedIds, summary: `Framed ${selectedIds.length} shape(s)` });
    sendPatch({ op: 'update', shapeId: frameId, shape: { type: 'frame', name: 'Frame' } as Partial<Shape>, summary: 'Frame selection' });
  };

  // Flip — TOGGLES the .pen flag, matching ⇧H/⇧V semantics (the round-1 menu
  // wrote a one-way `true`, so the menu and keyboard chords disagreed).
  const flipSelection = (axis: 'flipX' | 'flipY') => {
    for (const id of selectedIds) {
      const s = findShape(document, id);
      if (!s) continue;
      const current = (s as unknown as Record<string, unknown>)[axis];
      sendPatch({
        op: 'update',
        shapeId: id,
        shape: { [axis]: !current } as Partial<Shape>,
        summary: `${axis === 'flipX' ? 'Flipped horizontally' : 'Flipped vertically'}: ${s.name}`,
      });
    }
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center justify-center h-7 w-7 rounded-md ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring"
            title="Menu"
            aria-label="Open application menu"
            aria-haspopup="menu"
          >
            <MenuIcon className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="text-[11px] min-w-[248px] max-h-[70vh] overflow-y-auto ac-hide-scrollbar">
          {/* ==== File ==== */}
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide ac-text-4">File</DropdownMenuLabel>
          <DropdownMenuItem onClick={props.onNewChat} disabled={agentBusy}>
            New chat <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={props.onImportPen}>
            Open .pen file… <DropdownMenuShortcut>⌘O</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={props.onExportPen}>
            Export as .pen <DropdownMenuShortcut>⌘E</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            const svg = exportSvg(document.shapes);
            if (!svg) { toast.error('Nothing to export', { description: 'Draw something first.' }); return; }
            const name = (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-');
            downloadFile(svg, `${name}.svg`, 'image/svg+xml');
            toast.success('Exported SVG', { description: `${document.shapes.length} shapes` });
          }}>
            Export as SVG
          </DropdownMenuItem>
          <DropdownMenuItem onClick={async () => {
            // Primary path: capture the live DOM-rendered world; fall back to
            // the SVG projection when no DOM world is mounted. Background
            // resolves the theme token so dark-mode exports are dark.
            const worldElement = useCanvasStore.getState().worldElement;
            const dataUrl = await exportPngDataUrl(document.shapes, { worldElement, backgroundColor: exportBackgroundColor(document.background), scale: 2 });
            if (!dataUrl) { toast.error('Nothing to export', { description: 'Draw something first.' }); return; }
            const name = (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-');
            if (dataUrl.startsWith('data:image/png')) {
              downloadDataUrl(dataUrl, `${name}.png`);
              toast.success('Exported PNG', { description: `${document.shapes.length} shapes @2x` });
            } else {
              downloadFile(dataUrl, `${name}.svg`, 'image/svg+xml');
              toast.success('Exported SVG instead', { description: 'PNG rasterization was blocked by a remote image; exported SVG.' });
            }
          }}>
            Export as PNG
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            const json = exportJson(document);
            const name = (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-');
            downloadFile(json, `${name}.json`, 'application/json');
            toast.success('Exported JSON', { description: `${document.shapes.length} shapes` });
          }}>
            Export as JSON
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Copy as code</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {(['html', 'react', 'tailwind'] as const).map((fmt) => (
                <DropdownMenuItem key={fmt} onClick={async () => {
                  const code = exportCode(document.shapes, fmt);
                  if (!code) { toast.error('Nothing to copy'); return; }
                  const ok = await copyToClipboard(code);
                  if (ok) toast.success(`Copied ${fmt === 'react' ? 'React' : fmt}`, { description: `${document.shapes.length} shapes → clipboard` });
                  else toast.error('Copy failed');
                }}>
                  {fmt === 'react' ? 'React (JSX)' : fmt === 'html' ? 'HTML' : 'Tailwind'}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => setVersionHistoryOpen(true)}>
            Version history… <DropdownMenuShortcut>{chord('save-checkpoint')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={props.onOpenSettings}>
            Settings… <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={document.shapes.length === 0 || agentBusy}
            className="ac-text-danger"
            onClick={() => {
              if (agentBusy) return; // store guard backstops
              if (confirm('Clear all shapes from the canvas?')) {
                sendPatch({ op: 'clear', summary: 'Cleared canvas' });
              }
            }}
          >
            Clear canvas…
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          {/* ==== Edit ==== */}
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide ac-text-4">Edit</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => undo()} disabled={agentBusy}>
            Undo <DropdownMenuShortcut>⌘Z</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => redo()} disabled={agentBusy}>
            Redo <DropdownMenuShortcut>⌘⇧Z</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            const sel = selectedIds.map((id) => findShape(document, id)).filter((s): s is Shape => !!s);
            clipboard.cut(sel);
          }}>
            Cut <DropdownMenuShortcut>⌘X</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            const sel = selectedIds.map((id) => findShape(document, id)).filter((s): s is Shape => !!s);
            clipboard.copy(sel);
          }}>
            Copy <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => clipboard.paste()}>
            Paste <DropdownMenuShortcut>⌘V</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => clipboard.paste({ offset: { dx: 0, dy: 0 } })}>
            Paste in place <DropdownMenuShortcut>⌘⇧V</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            if (selectedIds.length > 0) {
              sendPatch({ op: 'duplicate', shapeIds: selectedIds, summary: `Duplicated ${selectedIds.length} shape(s)` });
            }
          }}>
            Duplicate <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => clipboard.selectAll()}>
            Select all <DropdownMenuShortcut>⌘A</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => select([])}>
            Deselect all <DropdownMenuShortcut>⎋</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            if (selectedIds.length > 0) {
              sendPatch({ op: 'remove', shapeIds: selectedIds, summary: `Deleted ${selectedIds.length} shape(s)` });
              select([]);
            }
          }}>
            Delete <DropdownMenuShortcut>⌫</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          {/* ==== View ==== */}
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide ac-text-4">View</DropdownMenuLabel>
          <DropdownMenuItem onClick={props.onToggleLeftPanel}>
            Toggle layers panel <DropdownMenuShortcut>{chord('toggle-left-panel')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={props.onToggleRightPanel}>
            Toggle chat panel <DropdownMenuShortcut>{chord('toggle-right-panel')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={props.onToggleZen}>
            Toggle zen / UI <DropdownMenuShortcut>{chord('zen')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={toggleDarkMode}>
            Toggle dark mode
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => zoomTo('in')}>
            Zoom in <DropdownMenuShortcut>{chord('zoom.in')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => zoomTo('out')}>
            Zoom out <DropdownMenuShortcut>{chord('zoom.out')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => zoomTo('fit')}>
            Zoom to fit <DropdownMenuShortcut>{chord('zoom.fit')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => zoomTo('selection')}>
            Zoom to selection <DropdownMenuShortcut>{chord('zoom.selection')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => zoomTo('100')}>
            100% <DropdownMenuShortcut>{chord('zoom.100')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toggleViewFlag('rulersVisible')}>
            {rulersVisible ? '✓ ' : ''}Rulers
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toggleViewFlag('pixelGridVisible')}>
            {pixelGridVisible ? '✓ ' : ''}Pixel grid <DropdownMenuShortcut>{chord('pixel-grid')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toggleViewFlag('snapToPixel')}>
            {snapToPixel ? '✓ ' : ''}Snap to pixel grid <DropdownMenuShortcut>{chord('snap-to-pixel')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toggleViewFlag('outlineMode')}>
            {outlineMode ? '✓ ' : ''}Outline mode <DropdownMenuShortcut>{chord('outline-mode')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={props.onOpenDesignSystems}>
            Design Systems…
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          {/* ==== Insert ==== */}
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide ac-text-4">Insert</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => dropShapeAtCenter('rectangle')}>
            Rectangle <DropdownMenuShortcut>R</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => dropShapeAtCenter('ellipse')}>
            Ellipse <DropdownMenuShortcut>O</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => dropShapeAtCenter('text')}>
            Text <DropdownMenuShortcut>T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => dropShapeAtCenter('line')}>
            Line <DropdownMenuShortcut>L</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => dropShapeAtCenter('frame')}>
            Frame <DropdownMenuShortcut>F</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => dropShapeAtCenter('section')}>
            Section <DropdownMenuShortcut>⇧S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toast.message('Pen / path tool — use the chat panel')}>
            Path <DropdownMenuShortcut>P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toast.message('Image upload — use the chat panel or drag-and-drop')}>
            Image… <DropdownMenuShortcut>⌘⇧I</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toast.message('Create component — select a frame/group and press ⌥⌘K, or use the Layers right-click')}>
            Component… <DropdownMenuShortcut>{chord('create-component')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          {/* ==== Object ==== */}
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide ac-text-4">Object</DropdownMenuLabel>
          <DropdownMenuItem onClick={groupSel}>
            Group <DropdownMenuShortcut>⌘G</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={ungroupSel}>
            Ungroup <DropdownMenuShortcut>⌘⇧G</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => zorder('forward')}>
            Bring forward <DropdownMenuShortcut>⌘]</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => zorder('front')}>
            Bring to front <DropdownMenuShortcut>⌘⇧]</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => zorder('backward')}>
            Send backward <DropdownMenuShortcut>⌘[</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => zorder('back')}>
            Send to back <DropdownMenuShortcut>⌘⇧[</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={frameSelection}>
            Frame selection <DropdownMenuShortcut>{chord('frame-selection')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={selectedIds.length === 0}
            onClick={() => flipSelection('flipX')}
          >
            Flip horizontal <DropdownMenuShortcut>⇧H</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={selectedIds.length === 0}
            onClick={() => flipSelection('flipY')}
          >
            Flip vertical <DropdownMenuShortcut>⇧V</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Align</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'LEFT', summary: 'Align left' })}>Align left <DropdownMenuShortcut>{chord('align.left')}</DropdownMenuShortcut></DropdownMenuItem>
              <DropdownMenuItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'HCENTER', summary: 'Align horizontal centers' })}>Align horizontal centers <DropdownMenuShortcut>{chord('align.hcenter')}</DropdownMenuShortcut></DropdownMenuItem>
              <DropdownMenuItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'RIGHT', summary: 'Align right' })}>Align right <DropdownMenuShortcut>{chord('align.right')}</DropdownMenuShortcut></DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'TOP', summary: 'Align top' })}>Align top <DropdownMenuShortcut>{chord('align.top')}</DropdownMenuShortcut></DropdownMenuItem>
              <DropdownMenuItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'VCENTER', summary: 'Align vertical centers' })}>Align vertical centers <DropdownMenuShortcut>{chord('align.vcenter')}</DropdownMenuShortcut></DropdownMenuItem>
              <DropdownMenuItem onClick={() => selectedIds.length >= 2 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'BOTTOM', summary: 'Align bottom' })}>Align bottom <DropdownMenuShortcut>{chord('align.bottom')}</DropdownMenuShortcut></DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Distribute</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => selectedIds.length >= 3 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'DISTRIBUTE_H', summary: 'Distribute horizontally' })}>Horizontally</DropdownMenuItem>
              <DropdownMenuItem onClick={() => selectedIds.length >= 3 && sendPatch({ op: 'align', shapeIds: selectedIds, alignKind: 'DISTRIBUTE_V', summary: 'Distribute vertically' })}>Vertically</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => {
            if (selectedIds.length === 1) {
              const s = findShape(document, selectedIds[0]);
              if (s) sendPatch({ op: 'update', shapeId: s.id, shape: { locked: !s.locked }, summary: `${s.locked ? 'Unlocked' : 'Locked'} ${s.name}` });
            }
          }}>
            Lock <DropdownMenuShortcut>{chord('lock')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            if (selectedIds.length === 1) {
              const s = findShape(document, selectedIds[0]);
              if (s) sendPatch({ op: 'update', shapeId: s.id, shape: { visible: !s.visible }, summary: `${s.visible ? 'Hid' : 'Showed'} ${s.name}` });
            }
          }}>
            Hide <DropdownMenuShortcut>{chord('hide')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          {/* ==== Help ==== */}
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide ac-text-4">Help</DropdownMenuLabel>
          <DropdownMenuItem onClick={props.onOpenShortcuts}>
            Keyboard shortcuts <DropdownMenuShortcut>⌘/</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={props.onOpenCommandPalette}>
            Command palette <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => window.open('https://pen.dev', '_blank')}>
            View .pen spec
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => window.open('https://github.com/kanishka-namdeo/AgentCanvas', '_blank')}>
            View source on GitHub
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => window.open('https://github.com/kanishka-namdeo/AgentCanvas/issues', '_blank')}>
            Report an issue
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toast.message('AgentCanvas · Figma for AI agents · MIT')}>
            About AgentCanvas
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Version history (File → "Version history…") */}
      <VersionHistoryDialog open={versionHistoryOpen} onOpenChange={setVersionHistoryOpen} />
    </>
  );
}
