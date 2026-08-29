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
import { DesignSystemPicker } from '@/components/design-systems/DesignSystemPicker';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useSettings } from '@/lib/settings/store';
import { useCanvasStore, findShape } from '@/lib/canvas/store';
import { useClipboard } from '@/hooks/use-clipboard';
import { useIsMobile } from '@/lib/canvas/use-is-mobile';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';
import { SHORTCUTS_BY_ACTION, matchShortcut } from '@/lib/canvas/shortcuts';
import { SessionSidebar } from '@/components/sessions/SessionSidebar';
import { SessionHeader } from '@/components/sessions/SessionHeader';
import { RunHistoryPanel } from '@/components/sessions/RunHistoryPanel';
import { RunStopButton } from '@/components/sessions/RunStopButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { usePenFile } from '@/components/canvas/PenFileMenu';
import {
  PenTool, Bot, PanelLeft, PanelRight, PanelLeftClose, PanelRightClose,
  Maximize2, Minimize2, MessageSquare, Sliders, History as HistoryIcon,
  Layers as LayersIcon, Search, Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';

type RightTab = 'chat' | 'design' | 'history';
type LeftTab = 'chats' | 'layers';

export default function Home() {
  // Multi-document support (P3-1): the page used to hard-code `documentId =
  // 'demo'` so no UI ever created new documents. We now read it from the URL
  // (?doc=ID) on first load — falling back to 'demo' for legacy compatibility
  // (existing localStorage caches and the shared-canvas hydration flow expect
  // 'demo' to be the seed id). The document switcher in SessionHeader calls
  // the canvas store's init(docId) to swap the live document; this hook only
  // seeds the FIRST init from the URL (subsequent switches don't touch the
  // URL, mirroring how v0 / ChatGPT / Cursor behave — the doc id is a session
  // state, not a route).
  const [documentId] = useState(() => {
    if (typeof window === 'undefined') return 'demo';
    const fromUrl = new URLSearchParams(window.location.search).get('doc');
    return fromUrl && /^[a-zA-Z0-9_-]{1,64}$/.test(fromUrl) ? fromUrl : 'demo';
  });
  const init = useCanvasStore((s) => s.init);
  const connected = useCanvasStore((s) => s.connected);
  const viewerCount = useCanvasStore((s) => s.viewerCount);
  const document = useCanvasStore((s) => s.document);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const selectedIds = useCanvasStore((s) => s.selectedIds);

  // Headless .pen export/import — handlers feed the File menu; `chrome` is
  // the hidden file input + busy toast (rendered once, always mounted).
  const penFile = usePenFile();

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
  // Design-System Registry picker visibility — opens a modal where the
  // user picks which pack the agent should use for subsequent UI
  // generation. Mounted via View → "Design Systems…".
  const [designSystemsOpen, setDesignSystemsOpen] = useState(false);

  // Mobile detection (P3-8) — drives auto-collapse + wider panel sizes on
  // touch devices. SSR-safe (returns false during SSR; the effect syncs to
  // the real media-query match on mount).
  const isMobile = useIsMobile();

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

  // Mobile auto-collapse (P3-8) — when transitioning to mobile width, force
  // both side panels collapsed so the canvas gets full width. The user can
  // still open them via the edge buttons; the panel min/max sizes below
  // ensure an opened panel takes ~85% of the screen on mobile (vs. 14-32%
  // on desktop). Does NOT auto-expand when transitioning back to desktop —
  // the user's last layout is preserved.
  useEffect(() => {
    if (!isMobile) return;
    if (leftPanelRef.current && !leftPanelRef.current.isCollapsed?.()) {
      leftPanelRef.current.collapse();
      setLeftCollapsed(true);
    }
    if (rightPanelRef.current && !rightPanelRef.current.isCollapsed?.()) {
      rightPanelRef.current.collapse();
      setRightCollapsed(true);
    }
  }, [isMobile]);

  // Phase 4 — DOM-renderer bench test hooks (spec Appendix F).
  //
  // Dev-only: never registered in production builds (`process.env.NODE_ENV !==
  // 'production'` guard). The bench runner (scripts/dom-renderer-bench/run.ts)
  // uses these to inject synthetic documents and drive patches from outside
  // the React tree; when the hooks are absent (production CI), the runner
  // falls back to driving `__canvasStore` directly (always exposed in
  // store.ts:1920). Keeping these as named hooks documents the bench's surface
  // area so the canvas app and the runner don't drift.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (typeof window === 'undefined') return;
    const w = window as any;
    w.__agentcanvas_test_inject_document = (doc: CanvasDocument) => {
      // Swap in the synthetic doc; reset undo/redo so the bench's `update`
      // patches start from a clean slate. Preserves viewport — the runner
      // drives its own viewport via __canvasStore anyway.
      const cur = useCanvasStore.getState();
      useCanvasStore.setState({
        document: { ...cur.document, ...doc, viewport: doc.viewport ?? cur.document.viewport },
        undoStack: [],
        redoStack: [],
      });
    };
    w.__agentcanvas_test_get_world_element = (): HTMLElement | null => {
      // Prefer the store's registered worldElement (DomCanvas registers it on
      // mount — see store.ts:892); fall back to a DOM query so the hook still
      // works if the renderer hasn't registered yet (race during reload).
      // NOTE: `window.document` (not bare `document`) — the enclosing
      // component shadows the global with the store's `document` field at
      // line 50 (`const document = useCanvasStore((s) => s.document)`).
      const fromStore = useCanvasStore.getState().worldElement;
      return fromStore || window.document.querySelector('[data-ac-world]');
    };
    w.__agentcanvas_test_apply_patch = (patch: CanvasPatch) => {
      // Routes through sendPatch so the patch-coalescing queue + undo semantics
      // match the production patch path exactly (no bypass — same code path
      // the agent + drag gestures use).
      useCanvasStore.getState().sendPatch(patch);
    };
    return () => {
      delete w.__agentcanvas_test_inject_document;
      delete w.__agentcanvas_test_get_world_element;
      delete w.__agentcanvas_test_apply_patch;
    };
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

  // Keyboard shortcuts — registry-driven (spec Phase 7 / Appendix H §H.2).
  //   The single registry (lib/canvas/shortcuts.ts) drives BOTH this keymap
  //   and the KeyboardShortcutsDialog, so they can never drift. This handler
  //   owns app/layers/structure chords; the Canvas shell owns canvas-scope
  //   view/zoom/navigation chords (they need shell-local viewport state).
  //
  //   Legacy P0 matrix still live here: ⌘1/⌘2 + ⌘⇧1/⌘⇧2 panels, ⌘K palette,
  //   ⌘, settings, ⌘\ zen, ⌘/ shortcuts, ⌘Z/⌘⇧Z undo/redo, ⌘C/⌘X/⌘V/⌘⇧V/⌘A
  //   clipboard, ⌘]/⌘[ z-order, arrows nudge, A auto-layout, P pen toast.
  //   Phase 7 adds (via the registry): ⌘G/⌘⇧G/⌥⌘G structure, ⌘D duplicate,
  //   ⌘⇧L/⌘⇧H lock/hide (rebound from ⌘L/⌘; — legacy chords kept as aliases),
  //   ⌘R rename, ⌥A/W/S/D + ⌥H/⌥V align, ⇧H/⇧V flip, ⌥⌘K create component
  //   (rebound from ⌘⇧C), ⌥⌘B detach instance, K scale tool, ⇧S section,
  //   S slice tool.
  const clipboard = useClipboard();
  useEffect(() => {
    // Registry dispatch helper — matches the FIRST allowlisted action whose
    // chord fits the event (exact modifier matching, platform-aware).
    const dispatch = (e: KeyboardEvent, actions: readonly string[]): string | null => {
      for (const action of actions) {
        const def = SHORTCUTS_BY_ACTION.get(action);
        if (def && matchShortcut(e, def)) return action;
      }
      return null;
    };
    // P0-08 helper — drop a shape at the viewport center + select it (the
    // shared payload behind the R/O/T/L/F/⇧S/S tool chords).
    const dropShapeAtCenter = (type: Shape['type'], w: number, h: number) => {
      const state = useCanvasStore.getState();
      const vp = state.document.viewport;
      const cx = (-vp.panX + (typeof window !== 'undefined' ? window.innerWidth / 2 : 600)) / vp.zoom;
      const cy = (-vp.panY + (typeof window !== 'undefined' ? window.innerHeight / 2 : 400)) / vp.zoom;
      const newId = `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const patch: CanvasPatch = {
        op: 'add',
        shape: {
          id: newId,
          type,
          name: type.charAt(0).toUpperCase() + type.slice(1),
          x: cx - w / 2,
          y: cy - h / 2,
          width: w,
          height: h,
          fill: type === 'line' ? '#0f172a' : '#e2e8f0',
          stroke: '#0f172a',
          strokeWidth: type === 'line' ? 2 : 0,
          text: type === 'text' ? 'Text' : undefined,
          fontSize: 16,
          textColor: '#0f172a',
          radius: 0,
        },
        summary: `Added ${type}`,
      };
      state.sendPatch(patch);
      state.select([newId]);
    };
    // Phase 7 align helper — canonical alignKind values (Appendix G §G.2;
    // the patch applier normalizes + accepts both spellings).
    const alignSelection = (kind: CanvasPatch['alignKind'], label: string) => {
      const state = useCanvasStore.getState();
      if (state.selectedIds.length < 2 || !kind) return;
      state.sendPatch({
        op: 'align',
        shapeIds: state.selectedIds,
        alignKind: kind,
        summary: `Aligned ${state.selectedIds.length} node(s) ${label}`,
      });
    };
    // Phase 7 flip helper — writes the .pen flipX/flipY flag (H.2 ⇧H/⇧V).
    // NOTE (deviation): the renderers do not yet APPLY flip flags visually;
    // the data-level write keeps the model Figma-aligned until path/gradient
    // mirroring lands with the deferred SVG-fidelity work.
    const flipSelection = (axis: 'flipX' | 'flipY') => {
      const state = useCanvasStore.getState();
      for (const id of state.selectedIds) {
        const s = findShape(state.document, id);
        if (!s) continue;
        const penNode = (s as unknown as Record<string, unknown>)[axis];
        state.sendPatch({
          op: 'update',
          shapeId: id,
          shape: { [axis]: !penNode } as Partial<Shape>,
          summary: `${axis === 'flipX' ? 'Flipped horizontally' : 'Flipped vertically'}: ${s.name}`,
        });
      }
    };
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

        // ---- Phase 7 registry chords (meta family — spec Appendix H §H.2) ----
        // Runs BEFORE the ad-hoc clipboard/letter checks so rebound chords
        // (⌘⇧C create-component alias, ⌘⇧L lock, ⌘⇧H hide) win over the
        // legacy single-letter handlers below.
        if (isEditable) return; // structure chords never hijack text inputs
        const metaAction = dispatch(e, [
          'group', 'ungroup', 'frame-selection', 'duplicate',
          'lock', 'hide', 'rename', 'create-component', 'detach-instance',
          'save-checkpoint',
        ]);
        if (metaAction) {
          e.preventDefault();
          const sel = state.selectedIds
            .map((id) => findShape(state.document, id))
            .filter((s): s is Shape => !!s);
          switch (metaAction) {
            case 'group':
              if (state.selectedIds.length >= 2) {
                state.sendPatch({ op: 'group', shapeIds: state.selectedIds, summary: `Grouped ${state.selectedIds.length} shape(s)` });
              }
              break;
            case 'ungroup': {
              const groups = state.document.shapes.filter((s) => s.type === 'group' && state.selectedIds.includes(s.id));
              if (groups.length > 0) {
                state.sendPatch({ op: 'ungroup', shapeIds: groups.map((g) => g.id), summary: `Ungrouped ${groups.length} group(s)` });
              }
              break;
            }
            case 'frame-selection':
              if (state.selectedIds.length >= 1) {
                // Wrap the selection in a FRAME (not a group): reuse the
                // well-tested group op (bbox + coordinate remap, explicit
                // groupId so we can address it) then flip the wrapper's type
                // to 'frame' (Figma ⌥⌘G semantics).
                const frameId = `frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                state.sendPatch({ op: 'group', groupId: frameId, shapeIds: state.selectedIds, summary: `Framed ${state.selectedIds.length} shape(s)` });
                state.sendPatch({ op: 'update', shapeId: frameId, shape: { type: 'frame', name: 'Frame' } as Partial<Shape>, summary: 'Frame selection' });
              }
              break;
            case 'duplicate':
              if (state.selectedIds.length > 0) {
                state.sendPatch({ op: 'duplicate', shapeIds: state.selectedIds, summary: `Duplicated ${state.selectedIds.length} shape(s)` });
              }
              break;
            case 'lock':
              for (const s of sel) {
                state.sendPatch({ op: 'update', shapeId: s.id, shape: { locked: !s.locked }, summary: `${s.locked ? 'Unlocked' : 'Locked'} ${s.name}` });
              }
              break;
            case 'hide':
              for (const s of sel) {
                state.sendPatch({ op: 'update', shapeId: s.id, shape: { visible: !s.visible }, summary: `${s.visible ? 'Hid' : 'Showed'} ${s.name}` });
              }
              break;
            case 'rename':
              // Focus the selected layer's inline rename input in the Layers
              // panel (⌘R — spec Phase 7). CustomEvent keeps the store clean.
              window.dispatchEvent(new CustomEvent('ac:layers-rename'));
              break;
            case 'create-component': {
              if (sel.length === 1 && (sel[0].type === 'frame' || sel[0].type === 'group')) {
                state.sendPatch({ op: 'convert_to_component', shapeId: sel[0].id, summary: `Promoted ${sel[0].name} to reusable Component` });
              } else if (sel.length === 1) {
                state.sendPatch({ op: 'update', shapeId: sel[0].id, shape: { componentId: sel[0].id } as Partial<Shape>, summary: `Marked ${sel[0].name} as component master` });
              } else {
                toast.message('Select a single frame or group to create a component');
              }
              break;
            }
            case 'detach-instance': {
              const inst = sel.find((s) => !!s.componentId && s.componentId !== s.id);
              if (inst) {
                state.sendPatch({ op: 'detach_instance', shapeId: inst.id, summary: `Detached instance ${inst.name}` });
              }
              break;
            }
            case 'save-checkpoint': {
              // Phase 7 group C (D14): manual version-history checkpoint
              // (⌘⌥S / Ctrl+Alt+S — registry action 'save-checkpoint').
              const name = window.prompt('Checkpoint name:', 'Manual save') ?? 'Manual save';
              const saved = state.addCheckpoint(name, false);
              if (saved) toast.success('Checkpoint saved', { description: name });
              else toast.message('No changes since the last checkpoint');
              break;
            }
          }
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

        // (P0-05 Group/Ungroup and P0-06 Duplicate now dispatch through the
        // Phase 7 registry block above — ⌘G / ⌘⇧G / ⌘D — keeping the exact
        // same patch payloads.)

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

      // ---- Phase 7 registry chords (non-meta family) -----------------------
      // Tools (V/H/K/F/⇧S/S/R/O/L/T), align (⌥A/W/S/D, ⌥H/⌥V) and flip
      // (⇧H/⇧V). Exact modifier matching means plain 'h' still switches the
      // hand tool while ⇧H flips — no ad-hoc shift guards needed. Also
      // covers the sidebar tab-selectors ⌥1 / ⌥2 (Appendix H §H.3 #1).
      const plainAction = dispatch(e, [
        'tool.move', 'tool.hand', 'tool.scale', 'tool.frame', 'tool.section',
        'tool.slice', 'tool.rectangle', 'tool.ellipse', 'tool.line', 'tool.text',
        'align.left', 'align.top', 'align.bottom', 'align.right',
        'align.hcenter', 'align.vcenter', 'flip.h', 'flip.v',
        'panel.layers-tab', 'panel.assets-tab',
      ]);
      if (plainAction) {
        e.preventDefault();
        switch (plainAction) {
          case 'tool.move':
            state.setToolMode('select');
            break;
          case 'tool.hand':
            state.setToolMode('pan');
            break;
          case 'tool.scale':
            state.setToolMode('scale');
            break;
          case 'tool.frame':
            dropShapeAtCenter('frame', 200, 200);
            break;
          case 'tool.section':
            dropShapeAtCenter('section', 480, 320);
            break;
          case 'tool.slice':
            dropShapeAtCenter('slice', 200, 120);
            break;
          case 'tool.rectangle':
            dropShapeAtCenter('rectangle', 100, 100);
            break;
          case 'tool.ellipse':
            dropShapeAtCenter('ellipse', 100, 100);
            break;
          case 'tool.line':
            dropShapeAtCenter('line', 100, 0);
            break;
          case 'tool.text':
            dropShapeAtCenter('text', 200, 24);
            break;
          case 'align.left':
            alignSelection('LEFT', 'left');
            break;
          case 'align.top':
            alignSelection('TOP', 'top');
            break;
          case 'align.bottom':
            alignSelection('BOTTOM', 'bottom');
            break;
          case 'align.right':
            alignSelection('RIGHT', 'right');
            break;
          case 'align.hcenter':
            alignSelection('HCENTER', 'horizontal centers');
            break;
          case 'align.vcenter':
            alignSelection('VCENTER', 'vertical centers');
            break;
          case 'flip.h':
            flipSelection('flipX');
            break;
          case 'flip.v':
            flipSelection('flipY');
            break;
          case 'panel.layers-tab':
            // ⌥1 — switch left sidebar to Layers tab. Dispatched via
            // CustomEvent so the LayersPanel can own its tab state
            // locally (no store round-trip); same pattern as ⌘R rename.
            window.dispatchEvent(new CustomEvent('ac:layers-set-tab', { detail: 'layers' }));
            break;
          case 'panel.assets-tab':
            // ⌥2 — switch left sidebar to Assets tab (component grid).
            window.dispatchEvent(new CustomEvent('ac:layers-set-tab', { detail: 'assets' }));
            break;
        }
        return;
      }

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

      // (P2-46 Tab z-order navigation REPLACED by the Phase 7 hierarchy
      // navigation: Tab/⇧Tab now cycles SIBLINGS and Enter/⇧Enter descends /
      // ascends — handled registry-driven in Canvas.tsx, which owns the
      // canvas-scope chords.)

      // P0-08 shape-drop shortcuts (R/O/T/L/F) now dispatch through the
      // Phase 7 registry block above — same drop-at-viewport-center payloads
      // via dropShapeAtCenter(), plus the new ⇧S section and S slice tools.
      const shapeKey = e.key.toLowerCase();
      // P1-23: A key applies auto-layout to the currently selected frame.
      // (⌥A align-left is consumed earlier by the registry block, so this
      // only fires for the unmodified key.)
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
            onExportPen={penFile.exportPen}
            onImportPen={penFile.importPen}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onOpenDesignSystems={() => setDesignSystemsOpen(true)}
          />
        )}
        {/* ───────────────────────── Top bar ─────────────────────────
            UI-audit 2026-08-29: the doc name renders exactly ONCE — the
            DocumentSwitcher in the centered SessionHeader (rename lives in
            its chevron menu). The old inline Input duplicated it here. */}
        <header className="flex flex-wrap items-center justify-between px-3 h-11 border-b ac-border-default ac-surface-0 flex-shrink-0 gap-2 sm:gap-3">
          {/* Left: brand */}
          <div className="flex items-center gap-2 min-w-0 flex-shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-sm">
                <PenTool className="h-3.5 w-3.5 text-white" />
              </div>
              <span className="font-semibold text-[13px] tracking-tight ac-text-1 hidden sm:inline">AgentCanvas</span>
            </div>
          </div>

          {/* Center: active session title (compact) */}
          <div className="flex-1 min-w-0 flex items-center justify-center">
            <SessionHeader compact />
          </div>

          {/* Right: ⌘K palette + Run/Stop + connection status + zen + theme + file */}
          <div className="flex items-center gap-2 text-[11px] flex-shrink-0 flex-wrap justify-end">
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
              We want percentages, so use strings like "20%".
              Mobile (P3-8): widen the min/max so an opened panel covers ~85%
              of the screen — otherwise the panel would be unusably narrow at
              375px viewport width. */}
          <ResizablePanel
            panelRef={leftPanelRef}
            defaultSize={isMobile ? '85%' : '20%'}
            minSize={isMobile ? '70%' : '16%'}
            maxSize={isMobile ? '95%' : '32%'}
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
          <ResizablePanel defaultSize={isMobile ? '100%' : '52%'} minSize={isMobile ? '40%' : '36%'}>
            <div className="relative h-full">
              <Canvas />
              <Toolbar />
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Col 3 — Right: single tabbed panel (Chat / Design / History) */}
          <ResizablePanel
            panelRef={rightPanelRef}
            defaultSize={isMobile ? '85%' : '28%'}
            minSize={isMobile ? '70%' : '22%'}
            maxSize={isMobile ? '95%' : '42%'}
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

      {/* .pen file input + busy overlay (headless usePenFile chrome) */}
      {penFile.chrome}

      {/* Settings dialog — agent behavior, LLM provider, sessions, appearance, data, shortcuts */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {/* Design-System Registry picker — View → "Design Systems…" */}
      <DesignSystemPicker
        open={designSystemsOpen}
        onOpenChange={setDesignSystemsOpen}
        onPick={(name) => {
          toast.success(`Design system set to ${name}`, {
            description: 'The agent will use this pack for all UI generation this session.',
          });
        }}
      />
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
