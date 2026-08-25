// Render the Task 8-b Vaultly canvas shapes to a clean frame-only PNG
// (no app chrome, no viewport cropping) and re-run the VLM critique on it.
//
// Usage: bun /home/z/my-project/scripts/render-final-canvas.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { renderCanvasToPng, renderCanvasToSvg } from '../src/lib/canvas/render-to-png';

const SHAPES_PATH = '/home/z/my-project/download/vaultly-final3-shapes.json';
const PNG_OUT = '/home/z/my-project/download/vaultly-final3-render.png';
const SVG_OUT = '/home/z/my-project/download/vaultly-final3-render.svg';

interface AnyShape {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  [key: string]: unknown;
}

async function main() {
  const raw = JSON.parse(readFileSync(SHAPES_PATH, 'utf-8')) as AnyShape[];

  // Task 8-c final render: the extracted store can contain TWO stacked
  // generations of the wireframe (pre-clear snapshot + the fresh run). The
  // newer generation lives in the upper zIndex half (>= 256). Split by
  // zIndex, then dedupe by id within the winning half.
  const zis = raw.map((s) => Number(s.zIndex ?? 0));
  const zMax = zis.length ? Math.max(...zis) : 0;
  const splitAt = zMax / 2;
  const upperHalf = raw.filter((s) => Number(s.zIndex ?? 0) >= splitAt);
  const lowerHalf = raw.filter((s) => Number(s.zIndex ?? 0) < splitAt);
  // Prefer the upper (newer) half when both halves are non-trivially sized.
  const candidates = upperHalf.length >= 32 ? upperHalf : raw;
  if (upperHalf.length >= 32 && lowerHalf.length >= 32) {
    console.log(`[render] generation split: lower=${lowerHalf.length} entries, upper=${upperHalf.length} entries — using UPPER (newer)`);
  }
  const byId = new Map<string, AnyShape>();
  for (const s of candidates) {
    const key = typeof s.id === 'string' ? s.id : JSON.stringify(s);
    if (!byId.has(key)) byId.set(key, s);
  }
  const shapes = Array.from(byId.values());
  console.log(`[render] raw=${raw.length} unique=${shapes.length}`);

  // Compute the bounding box of visible shapes to frame the design exactly.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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
  const pad = 24; // breathing room around the design frame
  const frameX = Math.max(0, Math.floor(minX - pad));
  const frameY = Math.max(0, Math.floor(minY - pad));
  const frameW = Math.ceil(maxX - minX + pad * 2);
  const frameH = Math.ceil(maxY - minY + pad * 2);
  console.log(`[render] bbox=(${minX.toFixed(0)},${minY.toFixed(0)})..(${maxX.toFixed(0)},${maxY.toFixed(0)}) frame=${frameW}x${frameH}`);

  // Shift shapes so the frame starts at 0,0 (keep relative positions).
  const shifted = shapes.map((s) => ({
    ...s,
    x: Number(s.x ?? 0) - frameX,
    y: Number(s.y ?? 0) - frameY,
  })) as Parameters<typeof renderCanvasToPng>[0];

  // Cap the render width at 1600 (fitTo doubles it → 3200 px PNG, plenty for the VLM).
  const maxW = 1600;
  const scale = frameW > maxW ? maxW / frameW : 1;
  const outW = Math.round(frameW * scale);
  const outH = Math.round(frameH * scale);
  const scaled = (scale === 1 ? shifted : shifted.map((s) => ({
    ...s,
    x: Number(s.x ?? 0) * scale,
    y: Number(s.y ?? 0) * scale,
    width: Number(s.width ?? 0) * scale,
    height: Number(s.height ?? 0) * scale,
    fontSize: s.fontSize != null ? Number(s.fontSize) * scale : undefined,
  }))) as typeof shifted;

  const png = await renderCanvasToPng(scaled, outW, outH);
  writeFileSync(PNG_OUT, png);
  console.log(`[render] wrote ${PNG_OUT} (${png.length.toLocaleString()} bytes, ${outW}x${outH} logical / ${outW * 2}x${outH * 2} px)`);

  writeFileSync(SVG_OUT, renderCanvasToSvg(scaled, outW, outH));
  console.log(`[render] wrote ${SVG_OUT}`);
}

main().catch((err) => {
  console.error('[render] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
