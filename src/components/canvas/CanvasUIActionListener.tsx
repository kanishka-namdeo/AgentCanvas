'use client';

// CanvasUIActionListener — the page-level React-state bridge for the
// OpenHands `canvas_ui_control` pattern (task impl-canvas-ui-tool).
//
// Architecture recap:
//   - Server-side: the agent calls `pen_canvas_ui_control`, which emits an
//     `agent:canvas_ui_action` SyncEvent through the plugin event bus.
//   - Wire: the runner forwards it; the canvas-sync server fans it out to
//     every viewer; the client's socket/SSE consumer feeds it to the
//     canvas store's `_onSync`.
//   - Client store: the `_onSync` case for `agent:canvas_ui_action` calls
//     `dispatchCanvasUIAction(action)` (from
//     `@/lib/canvas/canvas-ui-dispatcher`). That function performs the
//     DIRECT side-effects (store.select for shape selection, the existing
//     `ac:canvas-zoom` event for viewport fit) AND emits window
//     CustomEvents for things that need to flip local React state owned
//     by `src/app/app/page.tsx` (right-sidebar tab) or `AppMenu.tsx`
//     (Version History dialog open).
//
// This component is the bridge for the page-level React state. It mounts
// once inside the workspace, subscribes to those window CustomEvents on
// mount, and routes them to the page's existing setters via props. It
// renders nothing — it's a "headless" subscriber (the same pattern the
// page already uses for `agentcanvas:open-settings` / `:open-design-systems`).
//
// Why a separate component instead of a useEffect inside the page?
//   1. Additive-only wiring (the task's hard constraint): the page is
//      heavily edited in prior rounds. A single `<CanvasUIActionListener
//      onSetRightTab={setRightTab} onExpandChatPanel={expandChat} />`
//      mount in the JSX tree + one import statement is the smallest
//      possible change — no restructuring of the existing useEffects, no
//      new dependencies on the page's local refs (chatPanelRef etc.).
//   2. Cleanup: the subscription cleans up on unmount (the useEffect's
//      return). Hoisting it into a dedicated component keeps the cleanup
//      boundary tight and the page's effect list readable.
//
// The Version History dialog open (`agentcanvas:open-version-history`) is
// NOT routed through here — its state lives in AppMenu.tsx, so AppMenu
// subscribes directly. Routing it through this component would require a
// prop chain that crosses component boundaries AppMenu doesn't expose.

import { useEffect } from 'react';
import type { RightTab } from './RightToolsPanel';
import { CANVAS_UI_EVENT_CHANNELS } from '@/lib/canvas/canvas-ui-dispatcher';

export interface CanvasUIActionListenerProps {
  /// Switch the right sidebar to the named tab. The page owns `rightTab`
  /// (its useState); the dispatcher emits `set-right-tab` with the tab
  /// literal as `detail`. The listener also flips the page's
  /// `userPickedTabRef` so the page's auto-flip-to-properties-on-select
  /// behavior doesn't fight the agent's explicit tab choice.
  onSetRightTab: (tab: RightTab) => void;
  /// Expand the chat panel below the canvas. The page owns the panel's
  /// imperative ref + collapsed state; this callback wraps the page's
  /// toggle helper so the listener stays decoupled from `react-resizable-panels`.
  onExpandChatPanel: () => void;
}

/// Headless subscriber — renders null. Mount once near the page root.
export function CanvasUIActionListener(props: CanvasUIActionListenerProps) {
  const { onSetRightTab, onExpandChatPanel } = props;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onSetRightTabEvent = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as RightTab | undefined;
      // Defensive: if the dispatcher sent an unknown tab literal (e.g. a
      // stale event from a future code path), fall back to 'properties'
      // — the most common "show me what I made" tab.
      if (detail === 'layers' || detail === 'properties' || detail === 'design-systems' || detail === 'assets') {
        onSetRightTab(detail);
      } else {
        onSetRightTab('properties');
      }
    };
    const onExpandChat = () => {
      onExpandChatPanel();
    };

    window.addEventListener(CANVAS_UI_EVENT_CHANNELS.setRightTab, onSetRightTabEvent);
    window.addEventListener(CANVAS_UI_EVENT_CHANNELS.expandChatPanel, onExpandChat);
    return () => {
      window.removeEventListener(CANVAS_UI_EVENT_CHANNELS.setRightTab, onSetRightTabEvent);
      window.removeEventListener(CANVAS_UI_EVENT_CHANNELS.expandChatPanel, onExpandChat);
    };
  }, [onSetRightTab, onExpandChatPanel]);

  return null;
}
