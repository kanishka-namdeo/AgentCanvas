'use client';

// DomNode — memoized recursive renderer for ONE resolved Layer (spec §3.2,
// Phase 1 parity mode). Real DOM nesting replaces the SVG renderer's flat
// sibling list: children mount INSIDE their parent div, so CSS overflow
// clipping, z-order, and hit-testing come from the browser's own layout.
//
// DOM data-attribute contract (spec Appendix C) — every node div carries:
//   data-node-id     the layer id (instance clones carry their fresh ids)
//   data-node-type   the LayerType — the stable selector vocabulary for
//                    tests + future tools (pen_get_computed, serializeDom)
//   data-instance-of (instances only) the source componentId
//
// Chrome (selection/handles/badges/highlight) NEVER lives here — it renders
// in the screen-space DomChrome overlay so selection changes don't re-render
// the world tree (spec §4.3 memoization contract: selection/hover/highlight/
// zoom are not props that force re-renders here — only layer identity,
// children identity, and the stable callback props do).

import { memo } from 'react';
import type { Layer } from '@/lib/canvas/types';
import { styleFor } from './styleFor';
import { renderIsland } from './islands';

export interface DomNodeProps {
  layer: Layer;
  /// This node's children, pre-sorted by zIndex (parent computes via the
  /// children index owned by DomCanvas).
  childLayers: Layer[];
  /// Parent's ABSOLUTE x/y (root nodes pass 0,0). Passed as two numbers —
  /// not an object literal — so React.memo's shallow compare stays effective
  /// through re-renders.
  parentX: number;
  parentY: number;
  /// Children lookup (stable useCallback in DomCanvas) used for the
  /// recursive grandchild lists.
  getChildren: (id: string) => Layer[];
  onShapeMouseDown: (e: React.MouseEvent, shape: Layer) => void;
  onHover: (id: string | null) => void;
}

export const DomNode = memo(function DomNode({
  layer,
  childLayers,
  parentX,
  parentY,
  getChildren,
  onShapeMouseDown,
  onHover,
}: DomNodeProps) {
  const style = styleFor(layer, { relX: layer.x - parentX, relY: layer.y - parentY });
  const isInstance = !!layer.componentId && layer.componentId !== layer.id;

  return (
    <div
      data-node-id={layer.id}
      data-node-type={layer.type}
      data-instance-of={isInstance ? layer.componentId : undefined}
      style={style}
      // The shell's handler stopPropagation()s — nodes never bubble clicks
      // to the empty-canvas deselect path.
      onMouseDown={(e) => onShapeMouseDown(e, layer)}
      onMouseEnter={() => onHover(layer.id)}
      onMouseLeave={() => onHover(null)}
    >
      {/* (1) vector / image / boolean content */}
      {(layer.type === 'path' ||
        layer.type === 'star' ||
        layer.type === 'polygon' ||
        layer.type === 'image' ||
        layer.type === 'boolean_operation') &&
        renderIsland(layer)}

      {/* (2) text content */}
      {layer.type === 'text' ? layer.text : null}

      {/* slice label (SVG parity: "⌖ slice" tag, top-left) */}
      {layer.type === 'slice' && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--ac-canvas-autolayout)',
            padding: '2px 4px',
            pointerEvents: 'none',
          }}
        >
          ⌖ slice
        </span>
      )}

      {/* section label chip (SVG parity: chip above the top-left corner;
          overflow stays visible on the section div so the -10px chip shows) */}
      {layer.type === 'section' && (
        <div
          style={{
            position: 'absolute',
            left: 8,
            top: -10,
            padding: '2px 8px',
            fontSize: 11,
            fontWeight: 600,
            background:
              layer.fill === 'transparent' ? 'var(--ac-canvas-bg)' : layer.fill,
            borderRadius: 4,
            color: layer.stroke || 'var(--ac-canvas-default-text)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {layer.label ?? layer.name ?? 'Section'}
        </div>
      )}

      {/* (3) recursive children — DOM order + zIndex CSS mirror the SVG
              renderer's flat zIndex sort */}
      {childLayers.map((child) => (
        <DomNode
          key={child.id}
          layer={child}
          childLayers={getChildren(child.id)}
          parentX={layer.x}
          parentY={layer.y}
          getChildren={getChildren}
          onShapeMouseDown={onShapeMouseDown}
          onHover={onHover}
        />
      ))}
    </div>
  );
});
