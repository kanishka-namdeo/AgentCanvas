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
import type { PenChild } from '@/lib/pen/types';
import { styleFor, nativeLayoutOptsFor } from './styleFor';
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

  // ---- Native CSS layout mode (spec §3.4, Phase 2) -------------------------
  /// 'parity' (default / undefined) = Phase-1 behavior, byte-for-byte: every
  /// node absolutely positioned from the resolver's geometry.
  layoutMode?: 'parity' | 'native';
  /// The SOURCE .pen node for this layer (native mode; undefined in parity —
  /// DomCanvas looks it up from the resolver tree's pen index).
  penNode?: PenChild;
  /// Parent's flex direction (native mode): 'vertical' | 'horizontal' when
  /// the parent renders as a CSS flex container, null otherwise (root or
  /// layout:'none' parent). This node is a FLOW child iff parentDirection is
  /// set AND its own `layoutPosition !== 'absolute'`.
  parentDirection?: 'vertical' | 'horizontal' | null;
  /// .pen node lookup for children (stable useCallback in DomCanvas).
  getPenNode?: (id: string) => PenChild | undefined;
  /// Measurement registration (native mode): DomCanvas's MeasuredBoundsPool
  /// observes the node div; called with null on unmount. Undefined in parity
  /// mode (no measurement — geometry comes from the resolver).
  registerEl?: (id: string, el: HTMLDivElement | null) => void;
  /// Phase 4 L4 culling (spec §4.2). When true, styleFor emits
  /// `content-visibility: auto` + `contain: layout style paint` +
  /// `contain-intrinsic-size` on container subtrees so the browser skips
  /// layout/paint for offscreen content. False (or undefined) = no L4
  /// emission. The flag flows down the recursive DomNode tree unchanged
  /// because every container is a candidate — the caller (DomCanvas)
  /// computes it once from settings + renderer mode + document size budget.
  l4Culling?: boolean;
}

export const DomNode = memo(function DomNode({
  layer,
  childLayers,
  parentX,
  parentY,
  getChildren,
  onShapeMouseDown,
  onHover,
  layoutMode,
  penNode,
  parentDirection,
  getPenNode,
  registerEl,
  l4Culling,
}: DomNodeProps) {
  // ---- Native layout mode decisions (spec §3.4) ----------------------------
  // A node is a flex CONTAINER when its own .pen layout is vertical/horizontal;
  // it is a flex ITEM (flow child) when its parent is a flex container and it
  // hasn't opted out via layoutPosition:'absolute'. Children of layout:'none'
  // parents (and roots) stay absolutely positioned from resolver geometry.
  const native = layoutMode === 'native';
  const ownLayoutOpts = native ? nativeLayoutOptsFor(penNode) : null;
  const isFlowChild =
    native &&
    parentDirection != null &&
    (penNode as { layoutPosition?: string } | undefined)?.layoutPosition !== 'absolute';

  const style = styleFor(layer, {
    relX: layer.x - parentX,
    relY: layer.y - parentY,
    nativeLayout: ownLayoutOpts ?? undefined,
    l4Culling: l4Culling ? true : undefined,
    flowChild: isFlowChild
      ? {
          penWidth: (penNode as { width?: unknown } | undefined)?.width,
          penHeight: (penNode as { height?: unknown } | undefined)?.height,
          parentDirection: parentDirection!,
        }
      : undefined,
  });
  const isInstance = !!layer.componentId && layer.componentId !== layer.id;

  return (
    <div
      ref={registerEl ? (el: HTMLDivElement | null) => registerEl(layer.id, el) : undefined}
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
      {/* (1) vector / image / icon / boolean content */}
      {(layer.type === 'path' ||
        layer.type === 'star' ||
        layer.type === 'polygon' ||
        layer.type === 'image' ||
        layer.type === 'icon' ||
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
              renderer's flat zIndex sort. In native mode children also carry
              the flex context: parentDirection tells each child whether it
              flows (flex item) or positions absolutely. */}
      {childLayers.map((child) => (
        <DomNode
          key={child.id}
          layer={child}
          childLayers={getChildren(child.id)}
          parentX={layer.x}
          parentY={layer.y}
          getChildren={getChildren}
          layoutMode={layoutMode}
          penNode={getPenNode?.(child.id)}
          parentDirection={ownLayoutOpts ? ownLayoutOpts.direction : null}
          getPenNode={getPenNode}
          registerEl={registerEl}
          l4Culling={l4Culling}
          onShapeMouseDown={onShapeMouseDown}
          onHover={onHover}
        />
      ))}
    </div>
  );
});
