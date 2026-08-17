// PenFileMenu — export/import .pen (pen.dev) files.
//
// Adds a dropdown to the header with:
//   - Export .pen   — downloads the current canvas as a .pen JSON file
//   - Import .pen   — opens a file picker, parses, and applies the .pen file
//
// Export calls POST /api/pen/export with the live CanvasDocument; the
// response is the .pen JSON which we turn into a Blob download.
// Import reads the chosen file client-side, JSON.parses it, and POSTs to
// /api/pen/import, which returns a list of CanvasPatch ops we apply via
// the canvas store (so it's undoable + broadcast over the WS service).

'use client';

import { useRef, useState } from 'react';
import { FileJson, Download, Upload, ChevronDown, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCanvasStore } from '@/lib/canvas/store';
import { toast } from 'sonner';

export function PenFileMenu() {
  const document = useCanvasStore((s) => s.document);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);

  async function handleExport() {
    setBusy('export');
    try {
      const res = await fetch('/api/pen/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          document,
          filename: (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-'),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const filename = (document.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-') + '.pen';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${filename}`, {
        description: `${document.shapes.length} nodes → .pen format v2.17`,
      });
    } catch (e: any) {
      toast.error('Export failed', { description: e?.message ?? 'Unknown error' });
    } finally {
      setBusy(null);
    }
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;

    setBusy('import');
    try {
      const text = await file.text();
      let pen: unknown;
      try {
        pen = JSON.parse(text);
      } catch {
        throw new Error('File is not valid JSON');
      }
      const res = await fetch('/api/pen/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pen, documentId: 'demo', mode: 'replace' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      // Apply each returned patch through the store so it's undoable + broadcast.
      for (const patch of data.patches ?? []) {
        sendPatch(patch);
      }
      toast.success(`Imported ${file.name}`, {
        description: `${data.document?.shapes?.length ?? 0} nodes loaded from .pen`,
      });
    } catch (e: any) {
      toast.error('Import failed', { description: e?.message ?? 'Unknown error' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            title=".pen file (pen.dev format)"
            aria-label=".pen file menu"
            className="h-7 px-2 text-[11px] ac-text-3 hover:ac-text-1 hover:ac-surface-1 ac-transition ac-focus-ring gap-1.5"
          >
            <FileJson className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">.pen</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-[11px] ac-text-4 font-normal">
            pen.dev file format (.pen)
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleExport} className="gap-2 cursor-pointer">
            <Download className="h-3.5 w-3.5" />
            <span>Export as .pen</span>
            <span className="ml-auto text-[10px] ac-text-5">{document.shapes.length} nodes</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleImportClick} className="gap-2 cursor-pointer">
            <Upload className="h-3.5 w-3.5" />
            <span>Import .pen file…</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="px-2 py-1.5 text-[10px] ac-text-5 leading-relaxed">
            Open format compatible with pen.dev / pencil.dev.
            <a
              href="https://docs.pen.dev/for-developers/the-pen-format"
              target="_blank"
              rel="noreferrer"
              className="block mt-1 underline hover:ac-text-2"
            >
              View the .pen spec →
            </a>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pen,application/json,.json"
        onChange={handleFileSelected}
        className="hidden"
      />

      {busy && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-md ac-surface-0 border ac-border-default shadow-lg text-xs ac-text-2">
          {busy === 'export' ? (
            <>
              <Download className="h-3.5 w-3.5 animate-pulse" />
              <span>Exporting .pen…</span>
            </>
          ) : (
            <>
              <Upload className="h-3.5 w-3.5 animate-pulse" />
              <span>Importing .pen…</span>
            </>
          )}
        </div>
      )}
    </>
  );
}

// Re-export the icons for any consumer that wants the success/error styling.
export { CheckCircle2, AlertCircle };
