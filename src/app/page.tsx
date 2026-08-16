'use client';

import { useEffect, useRef, useState } from 'react';
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
import { useCanvasStore } from '@/lib/canvas/store';
import { SessionSidebar } from '@/components/sessions/SessionSidebar';
import { SessionHeader } from '@/components/sessions/SessionHeader';
import { RunHistoryPanel } from '@/components/sessions/RunHistoryPanel';
import { RunStopButton } from '@/components/sessions/RunStopButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { PenTool, Github, Wifi, WifiOff, Bot, PanelLeft, PanelRight, PanelLeftClose, PanelRightClose } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export default function Home() {
  // Use a stable documentId for this demo. In a multi-document app this
  // would come from the URL.
  const documentId = 'demo';
  const init = useCanvasStore((s) => s.init);
  const connected = useCanvasStore((s) => s.connected);
  const viewerCount = useCanvasStore((s) => s.viewerCount);
  const document = useCanvasStore((s) => s.document);
  const setDocumentName = useCanvasStore((s) => s.setDocumentName);

  useEffect(() => {
    const cleanup = init(documentId);
    return cleanup;
  }, [init, documentId]);

  // Imperative panel refs — used by the collapse/expand toggle buttons in
  // the header. Each ref calls `.collapse()` / `.expand()` on its panel.
  const sessionsPanelRef = useRef<ImperativePanelHandle>(null);
  const layersPanelRef = useRef<ImperativePanelHandle>(null);
  const propertiesPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);

  // Track collapsed state so the toggle button icon flips.
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [layersCollapsed, setLayersCollapsed] = useState(false);
  const [propertiesCollapsed, setPropertiesCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Keyboard shortcuts: ⌘1 sessions, ⌘2 layers, ⌘3 properties, ⌘4 right column.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === '1') { e.preventDefault(); toggle(sessionsPanelRef, sessionsCollapsed, setSessionsCollapsed); }
      else if (e.key === '2') { e.preventDefault(); toggle(layersPanelRef, layersCollapsed, setLayersCollapsed); }
      else if (e.key === '3') { e.preventDefault(); toggle(propertiesPanelRef, propertiesCollapsed, setPropertiesCollapsed); }
      else if (e.key === '4') { e.preventDefault(); toggle(rightPanelRef, rightCollapsed, setRightCollapsed); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionsCollapsed, layersCollapsed, propertiesCollapsed, rightCollapsed]);

  return (
    <div className="h-screen w-screen flex flex-col ac-surface-1 ac-text-1 overflow-hidden">
      {/* Top bar — now hosts the session title + Run/Stop + collapse toggles */}
      <header className="flex items-center justify-between px-3 h-11 border-b ac-border-default ac-surface-0 flex-shrink-0 gap-3">
        {/* Left: brand + doc name + collapse-sidebar toggles */}
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

        {/* Right: Run/Stop + collapse toggles + status pills + theme */}
        <div className="flex items-center gap-1.5 text-[11px] flex-shrink-0">
          <RunStopButton />

          <div className="w-px h-5 ac-border-subtle border-l mx-0.5" />

          {/* Collapse toggles */}
          <CollapseToggle
            collapsed={sessionsCollapsed}
            onClick={() => toggle(sessionsPanelRef, sessionsCollapsed, setSessionsCollapsed)}
            title="Toggle sessions (⌘1)"
            icon={PanelLeft}
            closeIcon={PanelLeftClose}
          />
          <CollapseToggle
            collapsed={layersCollapsed}
            onClick={() => toggle(layersPanelRef, layersCollapsed, setLayersCollapsed)}
            title="Toggle layers (⌘2)"
            icon={PanelLeft}
            closeIcon={PanelLeftClose}
          />
          <CollapseToggle
            collapsed={propertiesCollapsed}
            onClick={() => toggle(propertiesPanelRef, propertiesCollapsed, setPropertiesCollapsed)}
            title="Toggle properties (⌘3)"
            icon={PanelRight}
            closeIcon={PanelRightClose}
          />
          <CollapseToggle
            collapsed={rightCollapsed}
            onClick={() => toggle(rightPanelRef, rightCollapsed, setRightCollapsed)}
            title="Toggle chat (⌘4)"
            icon={PanelRight}
            closeIcon={PanelRightClose}
          />

          <div className="w-px h-5 ac-border-subtle border-l mx-0.5" />

          {/* Status pills */}
          <div className="hidden md:flex items-center gap-1.5">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md ac-surface-1 ac-text-2 border ac-border-subtle">
              <Bot className="h-3 w-3" />
              <span>Agent-driven</span>
            </div>
            {connected ? (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border" style={{ backgroundColor: 'var(--ac-success-soft)', borderColor: 'var(--ac-success-soft)', color: 'var(--ac-success)' }}>
                <Wifi className="h-3 w-3" />
                <span>{viewerCount} viewer{viewerCount === 1 ? '' : 's'}</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md ac-surface-1 ac-text-3 border ac-border-subtle" title="Live sync unavailable — sessions, runs, and snapshots still work via localStorage">
                <WifiOff className="h-3 w-3" />
                <span>local-only</span>
              </div>
            )}
            <a
              href="https://pi.dev/docs/latest/sdk"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-2 py-1 rounded-md ac-text-3 hover:ac-text-1 ac-transition"
            >
              <Github className="h-3 w-3" />
              <span className="hidden lg:inline">SDK docs</span>
            </a>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* Main split: sessions | layers | canvas | properties/chat/history */}
      <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
          {/* Col 1 — Sessions sidebar (collapsible) */}
          <ResizablePanel
            ref={sessionsPanelRef}
            defaultSize={14}
            minSize={10}
            maxSize={22}
            collapsible
            collapsedSize={0}
            onCollapse={() => setSessionsCollapsed(true)}
            onExpand={() => setSessionsCollapsed(false)}
          >
            <SessionSidebar />
          </ResizablePanel>

          <ResizableHandle />

          {/* Col 2 — Layers (collapsible) */}
          <ResizablePanel
            ref={layersPanelRef}
            defaultSize={16}
            minSize={12}
            maxSize={26}
            collapsible
            collapsedSize={0}
            onCollapse={() => setLayersCollapsed(true)}
            onExpand={() => setLayersCollapsed(false)}
          >
            <LayersPanel />
          </ResizablePanel>

          <ResizableHandle />

          {/* Col 3 — Center: toolbar + canvas */}
          <ResizablePanel defaultSize={46} minSize={30}>
            <div className="flex h-full">
              <Toolbar />
              <div className="flex-1 min-w-0 relative">
                <Canvas />
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Col 4 — Right: properties + chat + history (all collapsible) */}
          <ResizablePanel
            ref={rightPanelRef}
            defaultSize={24}
            minSize={18}
            maxSize={42}
            collapsible
            collapsedSize={0}
            onCollapse={() => setRightCollapsed(true)}
            onExpand={() => setRightCollapsed(false)}
          >
            <ResizablePanelGroup direction="vertical">
              {/* Properties (top) — collapsible */}
              <ResizablePanel
                ref={propertiesPanelRef}
                defaultSize={40}
                minSize={15}
                collapsible
                collapsedSize={0}
                onCollapse={() => setPropertiesCollapsed(true)}
                onExpand={() => setPropertiesCollapsed(false)}
              >
                <PropertiesPanel />
              </ResizablePanel>
              <ResizableHandle />
              {/* Chat (middle) */}
              <ResizablePanel defaultSize={42} minSize={20}>
                <AgentPanel hideHeader />
              </ResizablePanel>
              <ResizableHandle />
              {/* History (bottom) */}
              <ResizablePanel defaultSize={18} minSize={10} collapsible collapsedSize={0}>
                <RunHistoryPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
    </div>
  );
}

/// Toggle a panel's collapsed state via its imperative handle.
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

/// Small icon button used to collapse/expand a panel.
function CollapseToggle({
  collapsed,
  onClick,
  title,
  icon: Icon,
  closeIcon: CloseIcon,
}: {
  collapsed: boolean;
  onClick: () => void;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  closeIcon: React.ComponentType<{ className?: string }>;
}) {
  const Active = collapsed ? CloseIcon : Icon;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      title={title}
      className={`h-7 w-7 p-0 ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring ${collapsed ? 'opacity-60' : ''}`}
    >
      <Active className="h-3.5 w-3.5" />
    </Button>
  );
}
