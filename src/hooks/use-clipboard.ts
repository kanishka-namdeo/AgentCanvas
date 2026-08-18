'use client';

// useClipboard — typed clipboard hook for shapes / colors / values / constraints.
//
// Wraps navigator.clipboard with a typed payload envelope so the canvas can
// distinguish "shape in clipboard" from "color in clipboard" when pasting.
// Falls back to localStorage when navigator.clipboard is unavailable
// (insecure context, older browsers, JSdom test env).
//
// Exposes:
//   copy(shapes: Shape[]) — copy shapes to clipboard
//   paste(opts?: { offset?: { dx: number; dy: number } }) — paste shapes,
//     offset defaults to +24 in both axes
//   cut(shapes: Shape[]) — copy + delete in one call
//   selectAll() — select every shape on the canvas
//   copyColor(hex) / pasteColor() — for color swatches (P1-15)
//   copyValue(n) / pasteValue() — for numeric inputs (P1-16)
//
// The hook is intentionally simple — it does not handle keyboard shortcuts
// directly. page.tsx wires ⌘C/V/X/A and calls into this hook.

import { useCallback, useRef } from 'react';
import { useCanvasStore } from '@/lib/canvas/store';
import type { Shape, CanvasPatch } from '@/lib/canvas/types';
import {
  serializeShapes,
  deserializeShapes,
  offsetShapes,
  type ClipboardPayload,
} from '@/lib/canvas/clipboard';

const LOCAL_STORAGE_KEY = 'ac:clipboard';

function readLocalStorage(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LOCAL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLocalStorage(value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, value);
  } catch {
    // Quota exceeded / private mode — ignore.
  }
}

async function readClipboard(): Promise<string | null> {
  // Prefer navigator.clipboard when available (secure context, modern browser).
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Permission denied or clipboard empty — fall through to localStorage.
    }
  }
  return readLocalStorage();
}

async function writeClipboard(value: string): Promise<void> {
  // Always write to localStorage as a fallback so the clipboard survives
  // page reloads / insecure contexts.
  writeLocalStorage(value);
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Permission denied — localStorage fallback is already in place.
    }
  }
}

export function useClipboard() {
  const sendPatch = useCanvasStore((s) => s.sendPatch);
  const select = useCanvasStore((s) => s.select);
  const getShapes = useRef<() => Shape[]>(undefined as unknown as () => Shape[]);

  // Bind getShapes lazily so tests can swap the store out.
  getShapes.current = () => useCanvasStore.getState().document.shapes ?? [];

  const copy = useCallback(async (shapes: Shape[]) => {
    if (shapes.length === 0) return;
    const payload: ClipboardPayload = { kind: 'shape', version: 1, shapes };
    await writeClipboard(serializeShapes(shapes));
  }, []);

  const paste = useCallback(async (opts?: { offset?: { dx: number; dy: number } }) => {
    const raw = await readClipboard();
    if (!raw) return;
    const shapes = deserializeShapes(raw);
    if (shapes.length === 0) return;
    const dx = opts?.offset?.dx ?? 24;
    const dy = opts?.offset?.dy ?? 24;
    const offset = offsetShapes(shapes, dx, dy, /* newIds */ true);
    const patch: CanvasPatch = {
      op: 'bulk_add',
      shapes: offset.map((s) => ({ ...s })),
      summary: `Pasted ${offset.length} shape(s)`,
    };
    sendPatch(patch);
    // Select the newly-pasted shapes.
    select(offset.map((s) => s.id));
  }, [sendPatch, select]);

  const cut = useCallback(async (shapes: Shape[]) => {
    if (shapes.length === 0) return;
    await copy(shapes);
    const patch: CanvasPatch = {
      op: 'remove',
      shapeIds: shapes.map((s) => s.id),
      summary: `Cut ${shapes.length} shape(s)`,
    };
    sendPatch(patch);
    select([]);
  }, [copy, sendPatch, select]);

  const selectAll = useCallback(() => {
    const all = getShapes.current();
    select(all.map((s) => s.id));
  }, [select]);

  // --- Color / value / constraints helpers (P1-15, P1-16, P1-19) ---
  // These are stubs today; the Properties panel right-click menus (P1 tier)
  // will wire them.

  const copyColor = useCallback(async (hex: string) => {
    const payload: ClipboardPayload = { kind: 'color', value: hex };
    await writeClipboard(JSON.stringify(payload));
  }, []);

  const pasteColor = useCallback(async (): Promise<string | null> => {
    const raw = await readClipboard();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.kind === 'color' && typeof parsed.value === 'string') {
        return parsed.value as string;
      }
    } catch { /* not a valid payload */ }
    return null;
  }, []);

  const copyValue = useCallback(async (n: number) => {
    const payload: ClipboardPayload = { kind: 'value', value: n };
    await writeClipboard(JSON.stringify(payload));
  }, []);

  const pasteValue = useCallback(async (): Promise<number | null> => {
    const raw = await readClipboard();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.kind === 'value' && typeof parsed.value === 'number') {
        return parsed.value as number;
      }
    } catch { /* not a valid payload */ }
    return null;
  }, []);

  return {
    copy,
    paste,
    cut,
    selectAll,
    copyColor,
    pasteColor,
    copyValue,
    pasteValue,
  };
}
