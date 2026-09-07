// render-dumped-canvas.ts — batch-render the canvas documents dumped by
// run-eval --dump-canvas=DIR into frame-fitted PNGs for VLM visual scoring.
//
// Mirrors render-ms-canvas.ts per file (same normalize → bbox → shift →
// scale → renderCanvasToPng pipeline), but processes a whole directory in
// one invocation so the complex-scenario eval flow stays a single command:
//
//   bun scripts/agent-eval/run-eval.ts --only=analytics-chart,... --dump-canvas=download/agent-eval/dumps
//   bun scripts/agent-eval/render-dumped-canvas.ts download/agent-eval/dumps download/agent-eval
//
// Output PNGs are named <id>-r<repeat>.png (dump file base name). Existing
// PNGs are overwritten.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderCanvasToPng } from '../../src/lib/canvas/render-to-png';
import { normalizeCanvas } from '../../src/lib/agent/runner-legacy';

interface AnyLayer {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  [key: string]: unknown;
}

async function renderOne(docPath: string, outPath: string): Promise<void> {
  const raw = JSON.parse(readFileSync(docPath, 'utf-8'));
  const doc = normalizeCanvas(raw);
  const shapes = (doc.shapes ?? []) as unknown as AnyLayer[];

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
  if (!Number.isFinite(minX)) throw new Error('no visible layers');

  const pad = 24;
  const frameX = Math.floor(minX - pad);
  const frameY = Math.floor(minY - pad);
  const frameW = Math.ceil(maxX - minX + pad * 2);
  const frameH = Math.ceil(maxY - minY + pad * 2);

  const shifted = shapes.map((s): AnyLayer => ({
    ...s,
    x: Number(s.x ?? 0) - frameX,
    y: Number(s.y ?? 0) - frameY,
  }));

  const maxW = 1600;
  const scale = frameW > maxW ? maxW / frameW : 1;
  const outW = Math.round(frameW * scale);
  const outH = Math.round(frameH * scale);
  const scaled = (scale === 1
    ? shifted
    : shifted.map((s): AnyLayer => ({
        ...s,
        x: Number(s.x ?? 0) * scale,
        y: Number(s.y ?? 0) * scale,
        width: Number(s.width ?? 0) * scale,
        height: Number(s.height ?? 0) * scale,
        fontSize: s.fontSize != null ? Number(s.fontSize) * scale : undefined,
      }))) as unknown as Parameters<typeof renderCanvasToPng>[0];

  const png = await renderCanvasToPng(scaled, outW, outH);
  writeFileSync(outPath, png);
  console.log(`[render] ${docPath} → ${outPath} (${shapes.length} layers, ${outW}x${outH} logical)`);
}

async function main() {
  const [, , inDir, outDir] = process.argv;
  if (!inDir || !outDir) {
    console.error('usage: bun scripts/agent-eval/render-dumped-canvas.ts <dump-dir> <png-out-dir>');
    process.exit(2);
  }
  if (!existsSync(inDir) || !statSync(inDir).isDirectory()) {
    console.error(`[render] dump dir not found: ${inDir}`);
    process.exit(2);
  }

  const files = readdirSync(inDir)
    .filter((f) => f.endsWith('.canvas.json'))
    .sort();
  if (files.length === 0) {
    console.error(`[render] no *.canvas.json files in ${inDir}`);
    process.exit(2);
  }

  let ok = 0;
  let failed = 0;
  for (const f of files) {
    const base = f.replace(/\.canvas\.json$/, '');
    const outPath = join(outDir, `${base}.png`);
    try {
      await renderOne(join(inDir, f), outPath);
      ok++;
    } catch (e) {
      console.error(`[render] FAILED ${f}: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }
  console.log(`[render] done: ${ok} rendered, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[render] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
