'use client';

// OverlayLayer — renders all registered overlay utils in zIndex order.
//
// Mounted inside DomChrome (the screen-space chrome overlay layer) so
// registered overlays inherit the same stacking context (zIndex 10) and
// pointer-events: none baseline as the built-in overlays. Each registered
// overlay renders as a sibling absolute-positioned div — they paint in
// zIndex order (lower first), so the registry's sort order matches paint
// order.
//
// 2026-09-19 (competitor-research round 3 — tldraw pattern 6.2).

import { useMemo } from 'react';
import {
  listOverlayUtils,
  type OverlayUtilProps,
} from './overlay-registry';

export interface OverlayLayerProps extends OverlayUtilProps {
  /// Whether to render registered overlays at all. DomChrome sets this to
  /// false during heavy camera animations to keep the chrome layer
  /// cheap (mirrors tldraw's MovingCameraHitTestBlocker pattern).
  enabled?: boolean;
}

export function OverlayLayer(props: OverlayLayerProps) {
  const { enabled = true, ...rest } = props;
  const utils = useMemo(() => listOverlayUtils(), []);
  if (!enabled || utils.length === 0) return null;
  return (
    <>
      {utils.map((util) => {
        // Skip overlays whose isActive gate returns false.
        if (util.isActive && !util.isActive(rest)) return null;
        const { Body } = util;
        return (
          <div
            key={util.id}
            data-ac-overlay={util.id}
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              zIndex: util.zIndex,
            }}
          >
            <Body {...rest} />
          </div>
        );
      })}
    </>
  );
}
