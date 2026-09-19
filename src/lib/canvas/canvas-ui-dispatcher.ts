// Client-side dispatcher for the OpenHands `canvas_ui_control` pattern
// (task impl-canvas-ui-tool).
//
// The agent calls `pen_canvas_ui_control` server-side; the tool emits an
// `agent:canvas_ui_action` SyncEvent (defined in canvas/types.ts) which
// flows through the runner → route → socket/SSE → every connected viewer's
// canvas store. The store's `_onSync` case for `agent:canvas_ui_action`
// calls `dispatchCanvasUIAction(action)` — THIS module — to perform the
// side-effects.
//
// What the dispatcher does:
//
//   focus_shape(shapeId)       — selects the shape on the canvas AND emits a
//                                window CustomEvent so the page can switch
//                                its right-sidebar React state to the
//                                Properties (Design) tab. Selection is done
//                                directly on the Zustand store (the same API
//                                the Canvas shell uses for click-to-select);
//                                tab switches go through window events
//                                because the right-tab state is local React
//                                state owned by src/app/app/page.tsx (the
//                                same pattern the page uses for
//                                `agentcanvas:open-settings`).
//
//   show_chat                  — emits a window CustomEvent that the page's
//                                CanvasUIActionListener catches to expand
//                                the chat panel (the AgentPanel component,
//                                docked below the canvas). The chat panel
//                                holds the streaming reply — expanding it
//                                while the agent streams keeps the user's
//                                eyes where the agent is writing.
//
//   show_history               — emits a window CustomEvent that AppMenu.tsx
//                                catches to open the VersionHistoryDialog
//                                (AgentCanvas has no History tab in the
//                                right sidebar — the dialog IS the snapshots
//                                timeline).
//
//   show_layers                — emits a window CustomEvent so the page
//                                switches the right-sidebar React state to
//                                the Layers tab.
//
//   zoom_to_selection(shapeId?) — selects the named shape (when provided) and
//                                re-uses the EXISTING `ac:canvas-zoom`
//                                CustomEvent (kind='selection') that the
//                                Canvas shell already listens to for the
//                                TopMenuBar View → Zoom to Selection action.
//                                Zero new zoom plumbing — the dispatcher
//                                just routes through the established channel.
//
// Why split the side-effects (direct store calls vs window CustomEvents)?
// AgentCanvas's right-tab state (`rightTab`) is local React state, not in
// the Zustand store — moving it would touch existing logic (the page's
// userPickedTabRef + auto-flip effect). The window-event bridge is the same
// pattern the page uses for the Settings dialog (`agentcanvas:open-settings`)
// and the Design-Systems picker, so the dispatcher stays additive: it can
// ONLY call store APIs that already exist + emit CustomEvents the page
// already listens to (or will, via CanvasUIActionListener).
//
// Server-acks-only: this module runs ONLY on the client. The tool on the
// server returns a success ack; the side-effect happens here when the event
// reaches each viewer. Multiple viewers all run the dispatcher in parallel.

import type { CanvasUIAction } from './types';

/// Window-CustomEvent channel names the dispatcher emits. Exported so the
/// page-level listeners (CanvasUIActionListener.tsx, AppMenu.tsx) can
/// subscribe without magic strings drifting out of sync.
export const CANVAS_UI_EVENT_CHANNELS = {
  /// Right-sidebar tab switch. `detail` is the RightTab literal
  /// ('layers' | 'properties' | 'design-systems' | 'assets'). Caught by
  /// CanvasUIActionListener → page's setRightTab.
  setRightTab: 'agentcanvas:set-right-tab',
  /// Expand the chat panel below the canvas. Caught by
  /// CanvasUIActionListener → page's chat-panel toggle.
  expandChatPanel: 'agentcanvas:expand-chat-panel',
  /// Open the Version History dialog (snapshots timeline). Caught by
  /// AppMenu.tsx → setVersionHistoryOpen(true).
  openVersionHistory: 'agentcanvas:open-version-history',
} as const;

/// SSR-safe window-dispatch: emit a CustomEvent on `window` when running in
/// the browser; no-op on the server (the dispatcher can theoretically be
/// imported by a server-side path during build, though in practice the
/// store's _onSync only fires client-side).
function emitWindowEvent(name: string, detail?: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
  } catch {
    // Defensive — a malformed event should never take the store's _onSync
    // handler down. The dispatcher is best-effort by design (UI nudge).
  }
}

/// Lazily import the canvas store to avoid a circular import:
/// `canvas-ui-dispatcher` → `store` → (everything). The store is loaded by
/// the time the dispatcher runs (the store's `_onSync` is the entry point),
/// but the static import would create a TS-level circular dependency
/// warning under `bunx tsc --noEmit` for some module-resolution modes.
/// Reading via `require` at call-time keeps the dispatcher pure-importable
/// from any test or path.
type CanvasStoreLike = {
  select: (ids: string[]) => void;
};

let _storeGetter: (() => CanvasStoreLike | null) | null = null;

/// Install the canvas-store accessor (called once from the store's _onSync
/// case OR via a dynamic require on first dispatch). Exposed primarily so
/// unit tests can stub the store without touching window globals.
export function _setCanvasStoreGetter(getter: (() => CanvasStoreLike | null) | null): void {
  _storeGetter = getter;
}

/// Resolve the canvas store. Falls back to a dynamic require when no getter
/// has been installed (the production path — the dispatcher module is
/// imported by the store, which would create a static cycle, so we read it
/// at call-time via a lazy require).
function getCanvasStore(): CanvasStoreLike | null {
  if (_storeGetter) return _storeGetter();
  // Lazy require — `@/lib/canvas/store` is the conventional path alias used
  // elsewhere in the codebase. We use a Function-wrapped require to keep the
  // import out of the static module graph (Next.js / webpack would otherwise
  // bundle the dispatcher with the store as a cycle).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./store') as { useCanvasStore?: CanvasStoreLike & { getState?: () => CanvasStoreLike } };
    if (mod.useCanvasStore && typeof mod.useCanvasStore.getState === 'function') {
      return mod.useCanvasStore.getState();
    }
  } catch {
    // fall through — no store available (e.g. dispatcher invoked in a
    // non-browser test context).
  }
  return null;
}

/// Dispatch one CanvasUIAction. Idempotent — the same action applied twice
/// re-selects the same shape / re-emits the same window event. The store's
/// `_onSync` is the ONLY caller in production (one per incoming
/// `agent:canvas_ui_action` SyncEvent).
///
/// Returns a short human-readable description of what was dispatched — the
/// store can log it under trace-level debugging without needing the action
/// shape.
export function dispatchCanvasUIAction(action: CanvasUIAction): string {
  switch (action.command) {
    case 'focus_shape': {
      const store = getCanvasStore();
      if (store) {
        store.select([action.shapeId]);
      }
      // Switch the right sidebar to the Properties (Design) tab so the
      // selected shape's inspector is visible. The CanvasUIActionListener
      // component on the page subscribes and calls setRightTab.
      emitWindowEvent(CANVAS_UI_EVENT_CHANNELS.setRightTab, 'properties');
      return `focus_shape: selected ${action.shapeId}, right tab → properties`;
    }

    case 'show_chat': {
      // Expand the chat panel below the canvas. The page's
      // CanvasUIActionListener subscribes and calls the panel-toggle helper.
      emitWindowEvent(CANVAS_UI_EVENT_CHANNELS.expandChatPanel);
      return 'show_chat: expanding chat panel';
    }

    case 'show_history': {
      // Open the Version History dialog (the snapshots timeline).
      // AppMenu.tsx owns the open state and subscribes to this event.
      emitWindowEvent(CANVAS_UI_EVENT_CHANNELS.openVersionHistory);
      return 'show_history: opening version history dialog';
    }

    case 'show_layers': {
      // Switch the right sidebar to the Layers tab.
      emitWindowEvent(CANVAS_UI_EVENT_CHANNELS.setRightTab, 'layers');
      return 'show_layers: right tab → layers';
    }

    case 'zoom_to_selection': {
      // When a shapeId is provided, select it first so the existing
      // 'selection' zoom-to-fit (which fits the viewport to the CURRENT
      // selection) targets the right shape. Without a shapeId, the
      // dispatcher zooms to whatever the user (or a prior focus_shape
      // command) already has selected.
      if (action.shapeId) {
        const store = getCanvasStore();
        if (store) {
          store.select([action.shapeId]);
        }
      }
      // Re-use the EXISTING `ac:canvas-zoom` CustomEvent channel that
      // the Canvas shell already listens to (TopMenuBar View → Zoom to
      // Selection fires the same event). kind='selection' fits the
      // viewport to the current selection — exactly the OpenHands
      // `zoom_to_selection` semantics.
      emitWindowEvent('ac:canvas-zoom', { kind: 'selection' });
      return `zoom_to_selection: fit viewport to ${action.shapeId ? `shape ${action.shapeId}` : 'current selection'}`;
    }

    default: {
      // Exhaustiveness guard — if a new command is added to
      // CanvasUIAction without a dispatcher case, TS narrows `action` to
      // `never` here and the compiler errors at build time.
      const _exhaustive: never = action;
      void _exhaustive;
      return `unknown command`;
    }
  }
}
