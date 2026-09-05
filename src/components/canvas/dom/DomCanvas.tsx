'use client';

// DomCanvas — the DOM renderer's world container + chrome overlay coordinator
// (spec §3.2/§3.3). Rendered by the Canvas shell when settings.renderer ===
// 'dom'. Dual layout strategy (spec §3.4):
//
//   layoutMode 'parity' (default) — every node is absolutely positioned from
//   the resolver's flat `document.shapes` (Layer[]), exactly like the SVG
//   renderer: the DOM is a projection of the same numbers.
//
//   layoutMode 'native' (Phase 2) — the world tree is consumed from
//   `resolvePenTreeDetailed(document).tree` (the resolver's pre-flattening
//   tree: emitted Shape + SOURCE .pen node per entry). Containers whose .pen
//   `layout` is vertical/horizontal render as real CSS flexbox and the
//   browser is the layout authority; a ResizeObserver pool (./measure.ts)
//   reads real sizes back into the store's non-persisted `measuredBounds`
//   slice (spec §3.8).
//
// Structure:
//   <div pointer-events:none>              ← full-bleed wrapper
//     <div data-ac-world transform>        ← pan/zoom is the ONLY thing that
//       <DomNode …/> (recursive tree)         changes here (L1 compositor nav)
//     </div>
//     <DomChrome … />                      ← screen-space selection overlay
//   </div>
//
// The world div also PUBLISHES the document variables as `--acv-*` CSS
// custom properties (spec §3.6, both modes — paint-level, not layout-level)
// and carries `data-ac-theme` for CSS-side theme targeting.
//
// Tree building (useMemo):
//   parity — from `document.shapes`: dedupe by id (last-writer-wins), roots =
//     parentId null / missing parent (orphans render as roots so nothing
//     disappears vs SVG mode) / cycle-broken chains (defensive promote-to-root).
//   native — from the resolver tree directly (parent/child structure is
//     authoritative by construction; tree order == zIndex order per parent).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasDocument, Layer, Shape } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';
import { resolvePenTreeDetailed, type ResolvedTreeNode } from '@/lib/pen/resolve';
import { useCanvasStore } from '@/lib/canvas/store';
import type { ResizeHandle } from '../handleMath';
import { DomNode } from './DomNode';
import { DomChrome } from './DomChrome';
import { cssVariablesFor, worldThemeAttr } from './variables';
import { MeasuredBoundsPool } from './measure';
import {
  computeCullingDecision,
  viewportFromPanZoom,
  rootLayerRects,
} from './CullingCoordinator';

export interface DomCanvasProps {
  document: CanvasDocument;
  selectedIds: string[];
  highlightIds: string[];
  viewport: { zoom: number; panX: number; panY: number };
  /// Layout strategy (spec §3.4 dual mode): 'parity' (resolver absolute
  /// geometry — default, pixel-comparable with SVG) or 'native' (browser CSS
  /// flexbox for `layout ≠ 'none` containers + measured-bounds readback).
  layoutMode: 'parity' | 'native';
  /// Outline mode (spec Phase 7, ⌘⇧O): when true the world div carries
  /// `data-ac-outline` and globals.css strips fills to transparent + adds a
  /// 1px default-stroke outline on every [data-node-type] element. Text
  /// keeps its color. DOM-renderer-only feature.
  outlineMode?: boolean;
  /// Phase 4 L4 culling (spec §4.2): when true, container subtrees get
  /// `content-visibility: auto` + `contain` so the browser skips layout/paint
  /// for offscreen content. Caller (Canvas shell) computes this from
  /// settings.domCulling && settings.renderer === 'dom'. Default false keeps
  /// DomCanvas backward-compatible with callers that haven't been updated.
  l4Culling?: boolean;
  /// Phase 7 §H.2 measure overlay — pointer position in canvas space
  /// (null when Alt is not held OR the pointer has left the canvas).
  /// Threaded through to DomChrome which mounts <MeasureOverlay>.
  pointerCanvas?: { x: number; y: number } | null;
  /// Phase 7 §H.2 measure overlay — true while Alt/Option is held. The
  /// Canvas shell sets this transiently via the store's setMeasureMode on
  /// keydown/keyup. DomChrome renders the overlay only when this is true.
  measureMode?: boolean;
  onShapeMouseDown: (e: React.MouseEvent, shape: Shape) => void;
  onResizeHandleMouseDown: (e: React.MouseEvent, shape: Shape, handle: ResizeHandle) => void;

  // ---- Keyboard accessibility (Task 4d) -----------------------------------
  /// Set of ids the agent is currently mutating (sourced by the Canvas
  /// shell from `useCanvasStore(s => s.agentHighlightIds)`). Each match
  /// flips `aria-busy="true"` on the corresponding shape's DOM node so
  /// screen readers announce "busy" before the agent's patch lands.
  /// `agentHighlightIds` is the closest per-shape "agent is working on
  /// this" signal available without reading the store from this module —
  /// it's the ids the agent just selected via canvas_select_shape.
  agentBusyIds?: ReadonlySet<string>;
  /// Optional aria-label override per shape id. When absent, DomNode
  /// composes `${layer.name} (${layer.type})` from the layer itself — the
  /// common case.
  ariaLabelById?: Map<string, string>;
  /// Focus / blur handlers attached to every shape's DOM node.
  /// The Canvas shell wires `onShapeFocus` to its `select()` action so a
  /// keyboard-focused shape becomes the active selection (mirroring the
  /// click-to-select path). ALL key handling lives in the window-level
  /// listeners (Phase 7 chords in Canvas.tsx + nudge in page.tsx) — shape
  /// divs carry no per-node keydown handler (the old dead prop chain was
  /// removed; Canvas never provided it).
  onShapeFocus?: (id: string) => void;
  onShapeBlur?: (id: string) => void;
  /// The id of the shape that currently has DOM focus (tracked by the
  /// Canvas shell via onFocus/onBlur). When set, DomChrome renders a
  /// dashed focus ring overlay that's visually distinct from the solid
  /// selection outline (so keyboard focus ≠ mouse selection in screen
  /// reader + keyboard-only flows). Default null = no focus ring.
  focusedId?: string | null;
}

interface WorldTree {
  /// Deduped flat layers (lookup table + DomChrome input).
  layers: Layer[];
  /// Root-level nodes (effectiveParent === null).
  roots: Layer[];
  /// Effective-parent children index, zIndex-sorted per parent.
  childrenOf: Map<string, Layer[]>;
  /// Layer id → source .pen node (native mode; EMPTY in parity mode).
  penById: Map<string, PenChild>;
}

const EMPTY_CHILDREN: Layer[] = [];
const EMPTY_PEN_MAP: Map<string, PenChild> = new Map();

function buildWorld(shapes: Layer[]): WorldTree {
  // Dedupe by id — last-writer-wins, matching the SVG renderer's Map dance
  // (transient duplicate ids during bulk_add / sync races).
  const byId = new Map<string, Layer>();
  for (const s of shapes) byId.set(s.id, s);
  const layers = Array.from(byId.values());

  // Effective parent per node: null = render as root.
  const effectiveParent = new Map<string, string | null>();
  let cycleWarned = false;
  for (const s of layers) {
    const pid = s.parentId ?? null;
    if (pid == null) {
      effectiveParent.set(s.id, null);
      continue;
    }
    if (!byId.has(pid)) {
      // Orphan: parent pruned/moved elsewhere — keep the node visible as a
      // root (SVG mode would still paint it from the flat list).
      effectiveParent.set(s.id, null);
      continue;
    }
    // Cycle guard: walk the ancestor chain from pid upward with a visited
    // set; if any node repeats (including s itself) the chain is cyclic —
    // promote s (and every descendant hanging off the cycle) to root.
    const visited = new Set<string>([s.id]);
    let cur: string | null | undefined = pid;
    let cyclic = false;
    while (cur != null) {
      if (visited.has(cur)) {
        cyclic = true;
        break;
      }
      visited.add(cur);
      const p: Layer | undefined = byId.get(cur);
      if (!p) break; // chain leaves the known set (that node handles itself)
      cur = p.parentId ?? null;
    }
    if (cyclic) {
      effectiveParent.set(s.id, null);
      if (process.env.NODE_ENV !== 'production' && !cycleWarned) {
        cycleWarned = true;
        console.warn('[DomCanvas] parent-chain cycle detected — promoting affected nodes to roots');
      }
    } else {
      effectiveParent.set(s.id, pid);
    }
  }

  // Children index from EFFECTIVE parents (cycle-broken nodes never appear as
  // children, so DomNode recursion always terminates).
  const childrenOf = new Map<string, Layer[]>();
  for (const s of layers) {
    const pid = effectiveParent.get(s.id);
    if (pid == null) continue;
    const list = childrenOf.get(pid);
    if (list) list.push(s);
    else childrenOf.set(pid, [s]);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.zIndex - b.zIndex);
  }

  const roots = layers.filter((s) => effectiveParent.get(s.id) == null);
  return { layers, roots, childrenOf, penById: EMPTY_PEN_MAP };
}

/**
 * Native-mode world index from the resolver's pre-flattening tree. The walk
 * preserves emit order (parent before children — the same order `layers`
 * holds in parity mode). Tree children are already zIndex-ascending within
 * each parent (the resolver assigns zIndex depth-first). Duplicate ids in a
 * malformed .pen tree are NOT deduped here (the resolver tree is
 * authoritative by construction); last-writer-wins on the pen lookup.
 */
function buildWorldFromTree(tree: ResolvedTreeNode[]): WorldTree {
  const layers: Layer[] = [];
  const childrenOf = new Map<string, Layer[]>();
  const penById = new Map<string, PenChild>();
  const roots: Layer[] = [];
  const walk = (nodes: ResolvedTreeNode[], parentId: string | null) => {
    for (const tn of nodes) {
      layers.push(tn.layer);
      penById.set(tn.layer.id, tn.pen);
      if (parentId === null) {
        roots.push(tn.layer);
      } else {
        const list = childrenOf.get(parentId);
        if (list) list.push(tn.layer);
        else childrenOf.set(parentId, [tn.layer]);
      }
      walk(tn.children, tn.layer.id);
    }
  };
  walk(tree, null);
  return { layers, roots, childrenOf, penById };
}

export function DomCanvas({
  document,
  selectedIds,
  highlightIds,
  viewport,
  layoutMode,
  outlineMode,
  l4Culling,
  pointerCanvas,
  measureMode,
  onShapeMouseDown,
  onResizeHandleMouseDown,
  agentBusyIds,
  ariaLabelById,
  onShapeFocus,
  onShapeBlur,
  focusedId,
}: DomCanvasProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Native mode resolves from the full `document` (children + variables);
  // parity mode from the derived `document.shapes`. Both identities change on
  // every patch, so one memo with a mode-switched document dep covers both.
  const nativeDoc = layoutMode === 'native' ? document : null;
  const { layers, roots, childrenOf, penById } = useMemo(() => {
    if (nativeDoc) {
      // NOTE: no measuredBounds passed here deliberately — feeding the
      // readback into the renderer's own resolve would re-resolve on every
      // measurement. The store's recomputeDerived threads the hints instead
      // (spec §3.8: the cache never re-enters layout).
      const { tree } = resolvePenTreeDetailed(nativeDoc);
      return buildWorldFromTree(tree);
    }
    return buildWorld(document.shapes ?? []);
  }, [nativeDoc, document.shapes]);

  const getChildren = useCallback(
    (id: string) => childrenOf.get(id) ?? EMPTY_CHILDREN,
    [childrenOf],
  );
  const getPenNode = useCallback(
    (id: string) => penById.get(id),
    [penById],
  );
  const onHover = useCallback((id: string | null) => setHoveredId(id), []);

  // ---- Measured-bounds readback (spec §3.8, native mode only) ---------------
  // Parity geometry comes from the resolver — only native mode measures. The
  // pool no-ops entirely where ResizeObserver is unavailable (jsdom).
  const pool = useMemo(() => {
    if (layoutMode !== 'native') return null;
    return new MeasuredBoundsPool((id, bounds) => {
      useCanvasStore.getState().setMeasuredBounds(id, bounds);
    });
  }, [layoutMode]);

  useEffect(() => () => pool?.disconnect(), [pool]);

  // ---- World-element registration (client round-trips, Phase 3 M2-c) -------
  // ALWAYS register (both layout modes — parity rects stay valid): the
  // store's round-trip handlers use this element for screen→canvas-space
  // conversion (agent:computed_request) and html-to-image capture
  // (agent:screenshot_request). Cleared on unmount.
  const worldRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = worldRef.current;
    if (el) useCanvasStore.getState().setWorldElement(el);
    return () => {
      if (useCanvasStore.getState().worldElement === el) {
        useCanvasStore.getState().setWorldElement(null);
      }
    };
  }, []);

  // ---- Measured-bounds digest push (native mode only) ----------------------
  // Throttled 800ms trailing: every change to the store's measuredBounds
  // slice re-arms ONE timer; when it fires we push the whole digest to the
  // server (socket event + POST) so canvasSnapshot enrichment (§5.5) and
  // pen_bake_layout see fresh sizes. The selector runs unconditionally
  // (hooks rule); the GATE on layoutMode lives in the effect — parity mode
  // never writes measuredBounds (pool is null) so the digest stays {}.
  const boundsDigest = useCanvasStore((s) => s.measuredBounds);
  useEffect(() => {
    if (layoutMode !== 'native') return;
    if (Object.keys(boundsDigest).length === 0) return;
    const t = setTimeout(() => {
      useCanvasStore.getState().pushMeasuredBounds();
    }, 800);
    return () => clearTimeout(t);
  }, [boundsDigest, layoutMode]);

  const registerEl = useMemo(() => {
    if (!pool) return undefined;
    return (id: string, el: HTMLDivElement | null) => {
      if (el) pool.observe(el, id);
      else pool.unobserve(id);
    };
  }, [pool]);

  const { zoom, panX, panY } = viewport;

  // ---- Phase 4 L5 mount culling (spec §4.2) --------------------------------
  // Tracks a wrapper-ref + ResizeObserver so we know the canvas pixel size,
  // then computes a culling decision (viewport ∩ root rects ± margin +
  // hysteresis) whenever pan/zoom changes. Budget-aware: the coordinator
  // itself no-ops below 2000 nodes (L4 alone handles small documents).
  //   - During motion: rAF-throttled (one pass per frame max).
  //   - After motion stops: 150ms trailing debounce for the final decision.
  // The culled set is React state so a change triggers the roots.map swap
  // (placeholder div vs. full DomNode). Selected or hovered roots are
  // never culled (the user is actively interacting with them — placeholder
  // swap would lose selection chrome + measured bounds).
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [culledIds, setCulledIds] = useState<Set<string>>(new Set());
  const prevCulledRef = useRef<Set<string>>(culledIds);
  // rAF + debounce tokens live in refs so the effect cleanup can cancel them.
  const rafTokenRef = useRef<number | null>(null);
  const debounceTokenRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Canvas pixel size — updated by ResizeObserver on the wrapper div. Reads
  // as a ref so the pan/zoom effect (which reads it) doesn't re-arm on every
  // resize, only on pan/zoom changes.
  const canvasSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const [, forceCanvasSizeTick] = useState(0); // bump to re-run the culling effect after first measurement

  // Wrapper ResizeObserver — keep canvasSizeRef fresh + trigger one culling
  // pass when size changes (the viewport rect changes when the wrapper
  // changes, even at constant pan/zoom).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const w = Math.max(1, Math.floor(e.contentRect.width));
      const h = Math.max(1, Math.floor(e.contentRect.height));
      if (canvasSizeRef.current.w !== w || canvasSizeRef.current.h !== h) {
        canvasSizeRef.current = { w, h };
        forceCanvasSizeTick((n) => n + 1);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute culling decision on pan/zoom / canvas-size / root-set changes.
  // Reads refs (canvasSize, prevCulled) and the roots array; writes state
  // (culledIds) only when the decision changed (cheap no-op when nothing
  // crossed any margin — the common case during continuous pan).
  /* eslint-disable react-hooks/set-state-in-effect -- L5 culling syncs
     React state from external inputs (ResizeObserver measurements +
     pan/zoom from props). The setState call only fires when the decision
     actually changed, so cascading re-renders are bounded to one per
     margin-crossing event (rare during pan). */
  useEffect(() => {
    if (!l4Culling) {
      // Culling disabled — flush the set if it was non-empty.
      if (prevCulledRef.current.size > 0) {
        prevCulledRef.current = new Set();
        setCulledIds(new Set());
      }
      return;
    }
    const { w, h } = canvasSizeRef.current;
    if (w <= 0 || h <= 0) return; // not yet measured
    const vp = viewportFromPanZoom(panX, panY, zoom, w, h);
    const rects = rootLayerRects(roots);
    // Selection / hover immunity — never cull a root the user is interacting
    // with (placeholder swap would drop selection chrome + measured bounds).
    const immune = new Set<string>(selectedIds);
    if (hoveredId) immune.add(hoveredId);
    const filterableRects = rects.filter((r) => !immune.has(r.id));
    const nodeCount = layers.length;

    const run = () => {
      rafTokenRef.current = null;
      const decision = computeCullingDecision(vp, filterableRects, prevCulledRef.current, nodeCount);
      if (decision.changed) {
        prevCulledRef.current = decision.culledIds;
        setCulledIds(decision.culledIds);
      }
    };

    // Trailing debounce 150ms — the authoritative final decision after motion ends.
    if (debounceTokenRef.current) clearTimeout(debounceTokenRef.current);
    debounceTokenRef.current = setTimeout(run, 150);
    // rAF throttle during motion — at most one pass per frame, never blocking.
    if (rafTokenRef.current == null) {
      rafTokenRef.current =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(run)
          : (null as unknown as number);
    }

    return () => {
      if (debounceTokenRef.current) {
        clearTimeout(debounceTokenRef.current);
        debounceTokenRef.current = null;
      }
      if (rafTokenRef.current != null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafTokenRef.current);
        rafTokenRef.current = null;
      }
    };
  }, [l4Culling, panX, panY, zoom, roots, layers.length, selectedIds, hoveredId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Variable publishing (spec §3.6): every document variable becomes a
  // `--acv-*` custom property on the world container; token-bound nodes
  // reference them via var(--acv-…, resolvedFallback) in styleFor.
  const cssVars = useMemo(() => cssVariablesFor(document), [document]);

  return (
    <div
      ref={wrapperRef}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}
    >
      {/* World layer — pan/zoom is the only thing that changes here. */}
      <div
        ref={worldRef}
        data-ac-world=""
        data-ac-theme={worldThemeAttr(document)}
        data-ac-outline={outlineMode ? '' : undefined}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
          transformOrigin: '0 0',
          willChange: 'transform',
          ...cssVars,
        }}
      >
        {roots.map((layer) =>
          culledIds.has(layer.id) ? (
            // L5 placeholder — preserves geometry so pan/zoom + scroll math
            // stay correct while the subtree is unmounted. data-ac-placeholder
            // is the selector hook for tests + future "skip in computed read"
            // logic. data-node-id stays so pen_get_computed can recognize
            // culled subtrees and surface a hint instead of empty data.
            <div
              key={layer.id}
              data-ac-placeholder=""
              data-node-id={layer.id}
              data-node-type={layer.type}
              style={{
                position: 'absolute',
                left: `${layer.x}px`,
                top: `${layer.y}px`,
                width: `${layer.width}px`,
                height: `${layer.height}px`,
                zIndex: layer.zIndex,
                pointerEvents: 'auto',
              }}
            />
          ) : (
            <DomNode
              key={layer.id}
              layer={layer}
              childLayers={getChildren(layer.id)}
              parentX={0}
              parentY={0}
              getChildren={getChildren}
              layoutMode={layoutMode}
              penNode={getPenNode(layer.id)}
              parentDirection={null}
              getPenNode={getPenNode}
              registerEl={registerEl}
              l4Culling={l4Culling}
              // Task 4d — every root shape is keyboard-reachable (tabIndex=0
              // is set in DomNode only when isTopLevel=true; nested children
              // stay out of the tab order). The agent's per-shape busy
              // signal, the focus/blur/keydown cbs, and an optional aria
              // label override are passed through unchanged.
              isTopLevel
              ariaBusy={agentBusyIds?.has(layer.id) ?? false}
              ariaLabel={ariaLabelById?.get(layer.id)}
              onShapeFocus={onShapeFocus}
              onShapeBlur={onShapeBlur}
              onShapeMouseDown={onShapeMouseDown}
              onHover={onHover}
            />
          ),
        )}
      </div>
      {/* Chrome overlay — screen space, above the world. */}
      <DomChrome
        layers={layers}
        selectedIds={selectedIds}
        highlightIds={highlightIds}
        hoveredId={hoveredId}
        viewport={viewport}
        pointerCanvas={pointerCanvas}
        measureMode={measureMode}
        focusedId={focusedId}
        onResizeHandleMouseDown={onResizeHandleMouseDown}
      />
    </div>
  );
}
