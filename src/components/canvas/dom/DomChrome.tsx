'use client';

// DomChrome — screen-space overlay for selection, resize handles, badges,
// agent-highlight pulses, and auto-layout indicators (spec §3.1 principle 5,
// §3.3). Everything here is CONSTANT-SIZE in screen pixels (an improvement on
// the SVG renderer's 1/zoom compensation) and positioned by converting canvas
// coordinates: sx = x * zoom + panX.
//
// The overlay root is pointer-events: none; individual resize handles
// re-enable pointer-events: auto. World nodes are NEVER re-rendered by
// selection/hover/zoom-chrome changes (spec §4.3).
//
// Root carries `data-ac-chrome` — the integration-test selector for
// chrome-level assertions (multi-select outline counts etc.).

import type { Layer, Shape } from '@/lib/canvas/types';
import { cursorForHandle, handlePosition, type ResizeHandle } from '../svg/ShapeRenderer';
import { MeasureOverlay } from './MeasureOverlay';

export interface DomChromeProps {
  /// Flat layer list (deduped) — the lookup table for selected/highlighted ids.
  layers: Layer[];
  selectedIds: string[];
  highlightIds: string[];
  hoveredId: string | null;
  viewport: { zoom: number; panX: number; panY: number };
  /// Phase 7 §H.2 measure overlay — pointer in canvas space (null when Alt
  /// not held OR pointer has left canvas). Mounted inside the chrome layer
  /// (screen-space, above the world tree, below the resize handles).
  pointerCanvas?: { x: number; y: number } | null;
  /// Phase 7 §H.2 measure overlay — true while Alt/Option is held. The
  /// Canvas shell sets this transiently via the store's setMeasureMode on
  /// keydown/keyup.
  measureMode?: boolean;
  onResizeHandleMouseDown: (e: React.MouseEvent, shape: Shape, handle: ResizeHandle) => void;
}

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const HANDLE_PX = 8;

export function DomChrome({
  layers,
  selectedIds,
  highlightIds,
  hoveredId,
  viewport,
  pointerCanvas,
  measureMode,
  onResizeHandleMouseDown,
}: DomChromeProps) {
  const { zoom, panX, panY } = viewport;
  const byId = new Map(layers.map((l) => [l.id, l]));
  const selectedSet = new Set(selectedIds);

  // canvas → screen conversion (spec §3.3 — same math the shell's
  // screenToCanvas inverts).
  const sx = (x: number) => x * zoom + panX;
  const sy = (y: number) => y * zoom + panY;

  const selectedLayers = selectedIds
    .map((id) => byId.get(id))
    .filter((l): l is Layer => !!l);
  const highlightedLayers = highlightIds
    .map((id) => byId.get(id))
    .filter((l): l is Layer => !!l);

  return (
    <div
      data-ac-chrome=""
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 10, // above the world tree
        overflow: 'visible',
      }}
    >
      {/* 1. Selection outlines (one per selected layer). */}
      {selectedLayers.map((l) => (
        <div
          key={`sel-${l.id}`}
          data-chrome-selection={l.id}
          style={{
            position: 'absolute',
            left: sx(l.x) - 1,
            top: sy(l.y) - 1,
            width: l.width * zoom + 2,
            height: l.height * zoom + 2,
            border: '1.5px solid var(--ac-canvas-selection)',
          }}
        />
      ))}

      {/* 2. Resize handles — handlePosition ported to screen space. */}
      {selectedLayers.map((l) =>
        HANDLES.map((h) => {
          const pos = handlePosition(l, h);
          return (
            <div
              key={`handle-${l.id}-${h}`}
              data-chrome-handle={h}
              style={{
                position: 'absolute',
                left: sx(pos.x) - HANDLE_PX / 2,
                top: sy(pos.y) - HANDLE_PX / 2,
                width: HANDLE_PX,
                height: HANDLE_PX,
                background: 'var(--ac-canvas-handle-fill)',
                border: '1px solid var(--ac-canvas-selection)',
                pointerEvents: 'auto',
                cursor: cursorForHandle(h),
              }}
              onMouseDown={(e) => onResizeHandleMouseDown(e, l, h)}
            />
          );
        }),
      )}

      {/* 3. Agent-highlight pulse (CSS keyframes ac-agent-pulse in globals.css). */}
      {highlightedLayers.map((l) => (
        <div
          key={`hl-${l.id}`}
          style={{
            position: 'absolute',
            left: sx(l.x) - 2,
            top: sy(l.y) - 2,
            width: l.width * zoom + 4,
            height: l.height * zoom + 4,
            border: '2px solid var(--ac-canvas-highlight)',
            animation: 'ac-agent-pulse 0.8s ease-in-out infinite',
          }}
        />
      ))}

      {/* 4a. Component-relationship badges (any layer carrying componentId):
              master → "M" (top-right), instance → "I" (top-right). */}
      {layers
        .filter((l) => l.componentId === l.id)
        .map((l) => (
          <div key={`badge-m-${l.id}`} style={cornerBadge(sx(l.x + l.width) - 14, sy(l.y) + 2, 12, 'var(--ac-canvas-component)')}>
            M
          </div>
        ))}
      {layers
        .filter((l) => l.componentId && l.componentId !== l.id)
        .map((l) => (
          <div key={`badge-i-${l.id}`} style={cornerBadge(sx(l.x + l.width) - 14, sy(l.y) + 2, 12, 'var(--ac-canvas-instance)')}>
            I
          </div>
        ))}

      {/* 4b. Node-TYPE badges (top-left): component "M", component_set "◇",
              instance "◆" — replaces the SVG renderer's inline badges. */}
      {layers
        .filter((l) => l.type === 'component' || l.type === 'component_set' || l.type === 'instance')
        .map((l) => (
          <div
            key={`badge-type-${l.id}`}
            style={cornerBadge(sx(l.x) + 4, sy(l.y) + 4, 16, l.type === 'instance' ? 'var(--ac-canvas-instance)' : 'var(--ac-canvas-component)', 11)}
          >
            {l.type === 'component' ? 'M' : l.type === 'component_set' ? '◇' : '◆'}
          </div>
        ))}

      {/* 5. Auto-layout indicator (dashed inner outline + "AL" pill). */}
      {layers
        .filter((l) => !!l.autoLayout && (l.type === 'frame' || l.type === 'group'))
        .map((l) => (
          <div key={`al-${l.id}`}>
            <div
              style={{
                position: 'absolute',
                left: sx(l.x) + 2,
                top: sy(l.y) + 2,
                width: l.width * zoom - 4,
                height: l.height * zoom - 4,
                border: '1px dashed var(--ac-canvas-autolayout)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: sx(l.x) + 4,
                top: sy(l.y) - 14,
                width: 36,
                height: 12,
                borderRadius: 2,
                background: 'var(--ac-canvas-autolayout)',
                color: 'var(--ac-canvas-handle-fill)',
                fontSize: 9,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              AL
            </div>
          </div>
        ))}

      {/* 6. Group dashed outline when selected or hovered (groups paint no
              inline outline of their own — see styleFor). */}
      {layers
        .filter((l) => l.type === 'group' && (selectedSet.has(l.id) || hoveredId === l.id))
        .map((l) => (
          <div
            key={`group-${l.id}`}
            style={{
              position: 'absolute',
              left: sx(l.x),
              top: sy(l.y),
              width: l.width * zoom,
              height: l.height * zoom,
              border: `1px dashed ${l.stroke || 'var(--ac-canvas-default-stroke)'}`,
            }}
          />
        ))}

      {/* 7. Phase 7 §H.2 measure overlay — Alt/Option hover distance
              redlines to nearby siblings + containing frame edges. Mounted
              at the END of the chrome so it paints above all other chrome
              elements (selection outlines, handles, badges). Screen-space
              SVG with pointer-events: none — never blocks canvas interaction.
              Only renders when Alt is held (measureMode) AND the pointer is
              over the canvas (pointerCanvas != null); MeasureOverlay itself
              additionally gates on selection.length > 0. */}
      {measureMode && pointerCanvas && (
        <MeasureOverlay
          pointerCanvas={pointerCanvas}
          layers={layers}
          selection={selectedIds}
          panX={panX}
          panY={panY}
          zoom={zoom}
        />
      )}
    </div>
  );
}

/// Constant-size badge div (screen space, non-interactive).
function cornerBadge(
  left: number,
  top: number,
  size: number,
  background: string,
  fontSize = 9,
): React.CSSProperties {
  return {
    position: 'absolute',
    left,
    top,
    width: size,
    height: size,
    background,
    color: 'var(--ac-canvas-handle-fill)',
    fontSize,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 2,
    pointerEvents: 'none',
  };
}
