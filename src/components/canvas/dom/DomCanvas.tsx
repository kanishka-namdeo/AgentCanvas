'use client';

// DomCanvas — the DOM renderer's world container + chrome overlay coordinator
// (spec §3.2/§3.3, Phase 1 parity mode). Rendered by the Canvas shell when
// settings.renderer === 'dom'.
//
// Structure:
//   <div pointer-events:none>              ← full-bleed wrapper
//     <div data-ac-world transform>        ← pan/zoom is the ONLY thing that
//       <DomNode …/> (recursive tree)         changes here (L1 compositor nav)
//     </div>
//     <DomChrome … />                      ← screen-space selection overlay
//   </div>
//
// Parity-mode geometry: every node is absolutely positioned from the
// resolver's flat `document.shapes` (Layer[]), exactly like the SVG renderer —
// the DOM is a projection of the same numbers (spec §3.4 parity mode).
//
// Tree building (useMemo per document.shapes):
//   - dedupe by id, last-writer-wins (matches the SVG renderer's loop)
//   - roots = parentId null OR parent missing (orphans render as roots so
//     nothing disappears vs SVG mode) OR parent-chain CYCLES (defensive
//     promote-to-root; cycles can't come from resolvePenTree but a corrupted
//     store must never infinite-loop the renderer)
//   - children index sorted by zIndex (DOM order + z-index mirror the SVG
//     flat sort)

import { useCallback, useMemo, useState } from 'react';
import type { CanvasDocument, Layer, Shape } from '@/lib/canvas/types';
import type { ResizeHandle } from '../svg/ShapeRenderer';
import { DomNode } from './DomNode';
import { DomChrome } from './DomChrome';

export interface DomCanvasProps {
  document: CanvasDocument;
  selectedIds: string[];
  highlightIds: string[];
  viewport: { zoom: number; panX: number; panY: number };
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
}

const EMPTY_CHILDREN: Layer[] = [];

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
  return { layers, roots, childrenOf };
}

export function DomCanvas({
  document,
  selectedIds,
  highlightIds,
  viewport,
  onShapeMouseDown,
  onResizeHandleMouseDown,
}: DomCanvasProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const { layers, roots, childrenOf } = useMemo(
    () => buildWorld(document.shapes ?? []),
    [document.shapes],
  );

  const getChildren = useCallback(
    (id: string) => childrenOf.get(id) ?? EMPTY_CHILDREN,
    [childrenOf],
  );
  const onHover = useCallback((id: string | null) => setHoveredId(id), []);

  const { zoom, panX, panY } = viewport;

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
      {/* World layer — pan/zoom is the only thing that changes here. */}
      <div
        data-ac-world=""
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
          transformOrigin: '0 0',
          willChange: 'transform',
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
