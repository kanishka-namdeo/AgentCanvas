'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { Canvas } from '@/components/canvas/Canvas';
import { Toolbar } from '@/components/canvas/Toolbar';
import { LayersPanel } from '@/components/canvas/LayersPanel';
import { PropertiesPanel } from '@/components/canvas/PropertiesPanel';
import { AgentPanel } from '@/components/canvas/AgentPanel';
import { CommandPalette } from '@/components/canvas/CommandPalette';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useSettings } from '@/lib/settings/store';
import { useCanvasStore } from '@/lib/canvas/store';
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
  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);

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

  // Auto-archive idle sessions on app mount, per the user's setting.
  // Also enforce the max-sessions-retained cap. Runs once after hydration.
  const density = useSettings((s) => s.density);

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
        leftSize: leftPanelRef.current?.getSize() ?? 18,
        rightSize: rightPanelRef.current?.getSize() ?? 28,
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
          if (!snap.leftCollapsed) leftPanelRef.current?.resize(snap.leftSize);
          if (!snap.rightCollapsed) rightPanelRef.current?.resize(snap.rightSize);
        });
      } else {
        leftPanelRef.current?.expand();
        rightPanelRef.current?.expand();
        setLeftCollapsed(false);
        setRightCollapsed(false);
      }
    }
  }, [isZenMode, leftCollapsed, rightCollapsed]);

  // Keyboard shortcuts: ⌘1 left column, ⌘2 right column, ⌘K command palette,
  // ⌘, settings, ⌘\ zen mode, ⌘Z undo, ⌘⇧Z redo, V select tool, H pan tool.
  // Undo/redo and tool shortcuts don't require meta.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      // Meta-required shortcuts:
      if (meta) {
        if (e.key === '1') { e.preventDefault(); toggle(leftPanelRef, leftCollapsed, setLeftCollapsed); }
        else if (e.key === '2') { e.preventDefault(); toggle(rightPanelRef, rightCollapsed, setRightCollapsed); }
        else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); setPaletteOpen((v) => !v); }
        else if (e.key === ',') { e.preventDefault(); setSettingsOpen((v) => !v); }
        else if (e.key === '\\') { e.preventDefault(); toggleZen(); }
        else if (e.key === 'z' || e.key === 'Z') {
          e.preventDefault();
          if (e.shiftKey) {
            useCanvasStore.getState().redo();
          } else {
            useCanvasStore.getState().undo();
          }
        }
        return;
      }
      // Non-meta shortcuts — only fire when not typing in an input/textarea.
      const target = e.target as HTMLElement;
      const isEditable = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (isEditable) return;
      if (e.key === 'v' || e.key === 'V') { useCanvasStore.getState().setToolMode('select'); }
      else if (e.key === 'h' || e.key === 'H') { useCanvasStore.getState().setToolMode('pan'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leftCollapsed, rightCollapsed, toggleZen]);

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="h-screen w-screen flex flex-col ac-surface-1 ac-text-1 overflow-hidden"
        data-density={density}
      >
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
                      connected ? 'bg-emerald-500' : 'bg-amber-400'
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
        <ResizablePanelGroup direction="horizontal" autoSaveId="co-canvas-layout-h" className="flex-1 min-h-0">
          {/* Col 1 — Left: single tabbed panel (Chats / Layers) */}
          <ResizablePanel
            ref={leftPanelRef}
            defaultSize={20}
            minSize={14}
            maxSize={32}
            collapsible
            collapsedSize={0}
            onCollapse={() => setLeftCollapsed(true)}
            onExpand={() => setLeftCollapsed(false)}
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
          <ResizablePanel defaultSize={52} minSize={36}>
            <div className="relative h-full">
              <Canvas />
              <Toolbar />
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Col 3 — Right: single tabbed panel (Chat / Design / History) */}
          <ResizablePanel
            ref={rightPanelRef}
            defaultSize={28}
            minSize={20}
            maxSize={42}
            collapsible
            collapsedSize={0}
            onCollapse={() => setRightCollapsed(true)}
            onExpand={() => setRightCollapsed(false)}
          >
            <RightTabbedPanel
              tab={rightTab}
              onTabChange={setRightTab}
              collapsed={rightCollapsed}
              onToggleCollapse={() => toggle(rightPanelRef, rightCollapsed, setRightCollapsed)}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* ⌘K command palette — fuzzy-searchable preset prompts */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />

      {/* Settings dialog — agent behavior, LLM provider, sessions, appearance, data, shortcuts */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
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
    <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
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
    <div className="flex flex-col h-full ac-surface-0 ac-hide-scrollbar">
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
        {tab === 'chat' && <AgentPanel hideHeader />}
        {tab === 'design' && <PropertiesPanel />}
        {tab === 'history' && <RunHistoryPanel hideHeader />}
      </div>
    </div>
  );
}

// Toggle a panel's collapsed state via its imperative handle.
function toggle(
  ref: React.RefObject<ImperativePanelHandle | null>,
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
