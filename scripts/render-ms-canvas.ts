// Render a multishot eval canvas doc (`<scenario>-final-canvas.json`) to a
// frame-fitted 2x PNG for visual QA. Mirrors scripts/render-final-canvas.ts,
// but starts from a CanvasDocument dump instead of a raw shapes array: the
// doc is pushed through the SAME normalizeCanvas() path the eval uses
// (run-multishot.ts:476) so the derived shapes[] cache reflects the .pen tree
// (legacy flat docs get a tree built from shapes[] as well).
//
// Usage: bun scripts/render-ms-canvas.ts <canvas-doc.json> <out.png>
import { readFileSync, writeFileSync } from 'node:fs';
import { renderCanvasToPng } from '../src/lib/canvas/render-to-png';
import { normalizeCanvas } from '../src/lib/agent/runner-legacy';

interface AnyLayer {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  [key: string]: unknown;
}

async function main() {
  const [, , docPath, outPath] = process.argv;
  if (!docPath || !outPath) {
    console.error('usage: bun scripts/render-ms-canvas.ts <canvas-doc.json> <out.png>');
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(docPath, 'utf-8'));
  // Same normalize path the eval uses: resolves the .pen tree and rebuilds
  // the derived shapes[] cache of resolved render layers.
  const doc = normalizeCanvas(raw);
  const shapes = (doc.shapes ?? []) as AnyLayer[];
  console.log(`[render] ${docPath}: tree-children=${doc.children?.length ?? 0} resolved-layers=${shapes.length}`);

  // Bounding box over all visible layers.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of shapes) {
    if (s.visible === false) continue;
    const x = Number(s.x ?? 0);
    const y = Number(s.y ?? 0);
    const w = Number(s.width ?? 0);
    const h = Number(s.height ?? 0);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  if (!Number.isFinite(minX)) {
    console.error('[render] FAILED: no visible layers');
    process.exit(1);
  }

  const pad = 24; // margin around the design frame
  const frameX = Math.floor(minX - pad);
  const frameY = Math.floor(minY - pad);
  const frameW = Math.ceil(maxX - minX + pad * 2);
  const frameH = Math.ceil(maxY - minY + pad * 2);
  console.log(
    `[render] bbox=(${minX.toFixed(0)},${minY.toFixed(0)})..(${maxX.toFixed(0)},${maxY.toFixed(0)}) frame=${frameW}x${frameH}`,
  );

  // Shift layers so the frame starts at 0,0 (keep relative positions).
  const shifted = shapes.map((s) => ({
    ...s,
    x: Number(s.x ?? 0) - frameX,
    y: Number(s.y ?? 0) - frameY,
  }));

  // Cap logical width at 1600 (renderer doubles it → ≤3200 px PNG).
  const maxW = 1600;
  const scale = frameW > maxW ? maxW / frameW : 1;
  const outW = Math.round(frameW * scale);
  const outH = Math.round(frameH * scale);
  const scaled = (scale === 1
    ? shifted
    : shifted.map((s) => ({
        ...s,
        x: Number(s.x ?? 0) * scale,
        y: Number(s.y ?? 0) * scale,
        width: Number(s.width ?? 0) * scale,
        height: Number(s.height ?? 0) * scale,
        fontSize: s.fontSize != null ? Number(s.fontSize) * scale : undefined,
      }))) as Parameters<typeof renderCanvasToPng>[0];

  const png = await renderCanvasToPng(scaled, outW, outH);
  writeFileSync(outPath, png);
  console.log(
    `[render] wrote ${outPath} (${png.length.toLocaleString()} bytes, ${outW}x${outH} logical / ${outW * 2}x${outH * 2} px)`,
  );
}

main().catch((err) => {
  console.error('[render] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
