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
import { Bot, PenTool, Github, Wifi, WifiOff } from 'lucide-react';
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
    <div className="h-screen w-screen flex flex-col bg-slate-50 text-slate-900 overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center justify-between px-3 py-2 border-b border-slate-200 bg-white">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className="w-7 h-7 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
              <PenTool className="h-4 w-4 text-white" />
            </div>
            <span className="font-semibold text-sm tracking-tight">AgentCanvas</span>
          </div>
          <span className="text-slate-300">/</span>
          <Input
            value={document.name}
            onChange={(e) => setDocumentName(e.target.value)}
            className="h-7 w-48 text-xs border-transparent hover:border-slate-200 focus-visible:border-slate-200"
          />
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          <div className="flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5" />
            <span>Agent-driven · Pi SDK</span>
          </div>
          <div className="flex items-center gap-1.5">
            {connected ? (
              <>
                <Wifi className="h-3.5 w-3.5 text-emerald-500" />
                <span>{viewerCount} viewer{viewerCount === 1 ? '' : 's'}</span>
              </>
            ) : (
              <>
                <WifiOff className="h-3.5 w-3.5 text-rose-400" />
                <span>offline</span>
              </>
            )}
          </div>
          <a
            href="https://pi.dev/docs/latest/sdk"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-slate-400 hover:text-slate-700"
          >
            <Github className="h-3.5 w-3.5" />
            <span>SDK docs</span>
          </a>
        </div>
      </header>

      {/* Main split: left sidebar | canvas | right sidebar (agent + properties) */}
      <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
          {/* Left sidebar: layers + properties (small) */}
          <ResizablePanel defaultSize={18} minSize={14} maxSize={28}>
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
          <ResizablePanel defaultSize={54} minSize={30}>
            <div className="flex h-full">
              <Toolbar />
              <div className="flex-1 min-w-0 relative">
                <Canvas />
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Right sidebar: agent chat */}
          <ResizablePanel defaultSize={28} minSize={20} maxSize={45}>
            <AgentPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
    </div>
  );
}
