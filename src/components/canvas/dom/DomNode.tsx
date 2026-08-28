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

  // ---- Keyboard accessibility (Task 4d) -----------------------------------
  /// True when this node is a top-level shape (parentId == null). Only
  /// top-level shapes get `tabIndex={0}` so the browser's Tab order is the
  /// z-order of the canvas's roots (nested children inherit their parent's
  /// focus — putting every descendant in the tab order would overwhelm the
  /// keyboard user). Default false (recursed children always pass false).
  isTopLevel?: boolean;
  /// aria-busy="true" when the agent is mutating this shape. Composed by
  /// DomCanvas from the canvas store's `agentHighlightIds` set (the ids the
  /// agent most recently selected via canvas_select_shape — the closest
  /// per-shape "agent is working on this" signal we have without reading
  /// store.ts). `undefined` leaves the attribute off entirely.
  ariaBusy?: boolean;
  /// Optional screen-reader label override. Defaults to
  /// `${layer.name} (${layer.type})` when not supplied.
  ariaLabel?: string;
  /// Focus handlers — when a top-level shape receives focus (via Tab or
  /// programmatic .focus()), it becomes the active selection. The Canvas
  /// shell wires `onShapeFocus` to its `select()` action and tracks the
  /// focused id for the dashed focus-ring chrome overlay.
  onShapeFocus?: (id: string) => void;
  onShapeBlur?: (id: string) => void;
  /// Keydown handler attached to the shape's div. Used by Canvas.tsx to
  /// dispatch the Enter-to-edit-text flow on text shapes. Other keys (Tab,
  /// arrows, Escape) are handled by the window-level listeners (existing
  /// Phase 7 chords in Canvas.tsx + the nudge handler in page.tsx); we
  /// intentionally do NOT stopPropagation on those so the window listeners
  /// still see them.
  onShapeKeyDown?: (e: React.KeyboardEvent, shape: Layer) => void;
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
  isTopLevel = false,
  ariaBusy = false,
  ariaLabel,
  onShapeFocus,
  onShapeBlur,
  onShapeKeyDown,
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

  // VLM-exercise Fix 1: does any DIRECT child's absolute rect extend beyond
  // this container's rect? (0.5px tolerance for float rounding.) When it
  // does and the container doesn't clip, styleFor must NOT emit
  // content-visibility:auto — its inherent paint containment would clip the
  // overflowing children out of the render (Figma keeps overflow visible).
  const childOverflows =
    childLayers.length > 0 &&
    childLayers.some(
      (c) =>
        c.x < layer.x - 0.5 ||
        c.y < layer.y - 0.5 ||
        c.x + c.width > layer.x + layer.width + 0.5 ||
        c.y + c.height > layer.y + layer.height + 0.5,
    );

  const style = styleFor(layer, {
    relX: layer.x - parentX,
    relY: layer.y - parentY,
    nativeLayout: ownLayoutOpts ?? undefined,
    l4Culling: l4Culling ? true : undefined,
    childOverflows,
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
      // Task 4d — keyboard accessibility. Top-level shapes (parentId == null)
      // are the only ones in the browser's Tab order; nested children
      // inherit their parent's focus context (otherwise the Tab sequence
      // would balloon past every group/frame descendant). role="img" + a
      // composed aria-label give screen readers a stable description;
      // aria-busy flips true while the agent is mutating this shape (sourced
      // from the store's agentHighlightIds set in DomCanvas). The focus
      // handler syncs the active selection so keyboard + click selection
      // are equivalent.
      tabIndex={isTopLevel ? 0 : undefined}
      role="img"
      aria-label={ariaLabel ?? `${layer.name ?? layer.type} (${layer.type})`}
      aria-busy={ariaBusy || undefined}
      onFocus={onShapeFocus ? (e) => onShapeFocus(layer.id) : undefined}
      onBlur={onShapeBlur ? () => onShapeBlur(layer.id) : undefined}
      onKeyDown={onShapeKeyDown ? (e) => onShapeKeyDown(e, layer) : undefined}
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
              flows (flex item) or positions absolutely. Children are NEVER
              `isTopLevel` (only root shapes go in the browser Tab order), but
              they DO inherit the aria-busy flag + focus/keydown handlers so
              the agent's per-shape busy state + the Enter-to-edit-text flow
              work uniformly across the tree. */}
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
          isTopLevel={false}
          ariaBusy={ariaBusy}
          onShapeFocus={onShapeFocus}
          onShapeBlur={onShapeBlur}
          onShapeKeyDown={onShapeKeyDown}
          onShapeMouseDown={onShapeMouseDown}
          onHover={onHover}
        />
      ))}
    </div>
  );
});
