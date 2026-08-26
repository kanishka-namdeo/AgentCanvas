'use client';

// PackTokensStyle — injects the active design-system pack's tokens.css
// into the canvas subtree as a `<style>` tag.
//
// WHY THIS EXISTS
// ───────────────
// The agent's system prompt (when a pack is pinned) tells the agent to
// reference CSS variables like `var(--color-accent)`, `var(--color-text-primary)`,
// `var(--radius-card)`, etc. For those references to resolve at render
// time, the pack's tokens.css MUST be live on the canvas root. This
// component fetches the tokens.css from `/api/design-systems/[name]/tokens`
// (a pre-rendered SSG `text/css` endpoint) and renders it inline.
//
// BEHAVIOR
// ────────
// - If no pack is chosen (activePack === null), renders nothing. The agent
//   runs as before (hardcoded hex / `$color.*` .pen variables).
// - If a pack is chosen, fetches its tokens.css on mount + whenever the
//   pack changes. Renders `<style data-ac-pack-tokens>{css}</style>`.
// - Stale-state safe: a `useReducer` model holds the (pack, css, error)
//   triple, and the effect dispatches FETCH_OK / FETCH_ERR on resolve.
//   The reducer compares the response's pack against the latest requested
//   pack, so a slow response from a superseded pack is discarded.
// - Errors are non-fatal: the canvas falls back to AgentCanvas's own
//   `--ac-*` chrome palette (defined in `globals.css`). The agent's
//   `var(--*)` references would then resolve to nothing (CSS treats an
//   unresolvable var as the property's initial value — usually
//   transparent / inherited), so we also log to console for debugging.
//
// PLACEMENT
// ─────────
// Mount this as a child of the canvas container — the `<style>` tag has
// no visual presence but its CSS variables cascade to the entire subtree,
// including the world container (`data-ac-world`) where the DOM renderer
// paints the agent's shapes.

import { useEffect, useReducer } from 'react';
import { useActivePack } from '@/hooks/use-active-pack';

// State machine — three shapes:
//   { phase: 'idle' }
//   { phase: 'loading', requestedPack: string }
//   { phase: 'loaded', pack: string, css: string }
//   { phase: 'error', pack: string, message: string }
type State =
  | { phase: 'idle' }
  | { phase: 'loading'; requestedPack: string }
  | { phase: 'loaded'; pack: string; css: string }
  | { phase: 'error'; pack: string; message: string };

type Action =
  | { type: 'fetch_start'; pack: string }
  | { type: 'fetch_ok'; pack: string; css: string }
  | { type: 'fetch_err'; pack: string; message: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'fetch_start':
      return { phase: 'loading', requestedPack: action.pack };
    case 'fetch_ok':
      // Stale-response guard: only commit if the response's pack matches
      // the latest requested pack.
      if (state.phase === 'loading' && state.requestedPack !== action.pack) {
        return state;
      }
      return { phase: 'loaded', pack: action.pack, css: action.css };
    case 'fetch_err':
      if (state.phase === 'loading' && state.requestedPack !== action.pack) {
        return state;
      }
      return { phase: 'error', pack: action.pack, message: action.message };
  }
}

export function PackTokensStyle() {
  const { pack: activePack } = useActivePack();
  const [state, dispatch] = useReducer(reducer, { phase: 'idle' } as State);

  useEffect(() => {
    if (!activePack) {
      // No pack — leave state as-is. When `activePack` becomes null after
      // being set, the render path below checks `activePack` directly so
      // stale state never produces a `<style>` tag for a pack that's no
      // longer active.
      return;
    }
    let cancelled = false;
    dispatch({ type: 'fetch_start', pack: activePack });
    fetch(`/api/design-systems/${encodeURIComponent(activePack)}/tokens`, {
      headers: { accept: 'text/css' },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        dispatch({ type: 'fetch_ok', pack: activePack, css: text });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        console.warn(
          `[PackTokensStyle] failed to load pack "${activePack}" tokens:`,
          err.message,
        );
        dispatch({ type: 'fetch_err', pack: activePack, message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [activePack]);

  // Render path:
  //   - no active pack → render null
  //   - state is 'loaded' for the SAME pack as `activePack` → render <style>
  //   - anything else (loading / error / stale) → render null
  if (!activePack) return null;
  if (state.phase !== 'loaded') return null;
  if (state.pack !== activePack) return null;
  return (
    <style
      data-ac-pack-tokens={state.pack}
      dangerouslySetInnerHTML={{ __html: state.css }}
    />
  );
}
