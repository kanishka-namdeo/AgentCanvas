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
import type { ResizeHandle } from '../svg/ShapeRenderer';
import { DomNode } from './DomNode';
import { DomChrome } from './DomChrome';
import { cssVariablesFor, worldThemeAttr } from './variables';
import { MeasuredBoundsPool } from './measure';

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
  onShapeMouseDown: (e: React.MouseEvent, shape: Shape) => void;
  onResizeHandleMouseDown: (e: React.MouseEvent, shape: Shape, handle: ResizeHandle) => void;
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
  onShapeMouseDown,
  onResizeHandleMouseDown,
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

  // Variable publishing (spec §3.6): every document variable becomes a
  // `--acv-*` custom property on the world container; token-bound nodes
  // reference them via var(--acv-…, resolvedFallback) in styleFor.
  const cssVars = useMemo(() => cssVariablesFor(document), [document]);

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
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
        {roots.map((layer) => (
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
            onShapeMouseDown={onShapeMouseDown}
            onHover={onHover}
          />
        ))}
      </div>
      {/* Chrome overlay — screen space, above the world. */}
      <DomChrome
        layers={layers}
        selectedIds={selectedIds}
        highlightIds={highlightIds}
        hoveredId={hoveredId}
        viewport={viewport}
        onResizeHandleMouseDown={onResizeHandleMouseDown}
      />
    </div>
  );
}
