'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { useDefaultLayout, type PanelImperativeHandle, type LayoutStorage } from 'react-resizable-panels';
import { Canvas } from '@/components/canvas/Canvas';
import { Toolbar } from '@/components/canvas/Toolbar';
import { TopMenuBar } from '@/components/canvas/TopMenuBar';
import { LayersPanel } from '@/components/canvas/LayersPanel';
import { PropertiesPanel } from '@/components/canvas/PropertiesPanel';
import { AgentPanel } from '@/components/canvas/AgentPanel';
import { CommandPalette } from '@/components/canvas/CommandPalette';
import { KeyboardShortcutsDialog } from '@/components/canvas/KeyboardShortcutsDialog';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useSettings } from '@/lib/settings/store';
import { useCanvasStore, findShape } from '@/lib/canvas/store';
import { useClipboard } from '@/hooks/use-clipboard';
import type { CanvasPatch, Shape } from '@/lib/canvas/types';
import { SessionSidebar } from '@/components/sessions/SessionSidebar';
import { SessionHeader } from '@/components/sessions/SessionHeader';
import { RunHistoryPanel } from '@/components/sessions/RunHistoryPanel';
import { RunStopButton } from '@/components/sessions/RunStopButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { PenFileMenu } from '@/components/canvas/PenFileMenu';
import {
  PenTool, Bot, PanelLeft, PanelRight, PanelLeftClose, PanelRightClose,
  Maximize2, Minimize2, MessageSquare, Sliders, History as HistoryIcon,
  Layers as LayersIcon, Search, Settings,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';

type RightTab = 'chat' | 'design' | 'history';
type LeftTab = 'chats' | 'layers';

export default function Home() {
  const documentId = 'demo';
  const init = useCanvasStore((s) => s.init);
  const connected = useCanvasStore((s) => s.connected);
  const viewerCount = useCanvasStore((s) => s.viewerCount);
  const document = useCanvasStore((s) => s.document);
  const setDocumentName = useCanvasStore((s) => s.setDocumentName);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const selectedIds = useCanvasStore((s) => s.selectedIds);

  useEffect(() => {
    const cleanup = init(documentId);
    return cleanup;
  }, [init, documentId]);

  // Imperative panel refs — for collapse/expand + Zen mode.
  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);

  // react-resizable-panels v4 persistence hook — replaces the v3 `autoSaveId`
  // prop on the panel group. Persists layout to localStorage keyed by group id.
  // Note: `useDefaultLayout` defaults to `localStorage` on the server (where
  // it doesn't exist), so we pass a no-op storage during SSR and swap to
  // localStorage after mount.
  const noopStorage = useRef<LayoutStorage>({
    getItem: () => null,
    setItem: () => {},
  }).current;
  const [layoutStorage, setLayoutStorage] = useState<LayoutStorage>(noopStorage);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setLayoutStorage(window.localStorage);
    }
  }, []);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'co-canvas-layout-h',
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  });

  // Track collapsed state for Zen-mode detection + icon flips.
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Active tab in the left column (Chats / Layers).
  const [leftTab, setLeftTab] = useState<LeftTab>('chats');
  // Active tab in the right column (Chat / Design / History).
  const [rightTab, setRightTab] = useState<RightTab>('chat');
  // ⌘K command palette visibility.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Settings dialog visibility.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ⌘/ keyboard shortcuts modal visibility.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Auto-archive idle sessions on app mount, per the user's setting.
  // Also enforce the max-sessions-retained cap. Runs once after hydration.
  const density = useSettings((s) => s.density);

  // Sync collapsed state from the persisted layout on mount.
  // `useDefaultLayout` restores the previous panel sizes from localStorage —
  // but if a panel was collapsed when the user closed the tab, the restore
  // happens silently WITHOUT firing `onResize`. Our `leftCollapsed`/`rightCollapsed`
  // React state defaults to `false`, so it desyncs from the actual DOM state:
  // both the "Toggle left panel" chevron AND the "Show left panel" edge
  // button would render at the same time. This effect queries the imperative
  // `isCollapsed()` API after a tick (post-restore) and corrects the state.
  useEffect(() => {
    const t = setTimeout(() => {
      if (leftPanelRef.current?.isCollapsed?.()) setLeftCollapsed(true);
      if (rightPanelRef.current?.isCollapsed?.()) setRightCollapsed(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Expose a global hook so the Canvas empty-state (or any other component
  // without prop access) can open the command palette. Mirrors the
  // `__focusAgentInput` pattern in AgentPanel.tsx.
  useEffect(() => {
    (window as any).__openCommandPalette = () => setPaletteOpen(true);
    return () => { delete (window as any).__openCommandPalette; };
  }, []);

  // The AgentPanel's model badge (and any other decoupled component) can
  // request the Settings dialog via a CustomEvent — mirrors the
  // `__openCommandPalette` pattern above but event-based so components
  // don't need window globals.
  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener('agentcanvas:open-settings', openSettings);
    return () => window.removeEventListener('agentcanvas:open-settings', openSettings);
  }, []);

  useEffect(() => {
    import('@/lib/sessions').then(({ sweepIdleSessions, enforceSessionCap }) => {
      const settings = useSettings.getState();
      const idleN = sweepIdleSessions(settings.autoArchiveIdleAfter);
      const capN = enforceSessionCap(settings.maxSessionsRetained);
      const total = idleN + capN;
      if (total > 0) {
        const parts: string[] = [];
        if (idleN > 0) parts.push(`${idleN} idle`);
        if (capN > 0) parts.push(`${capN} over cap`);
        toast.success(`Auto-archived ${parts.join(' + ')} session${total === 1 ? '' : 's'}`);
      }
    });
  }, []);

  // When the user starts a run, jump to the Chat tab so they see streaming output.
  useEffect(() => {
    if (agentBusy) setRightTab('chat');
  }, [agentBusy]);

  // When the user selects a node on the canvas, jump to the Design tab so they
  // can immediately edit properties. Skip if the agent is mid-run to avoid
  // yanking the user away from the streaming chat view.
  useEffect(() => {
    if (selectedIds.length > 0 && !agentBusy) setRightTab('design');
  }, [selectedIds, agentBusy]);

  // Zen mode — collapse all peripheral panels for a focused canvas view.
  // Shortcut: ⌘\ (Cmd/Ctrl + Backslash). Toggle again to restore the previous layout.
  const isZenMode = leftCollapsed && rightCollapsed;
  const zenSnapshot = useRef<{
    leftCollapsed: boolean;
    rightCollapsed: boolean;
    leftSize: number;
    rightSize: number;
  } | null>(null);
  const toggleZen = useCallback(() => {
    if (!isZenMode) {
      zenSnapshot.current = {
        leftCollapsed,
        rightCollapsed,
        leftSize: leftPanelRef.current?.getSize()?.asPercentage ?? 18,
        rightSize: rightPanelRef.current?.getSize()?.asPercentage ?? 28,
      };
      leftPanelRef.current?.collapse();
      rightPanelRef.current?.collapse();
      setLeftCollapsed(true);
      setRightCollapsed(true);
    } else {
      const snap = zenSnapshot.current;
      if (snap) {
        if (snap.leftCollapsed) leftPanelRef.current?.collapse();
        else leftPanelRef.current?.expand();
        if (snap.rightCollapsed) rightPanelRef.current?.collapse();
        else rightPanelRef.current?.expand();
        setLeftCollapsed(snap.leftCollapsed);
        setRightCollapsed(snap.rightCollapsed);
        requestAnimationFrame(() => {
          // v4: numeric sizes are pixels; we want percentages, so append "%".
          if (!snap.leftCollapsed) leftPanelRef.current?.resize(`${snap.leftSize}%`);
          if (!snap.rightCollapsed) rightPanelRef.current?.resize(`${snap.rightSize}%`);
        });
      } else {
        leftPanelRef.current?.expand();
        rightPanelRef.current?.expand();
        setLeftCollapsed(false);
        setRightCollapsed(false);
      }
    }
  }, [isZenMode, leftCollapsed, rightCollapsed]);

  // Keyboard shortcuts — full matrix (P0 tier):
  //   ⌘1 left column, ⌘2 right column, ⌘K palette, ⌘, settings, ⌘\ zen,
  //   ⌘Z undo, ⌘⇧Z redo, V select, H pan (existing).
  //   NEW (P0-03): ⌘C copy, ⌘V paste (+24 offset), ⌘⇧V paste in place,
  //                ⌘X cut, ⌘A select all.
  //   NEW (P0-05): ⌘G group, ⌘⇧G ungroup.
  //   NEW (P0-06): ⌘D duplicate.
  //   NEW (P0-07): ⌘] bring forward, ⌘[ send backward, ⌘⇧] bring to front,
  //                ⌘⇧[ send to back.
  //   NEW (P0-08): R rectangle, O ellipse, T text, L line, F frame.
  //                Drops the shape at viewport center + selects it.
  const clipboard = useClipboard();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const state = useCanvasStore.getState();
      const target = e.target as HTMLElement;
      const isEditable = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // --- Meta-required shortcuts ---
      if (meta) {
        // Existing panel-toggle + palette + settings + zen + undo/redo.
        if (e.key === '1') { e.preventDefault(); toggle(leftPanelRef, leftCollapsed, setLeftCollapsed); return; }
        if (e.key === '2') { e.preventDefault(); toggle(rightPanelRef, rightCollapsed, setRightCollapsed); return; }
        // P1-25: ⌘⇧1 / ⌘⇧2 as ALIASES for the panel toggles (legacy users keep ⌘1/⌘2).
        if (e.shiftKey && (e.key === '!' || e.key === '1')) { e.preventDefault(); toggle(leftPanelRef, leftCollapsed, setLeftCollapsed); return; }
        if (e.shiftKey && (e.key === '@' || e.key === '2')) { e.preventDefault(); toggle(rightPanelRef, rightCollapsed, setRightCollapsed); return; }
        if (e.key === 'k' || e.key === 'K') { e.preventDefault(); setPaletteOpen((v) => !v); return; }
        if (e.key === ',') { e.preventDefault(); setSettingsOpen((v) => !v); return; }
        if (e.key === '\\') { e.preventDefault(); toggleZen(); return; }
        // P1-30: ⌘/ opens the keyboard shortcuts cheat sheet.
        if (e.key === '/') { e.preventDefault(); setShortcutsOpen((v) => !v); return; }
        // P2-47: ⌘↑ / ⌘↓ navigate chat messages (scroll the chat panel).
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          if (isEditable) return;
          e.preventDefault();
          // Find the chat scroll area and scroll by one message height (~80px).
          const chatScroll = typeof globalThis.document !== 'undefined' ? globalThis.document.querySelector('.agent-panel-scroll') : null;
          if (chatScroll) {
            (chatScroll as HTMLElement).scrollBy({ top: e.key === 'ArrowUp' ? -80 : 80, behavior: 'smooth' });
          }
          return;
        }
        // Undo/redo — canvas history, NOT text undo:
        //   - never hijack ⌘Z from text inputs (the user means "undo my
        //     typing", native textarea behavior — clipboard shortcuts below
        //     guard the same way; this one was missing).
        //   - never run while the agent is streaming (undoing under the agent
        //     corrupts its working document — the Toolbar buttons are already
        //     disabled in that state; this keyboard path must match).
        if (e.key === 'z' || e.key === 'Z') {
          if (isEditable) return;
          if (state.agentBusy) return;
          e.preventDefault();
          if (e.shiftKey) { state.redo(); } else { state.undo(); }
          return;
        }

        // P0-03: Clipboard.
        if (e.key === 'c' || e.key === 'C') {
          if (isEditable) return; // don't hijack copy-in-input
          e.preventDefault();
          const sel = state.selectedIds.map((id) => findShape(state.document, id)).filter((s): s is Shape => !!s);
          clipboard.copy(sel);
          return;
        }
        if (e.key === 'v' || e.key === 'V') {
          if (isEditable) return;
          e.preventDefault();
          if (e.shiftKey) {
            // ⌘⇧V = paste in place (0 offset)
            clipboard.paste({ offset: { dx: 0, dy: 0 } });
          } else {
            clipboard.paste(); // default +24 offset
          }
          return;
        }
        if (e.key === 'x' || e.key === 'X') {
          if (isEditable) return;
          e.preventDefault();
          const sel = state.selectedIds.map((id) => findShape(state.document, id)).filter((s): s is Shape => !!s);
          clipboard.cut(sel);
          return;
        }
        if (e.key === 'a' || e.key === 'A') {
          if (isEditable) return; // let Cmd+A in input select-all-text
          e.preventDefault();
          clipboard.selectAll();
          return;
        }

        // P0-05: Group / Ungroup. Canvas mutation — no-op while typing in an
        // input (⌘G from a textarea should never regroup the canvas).
        if (e.key === 'g' || e.key === 'G') {
          if (isEditable) return;
          e.preventDefault();
          if (e.shiftKey) {
            // ⌘⇧G = ungroup
            const groups = state.document.shapes.filter((s) => s.type === 'group' && state.selectedIds.includes(s.id));
            if (groups.length > 0) {
              state.sendPatch({
                op: 'ungroup',
                shapeIds: groups.map((g) => g.id),
                summary: `Ungrouped ${groups.length} group(s)`,
              });
            }
          } else {
            // ⌘G = group
            if (state.selectedIds.length >= 2) {
              state.sendPatch({
                op: 'group',
                shapeIds: state.selectedIds,
                summary: `Grouped ${state.selectedIds.length} shape(s)`,
              });
            }
          }
          return;
        }

        // P0-06: Duplicate. Same input guard.
        if (e.key === 'd' || e.key === 'D') {
          if (isEditable) return;
          e.preventDefault();
          if (state.selectedIds.length > 0) {
            state.sendPatch({
              op: 'duplicate',
              shapeIds: state.selectedIds,
              summary: `Duplicated ${state.selectedIds.length} shape(s)`,
            });
          }
          return;
        }

        // P0-07: Z-order (⌘] / [ / ⌘⇧] / [). Same input guard.
        if (e.key === ']' || e.key === '[') {
          if (isEditable) return;
          e.preventDefault();
          if (state.selectedIds.length === 0) return;
          const zorderKind = e.shiftKey
            ? (e.key === ']' ? 'front' : 'back')
            : (e.key === ']' ? 'forward' : 'backward');
          state.sendPatch({
            op: 'zorder',
            shapeIds: state.selectedIds,
            zorderKind,
            summary: `Z-order: ${zorderKind}`,
          });
          return;
        }
        return;
      }

      // --- Non-meta shortcuts — only fire when not typing in an input ---
      if (isEditable) return;

      // Existing tool shortcuts.
      if (e.key === 'v' || e.key === 'V') { state.setToolMode('select'); return; }
      if (e.key === 'h' || e.key === 'H') { state.setToolMode('pan'); return; }

      // P1-24: Nudge shortcuts — arrows move selection by 1px, ⇧+arrows by 10px.
      // Emits an op:'update' patch per selected shape with the new x/y.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (state.selectedIds.length === 0) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const updates = state.selectedIds.map((id) => {
          const s = findShape(state.document, id);
          if (!s) return null;
          // Subtract parent absolute position if nested (same fix as the drag handler).
          let newX = s.x + dx;
          let newY = s.y + dy;
          if (s.parentId) {
            const parent = findShape(state.document, s.parentId);
            if (parent) { newX -= parent.x; newY -= parent.y; }
          }
          return { id, changes: { x: newX, y: newY } };
        }).filter((u): u is { id: string; changes: { x: number; y: number } } => u !== null);
        if (updates.length > 0) {
          state.sendPatch({ op: 'update_many', updates, summary: `Nudged ${updates.length} shape(s) by (${dx}, ${dy})` });
        }
        return;
      }

      // P2-46: Tab to focus next shape in z-order.
      if (e.key === 'Tab') {
        e.preventDefault();
        const all = [...state.document.shapes].sort((a, b) => a.zIndex - b.zIndex);
        if (all.length === 0) return;
        const currentIdx = state.selectedIds.length > 0
          ? all.findIndex((s) => s.id === state.selectedIds[state.selectedIds.length - 1])
          : -1;
        const nextIdx = e.shiftKey
          ? (currentIdx <= 0 ? all.length - 1 : currentIdx - 1)
          : (currentIdx + 1) % all.length;
        state.select([all[nextIdx].id]);
        return;
      }

      // P0-08: Shape-tool shortcuts — drop at viewport center + select.
      // R rectangle, O ellipse, T text, L line, F frame.
      const shapeKey = e.key.toLowerCase();
      const shapeDefs: Record<string, { type: Shape['type']; w: number; h: number; fill?: string }> = {
        r: { type: 'rectangle', w: 100, h: 100 },
        o: { type: 'ellipse', w: 100, h: 100 },
        t: { type: 'text', w: 200, h: 24 },
        l: { type: 'line', w: 100, h: 0 },
        f: { type: 'frame', w: 200, h: 200 },
      };
      const def = shapeDefs[shapeKey];
      // P1-23: A key applies auto-layout to the currently selected frame.
      if (shapeKey === 'a') {
        e.preventDefault();
        if (state.selectedIds.length === 1) {
          const s = findShape(state.document, state.selectedIds[0]);
          if (s && (s.type === 'frame' || s.type === 'group')) {
            state.sendPatch({
              op: 'update',
              shapeId: s.id,
              shape: { autoLayout: { direction: 'vertical', gap: 8, padding: 16, alignX: 'center', alignY: 'min' } } as Partial<Shape>,
              summary: `Applied auto-layout (vertical, gap 8, pad 16) to ${s.name}`,
            });
          }
        }
        return;
      }
      // P1-23: P (pen / path tool) — not yet implemented; toast the user.
      if (shapeKey === 'p') {
        e.preventDefault();
        toast.message('Pen tool — use the chat panel: "draw a path through points (10,10) (50,40) (90,10)"');
        return;
      }
      if (def) {
        e.preventDefault();
        const vp = state.document.viewport;
        // Compute the canvas-space center of the current viewport.
        const cx = (-vp.panX + (typeof window !== 'undefined' ? window.innerWidth / 2 : 600)) / vp.zoom;
        const cy = (-vp.panY + (typeof window !== 'undefined' ? window.innerHeight / 2 : 400)) / vp.zoom;
        const newId = `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const patch: CanvasPatch = {
          op: 'add',
          shape: {
            id: newId,
            type: def.type,
            name: def.type.charAt(0).toUpperCase() + def.type.slice(1),
            x: cx - def.w / 2,
            y: cy - def.h / 2,
            width: def.w,
            height: def.h,
            fill: def.type === 'line' ? '#0f172a' : '#e2e8f0',
            stroke: '#0f172a',
            strokeWidth: def.type === 'line' ? 2 : 0,
            text: def.type === 'text' ? 'Text' : undefined,
            fontSize: 16,
            textColor: '#0f172a',
            radius: 0,
          },
          summary: `Added ${def.type}`,
        };
        state.sendPatch(patch);
        state.select([newId]);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leftCollapsed, rightCollapsed, toggleZen, clipboard]);

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="h-screen w-screen flex flex-col ac-surface-1 ac-text-1 overflow-hidden"
        data-density={density}
      >
        {/* ───────────────────────── Top-level menu bar (P1-13) ─────────────────────────
            File / Edit / View / Insert / Object / Help. Hidden in Zen mode. */}
        {!isZenMode && (
          <TopMenuBar
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCommandPalette={() => setPaletteOpen(true)}
            onToggleZen={toggleZen}
            onToggleTheme={() => {/* theme cycling handled by ThemeToggle in header */}}
            onToggleLeftPanel={() => toggle(leftPanelRef, leftCollapsed, setLeftCollapsed)}
            onToggleRightPanel={() => toggle(rightPanelRef, rightCollapsed, setRightCollapsed)}
            onNewChat={() => useCanvasStore.getState().newSession()}
            onExportPen={() => toast.message('Use the .pen file menu in the header to export.')}
            onImportPen={() => toast.message('Use the .pen file menu in the header to import.')}
            onOpenShortcuts={() => setShortcutsOpen(true)}
          />
        )}
        {/* ───────────────────────── Top bar ───────────────────────── */}
        <header className="flex items-center justify-between px-3 h-11 border-b ac-border-default ac-surface-0 flex-shrink-0 gap-3">
          {/* Left: brand + doc name */}
          <div className="flex items-center gap-2 min-w-0 flex-shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-sm">
                <PenTool className="h-3.5 w-3.5 text-white" />
              </div>
              <span className="font-semibold text-[13px] tracking-tight ac-text-1 hidden sm:inline">AgentCanvas</span>
            </div>
            <span className="ac-text-5 text-xs select-none hidden sm:inline">/</span>
            <Input
              value={document.name}
              onChange={(e) => setDocumentName(e.target.value)}
              className="h-7 w-40 text-xs border-transparent bg-transparent hover:ac-border-subtle focus-visible:ac-border-default ac-text-2 hidden sm:inline-flex"
            />
          </div>

          {/* Center: active session title (compact) */}
          <div className="flex-1 min-w-0 flex items-center justify-center">
            <SessionHeader compact />
          </div>

          {/* Right: ⌘K palette + Run/Stop + connection status + zen + theme + file */}
          <div className="flex items-center gap-1.5 text-[11px] flex-shrink-0">
            {/* ⌘K command palette trigger — styled like a search box for discoverability */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPaletteOpen(true)}
              title="Command palette (⌘K)"
              aria-label="Open command palette"
              className="h-7 px-2 text-[11px] ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-surface-1 ac-border-subtle border ac-transition ac-focus-ring gap-1.5"
            >
              <Search className="h-3 w-3" />
              <span className="hidden md:inline">Ask anything</span>
              <kbd className="hidden md:inline text-[10px] ac-text-5 px-1 py-0 rounded ac-surface-2 font-mono ml-1">⌘K</kbd>
            </Button>

            <RunStopButton onAsk={() => setPaletteOpen(true)} />

            <div className="w-px h-5 ac-border-subtle border-l mx-0.5" />

            {/* Connection + agent status — single icon with tooltip */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md ac-surface-1 ac-text-3 border ac-border-subtle cursor-default"
                  aria-label="Agent + connection status"
                >
                  <Bot className="h-3 w-3" />
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      connected ? 'ac-dot-success' : 'ac-dot-warning'
                    }`}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                {connected
                  ? `Agent-driven · live sync · ${viewerCount} viewer${viewerCount === 1 ? '' : 's'}`
                  : 'Agent-driven · local-only (live sync unavailable)'}
              </TooltipContent>
            </Tooltip>

            {/* Zen mode */}
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleZen}
              title="Zen mode — hide all panels (⌘\\)"
              aria-label="Toggle zen mode"
              className={`h-7 w-7 p-0 ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring ${isZenMode ? 'ac-surface-1 ac-text-1' : ''}`}
            >
              {isZenMode ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>

            <PenFileMenu />

            {/* Settings — opens the settings dialog */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-label="Open settings"
              className="h-7 w-7 p-0 ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>

            <ThemeToggle />
          </div>
        </header>

        {/* ───────────────────────── Main split ───────────────────────── */}
        {/* Wrapper is relative so the collapsed-panel edge buttons can float. */}
        <div className="relative flex-1 min-h-0">
        <ResizablePanelGroup
          orientation="horizontal"
          id="co-canvas-layout-h"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className="h-full"
        >
          {/* Col 1 — Left: single tabbed panel (Chats / Layers) */}
          {/* v4 API note: numeric sizes are PIXELS in v4 (was % in v3).
              We want percentages, so use strings like "20%". */}
          <ResizablePanel
            panelRef={leftPanelRef}
            defaultSize="20%"
            minSize="14%"
            maxSize="32%"
            collapsible
            collapsedSize="0%"
            onResize={(size) => setLeftCollapsed(size.inPixels === 0)}
          >
            <LeftTabbedPanel
              tab={leftTab}
              onTabChange={setLeftTab}
              collapsed={leftCollapsed}
              onToggleCollapse={() => toggle(leftPanelRef, leftCollapsed, setLeftCollapsed)}
            />
          </ResizablePanel>

          <ResizableHandle />

          {/* Col 2 — Center: canvas (toolbar floats over it, bottom-center) */}
          <ResizablePanel defaultSize="52%" minSize="36%">
            <div className="relative h-full">
              <Canvas />
              <Toolbar />
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Col 3 — Right: single tabbed panel (Chat / Design / History) */}
          <ResizablePanel
            panelRef={rightPanelRef}
            defaultSize="28%"
            minSize="20%"
            maxSize="42%"
            collapsible
            collapsedSize="0%"
            onResize={(size) => setRightCollapsed(size.inPixels === 0)}
          >
            <RightTabbedPanel
              tab={rightTab}
              onTabChange={setRightTab}
              collapsed={rightCollapsed}
              onToggleCollapse={() => toggle(rightPanelRef, rightCollapsed, setRightCollapsed)}
            />
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* ── Collapsed-panel edge buttons ─────────────────────────────────
            When a panel is collapsed (collapsedSize=0), its own header chevron
            disappears too — leaving no visible way to bring it back except the
            ⌘1/⌘2 keyboard shortcuts. These floating edge buttons solve that:
            a thin tab on the screen edge that's always visible when the panel
            is collapsed. Click to expand. Matches the pattern used by VS Code,
            Chrome DevTools, and Figma's collapsed-panel edges. */}

        {/* Left panel collapsed → show expand tab on the left edge */}
        {leftCollapsed && (
          <button
            onClick={() => toggle(leftPanelRef, leftCollapsed, setLeftCollapsed)}
            title="Show left panel (⌘1)"
            aria-label="Show left panel"
            className="absolute top-1/2 -translate-y-1/2 left-0 z-30 flex items-center justify-center h-16 w-5 rounded-r-md border border-l-0 ac-border-default ac-surface-0 shadow-md hover:ac-surface-1 ac-transition ac-focus-ring"
          >
            <PanelLeft className="h-3.5 w-3.5 ac-text-2" />
          </button>
        )}

        {/* Right panel collapsed → show expand tab on the right edge */}
        {rightCollapsed && (
          <button
            onClick={() => toggle(rightPanelRef, rightCollapsed, setRightCollapsed)}
            title="Show right panel (⌘2)"
            aria-label="Show right panel"
            className="absolute top-1/2 -translate-y-1/2 right-0 z-30 flex items-center justify-center h-16 w-5 rounded-l-md border border-r-0 ac-border-default ac-surface-0 shadow-md hover:ac-surface-1 ac-transition ac-focus-ring"
          >
            <PanelRight className="h-3.5 w-3.5 ac-text-2" />
          </button>
        )}
        </div>
      </div>

      {/* ⌘K command palette — fuzzy-searchable preset prompts */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />

      {/* Settings dialog — agent behavior, LLM provider, sessions, appearance, data, shortcuts */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </TooltipProvider>
  );
}

// ───────────────────────── Left column — tabbed ─────────────────────────
// Merges Sessions + Layers into a single panel with tabs. Gives whichever is
// active the full vertical space of the left column — instead of permanently
// splitting it in half.
function LeftTabbedPanel({
  tab, onTabChange, collapsed, onToggleCollapse,
}: {
  tab: LeftTab;
  onTabChange: (t: LeftTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const tabs: { id: LeftTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'chats',  label: 'Chats',  icon: MessageSquare },
    { id: 'layers', label: 'Layers', icon: LayersIcon },
  ];
  return (
    <div className={`flex flex-col h-full ac-surface-0 ac-hide-scrollbar overflow-hidden min-w-0 ${collapsed ? 'hidden' : ''}`}>
      {/* Tab strip — also serves as the panel header (collapse chevron on the right) */}
      <div className="flex items-center gap-1 px-1.5 py-1.5 border-b ac-border-subtle ac-surface-0 flex-shrink-0">
        <div className="flex gap-0.5 flex-1 min-w-0">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => onTabChange(t.id)}
                className={`flex items-center gap-1.5 px-2.5 h-7 rounded-md text-[11px] font-medium ac-transition ac-focus-ring ${
                  active
                    ? 'ac-surface-2 ac-text-1 shadow-sm'
                    : 'ac-text-3 hover:ac-text-1 hover:ac-surface-1'
                }`}
                aria-pressed={active}
              >
                <Icon className="h-3 w-3" />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Collapse chevron on the panel header itself */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          title="Toggle left panel (⌘1)"
          aria-label="Toggle left panel"
          className="h-7 w-7 p-0 ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring flex-shrink-0"
        >
          {collapsed ? <PanelRight className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Active panel body — full vertical space */}
      <div className="flex-1 min-h-0">
        {tab === 'chats' && <SessionSidebar />}
        {tab === 'layers' && <LayersPanel />}
      </div>
    </div>
  );
}

// ───────────────────────── Right column — tabbed ─────────────────────────
// Replaces the previous Properties (top) + Chat (middle) + History (bottom)
// vertical stack with a single panel that uses tabs. Gives whichever panel is
// active the full vertical space of the right column.
function RightTabbedPanel({
  tab, onTabChange, collapsed, onToggleCollapse,
}: {
  tab: RightTab;
  onTabChange: (t: RightTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const tabs: { id: RightTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'chat',    label: 'Chat',    icon: MessageSquare },
    { id: 'design',  label: 'Design',  icon: Sliders },
    { id: 'history', label: 'History', icon: HistoryIcon },
  ];
  return (
    <div className={`flex flex-col h-full ac-surface-0 ac-hide-scrollbar overflow-hidden min-w-0 ${collapsed ? 'hidden' : ''}`}>
      {/* Tab strip — also serves as the panel header (collapse chevron on the right) */}
      <div className="flex items-center gap-1 px-1.5 py-1.5 border-b ac-border-subtle ac-surface-0 flex-shrink-0">
        <div className="flex gap-0.5 flex-1 min-w-0">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => onTabChange(t.id)}
                className={`flex items-center gap-1.5 px-2.5 h-7 rounded-md text-[11px] font-medium ac-transition ac-focus-ring ${
                  active
                    ? 'ac-surface-2 ac-text-1 shadow-sm'
                    : 'ac-text-3 hover:ac-text-1 hover:ac-surface-1'
                }`}
                aria-pressed={active}
              >
                <Icon className="h-3 w-3" />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Collapse chevron on the panel header itself */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          title="Toggle right panel (⌘3)"
          aria-label="Toggle right panel"
          className="h-7 w-7 p-0 ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring flex-shrink-0"
        >
          {collapsed ? <PanelLeft className="h-3.5 w-3.5" /> : <PanelRightClose className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Active panel body — full vertical space */}
      <div className="flex-1 min-h-0">
        {tab === 'chat' && <AgentPanel />}
        {tab === 'design' && <PropertiesPanel />}
        {tab === 'history' && <RunHistoryPanel hideHeader />}
      </div>
    </div>
  );
}

// Toggle a panel's collapsed state via its imperative handle.
function toggle(
  ref: React.RefObject<PanelImperativeHandle | null>,
  collapsed: boolean,
  setCollapsed: (v: boolean) => void,
) {
  if (!ref.current) return;
  if (collapsed) {
    ref.current.expand();
    setCollapsed(false);
  } else {
    ref.current.collapse();
    setCollapsed(true);
  }
}
