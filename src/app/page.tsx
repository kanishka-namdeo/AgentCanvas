'use client';

import { useEffect } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Canvas } from '@/components/canvas/Canvas';
import { Toolbar } from '@/components/canvas/Toolbar';
import { LayersPanel } from '@/components/canvas/LayersPanel';
import { PropertiesPanel } from '@/components/canvas/PropertiesPanel';
import { AgentPanel } from '@/components/canvas/AgentPanel';
import { useCanvasStore } from '@/lib/canvas/store';
import { SessionSidebar } from '@/components/sessions/SessionSidebar';
import { SessionHeader } from '@/components/sessions/SessionHeader';
import { RunHistoryPanel } from '@/components/sessions/RunHistoryPanel';
import { ThemeToggle } from '@/components/ThemeToggle';
import { PenTool, Github, Wifi, WifiOff, Bot } from 'lucide-react';
import { Input } from '@/components/ui/input';

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

  return (
    <div className="h-screen w-screen flex flex-col ac-surface-1 ac-text-1 overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 h-11 border-b ac-border-default ac-surface-0 flex-shrink-0">
        {/* Brand + document name */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-sm">
              <PenTool className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="font-semibold text-[13px] tracking-tight ac-text-1">AgentCanvas</span>
          </div>
          <span className="ac-text-5 text-xs select-none">/</span>
          <Input
            value={document.name}
            onChange={(e) => setDocumentName(e.target.value)}
            className="h-7 w-52 text-xs border-transparent bg-transparent hover:ac-border-subtle focus-visible:ac-border-default ac-text-2"
          />
        </div>
        {/* Status pills */}
        <div className="flex items-center gap-1.5 text-[11px]">
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
            <span>SDK docs</span>
          </a>
          <ThemeToggle />
        </div>
      </header>

      {/* Main split: sessions | layers/props | canvas | chat+history */}
      <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
          {/* Sessions sidebar */}
          <ResizablePanel defaultSize={14} minSize={10} maxSize={22}>
            <SessionSidebar />
          </ResizablePanel>

          <ResizableHandle />

          {/* Layers + properties */}
          <ResizablePanel defaultSize={16} minSize={12} maxSize={26}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={55} minSize={20}>
                <LayersPanel />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={45} minSize={20}>
                <PropertiesPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle />

          {/* Center: toolbar + canvas */}
          <ResizablePanel defaultSize={46} minSize={30}>
            <div className="flex h-full">
              <Toolbar />
              <div className="flex-1 min-w-0 relative">
                <Canvas />
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Right: chat header + agent panel + run history */}
          <ResizablePanel defaultSize={24} minSize={18} maxSize={42}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={62} minSize={25}>
                <div className="flex flex-col h-full ac-surface-0">
                  <SessionHeader />
                  <div className="flex-1 min-h-0">
                    <AgentPanel hideHeader />
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={38} minSize={15}>
                <RunHistoryPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
    </div>
  );
}
