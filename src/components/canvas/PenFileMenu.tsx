// PenFile — export/import .pen (pen.dev) files.
//
// Exposes `usePenFile()`, a headless hook that provides:
//   - exportPen()   — downloads the current canvas as a .pen JSON file
//   - importPen()   — opens a file picker, parses, and applies the .pen file
//   - chrome        — the hidden <input type="file"> + busy overlay to render
//
// The working handlers were previously reachable ONLY via a persistent
// ".pen" dropdown in the header, while File → Open/Import/Export .pen were
// toast stubs telling the user to go use that other menu (two menus, one
// worked). UI-audit 2026-08-29: the header button is gone; the File menu
// now calls these handlers directly, so there is exactly one surface.
//
// Export calls POST /api/pen/export with the live CanvasDocument; the
// response is the .pen JSON which we turn into a Blob download.
// Import reads the chosen file client-side, JSON.parses it, and POSTs to
// /api/pen/import, which returns a list of CanvasPatch ops we apply via
// the canvas store (so it's undoable + broadcast over the WS service).

'use client';

import { useRef, useState } from 'react';
import { Download, Loader2, Upload } from 'lucide-react';
import { useCanvasStore } from '@/lib/canvas/store';
import { toast } from 'sonner';

export function usePenFile() {
  const canvasDoc = useCanvasStore((s) => s.document);
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);

  async function exportPen() {
    setBusy('export');
    try {
      const res = await fetch('/api/pen/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          document: canvasDoc,
          filename: (canvasDoc.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-'),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const filename = (canvasDoc.name || 'canvas').replace(/[^a-z0-9-_]+/gi, '-') + '.pen';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${filename}`, {
        description: `${canvasDoc.shapes.length} nodes → .pen format v2.17`,
      });
    } catch (e: any) {
      toast.error('Export failed', { description: e?.message ?? 'Unknown error' });
    } finally {
      setBusy(null);
    }
  }

  function importPen() {
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

  // Hidden <input> + transient busy overlay — render once at the app root
  // (always mounted, independent of panel/tab state).
  const chrome = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pen,application/json,.json"
        onChange={handleFileSelected}
        className="hidden"
      />

      {busy && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-md ac-surface-0 border ac-border-default shadow-lg text-xs ac-text-2">
          {/* Contract spinner: Loader2 animate-spin for control-level busy
              (the old pulsing ACTION ICON was the one off-pattern animation
              left in the busy zoo). */}
          {busy === 'export' ? (
            <>
              <Download className="h-3.5 w-3.5" />
              <Loader2 className="h-3.5 w-3.5 animate-spin ac-text-4" />
              <span>Exporting .pen…</span>
            </>
          ) : (
            <>
              <Upload className="h-3.5 w-3.5" />
              <Loader2 className="h-3.5 w-3.5 animate-spin ac-text-4" />
              <span>Importing .pen…</span>
            </>
          )}
        </div>
      )}
    </>
  );

  return { exportPen, importPen, chrome };
}
