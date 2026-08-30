// R9c micro-benchmark: resolve a large doc repeatedly (the recomputeDerived
// hot path), then patch ONE deep node and re-resolve (the steady-state path).
import { resolvePenTreeDetailed, resolveCacheStats, __clearResolveCachesForTests } from '../src/lib/pen/resolve';
import { applyPatchToCanvas } from '../src/lib/canvas/patch';
import { createEmptyCanvasDocument } from '../src/lib/canvas/types';

function buildBigDoc(nodesPerFrame: number, frames: number) {
  const doc = createEmptyCanvasDocument('bench');
  const children: any[] = [];
  for (let f = 0; f < frames; f++) {
    const kids: any[] = [];
    for (let i = 0; i < nodesPerFrame; i++) {
      kids.push({ id: `t-${f}-${i}`, type: 'text', x: (i % 10) * 90, y: Math.floor(i / 10) * 30, width: 80, height: 20, content: `Label ${i}` });
    }
    children.push({ id: `frame-${f}`, type: 'frame', name: `F${f}`, x: f * 400, y: 0, width: 900, height: 600, children: kids });
  }
  return { ...doc, children } as any;
}

const doc = buildBigDoc(500, 10); // ~5010 nodes
__clearResolveCachesForTests();

// Warm-up resolve (cold: expands + emits everything).
let t0 = performance.now();
let r = resolvePenTreeDetailed(doc);
const coldMs = performance.now() - t0;
const total = r.layers.length;

// Steady state: same doc re-resolved (recomputeDerived on a no-op patch path
// still re-resolves; the cache should make this nearly free).
t0 = performance.now();
for (let i = 0; i < 10; i++) r = resolvePenTreeDetailed(doc);
const warmAvg = (performance.now() - t0) / 10;

// Steady state with a real patch: change ONE deep text node per patch.
let docv = doc;
t0 = performance.now();
for (let i = 0; i < 10; i++) {
  docv = applyPatchToCanvas(docv, { op: 'update', shapeId: `t-3-${i * 7}`, shape: { content: `Changed ${i}` } } as any);
  r = resolvePenTreeDetailed(docv);
}
const patchAvg = (performance.now() - t0) / 10;

console.log(JSON.stringify({
  nodes: total,
  coldMs: +coldMs.toFixed(1),
  warmAvgMs: +warmAvg.toFixed(2),
  patchApplyPlusResolveAvgMs: +patchAvg.toFixed(2),
  stats: { ...resolveCacheStats },
}, null, 2));
