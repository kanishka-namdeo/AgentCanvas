'use client';

// Client hook for the Design-System Registry.
//
// Wraps `fetch('/api/design-systems')` and
// `fetch('/api/design-systems/[name]')` with module-level shared
// state (classic observer pattern, same as `useModelCatalog`).
// This avoids `setState` inside `useEffect` (the react-hooks lint
// rule) and lets multiple components share one fetch.

import { useCallback, useEffect, useState } from 'react';
import type { PackSummary, PackDetail } from '@/lib/design-systems/types';

// ── Shared list state ───────────────────────────────────────────────

interface ListState {
  packs: PackSummary[];
  loading: boolean;
  error: string | null;
}

let listShared: ListState = { packs: [], loading: false, error: null };
const listListeners = new Set<() => void>();
let listInFlight = false;

function notifyList() {
  for (const l of listListeners) l();
}

function setListShared(patch: Partial<ListState>) {
  listShared = { ...listShared, ...patch };
  notifyList();
}

async function fetchList(force = false) {
  if (listInFlight) return;
  if (!force && listShared.packs.length > 0) return; // already have data
  listInFlight = true;
  setListShared({ loading: true, error: null });

  // Try sessionStorage first (instant open, no flash).
  const cacheKey = 'design-systems:list';
  if (typeof window !== 'undefined') {
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as PackSummary[];
        setListShared({ packs: parsed, loading: false, error: null });
      }
    } catch {
      // sessionStorage unavailable / parse error — fall through to fetch.
    }
  }

  try {
    const r = await fetch('/api/design-systems');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { packs: PackSummary[] };
    setListShared({ packs: data.packs, loading: false, error: null });
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify(data.packs));
      } catch {
        // Quota exceeded — not fatal.
      }
    }
  } catch (err: unknown) {
    setListShared({
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    listInFlight = false;
  }
}

export function useDesignSystems(): ListState & { refetch: () => void } {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listListeners.add(l);
    return () => {
      listListeners.delete(l);
    };
  }, []);

  // Auto-fetch on first subscriber.
  useEffect(() => {
    if (!listInFlight && listShared.packs.length === 0 && !listShared.error) {
      void fetchList();
    }
  }, []);

  const refetch = useCallback(() => {
    void fetchList(true);
  }, []);

  return { ...listShared, refetch };
}

// ── Shared detail state (keyed by pack name) ────────────────────────

interface DetailState {
  pack: PackDetail | null;
  loading: boolean;
  error: string | null;
}

const detailCache = new Map<string, DetailState>();
const detailListeners = new Set<(name: string) => void>();
const detailInFlight = new Set<string>();

function notifyDetail(name: string) {
  for (const l of detailListeners) l(name);
}

function setDetailCache(name: string, patch: Partial<DetailState>) {
  const prev = detailCache.get(name) ?? { pack: null, loading: false, error: null };
  detailCache.set(name, { ...prev, ...patch });
  notifyDetail(name);
}

async function fetchDetail(name: string) {
  if (detailInFlight.has(name)) return;
  if (detailCache.has(name) && detailCache.get(name)!.pack) return; // have it
  detailInFlight.add(name);
  setDetailCache(name, { loading: true, error: null });
  try {
    const r = await fetch(`/api/design-systems/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { pack: PackDetail };
    setDetailCache(name, { pack: data.pack, loading: false, error: null });
  } catch (err: unknown) {
    setDetailCache(name, {
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    detailInFlight.delete(name);
  }
}

export function usePackDetail(name: string | null): DetailState {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!name) return;
    const l = (changed: string) => {
      if (changed === name) bump((n) => n + 1);
    };
    detailListeners.add(l);
    return () => {
      detailListeners.delete(l);
    };
  }, [name]);

  useEffect(() => {
    if (!name) return;
    if (!detailCache.has(name) && !detailInFlight.has(name)) {
      void fetchDetail(name);
    }
  }, [name]);

  if (!name) return { pack: null, loading: false, error: null };
  return detailCache.get(name) ?? { pack: null, loading: true, error: null };
}

// ── Active-pack persistence (localStorage + cross-tab sync) ─────────

const ACTIVE_PACK_KEY = 'design-systems:active-pack';

export function getActivePack(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACTIVE_PACK_KEY);
}

export function setActivePack(name: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ACTIVE_PACK_KEY, name);
  // Dispatch a global event so any listener (e.g. the canvas) can react.
  window.dispatchEvent(new CustomEvent('design-system:change', { detail: { name } }));
}

export function clearActivePack(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(ACTIVE_PACK_KEY);
  window.dispatchEvent(new CustomEvent('design-system:change', { detail: { name: null } }));
}
