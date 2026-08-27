// E2E smoke: exercise the icon pipeline through the REAL tool surface
// (pen_create_node / pen_search_icons), resolve the resulting document, and
// rasterize via the server render path (render-to-png + resvg) — the same
// path the VLM critic and pen_export_png use. Produces a PNG we can eyeball.
import { writeFileSync } from 'node:fs';
import { createCanvasTools, executeTool } from '../src/lib/agent/tools';
import type { CanvasToolContext } from '../src/lib/agent/tools';
import type { CanvasDocument, CanvasPatch, Shape } from '../src/lib/canvas/types';
import { applyPatchToCanvas } from '../src/lib/canvas/patch';
import { resolvePenTree } from '../src/lib/pen/resolve';
import { renderCanvasToPng, renderCanvasToSvg } from '../src/lib/canvas/render-to-png';

const doc: CanvasDocument = {
  id: 'doc-icon-smoke',
  name: 'IconSmoke',
  background: '#ffffff',
  version: '2.17',
  children: [],
  viewport: { zoom: 1, panX: 0, panY: 0 },
  shapes: [],
  tokens: { colors: [], textStyles: [] },
};
const patches: CanvasPatch[] = [];
const ctx: CanvasToolContext = {
  getShapes: () => doc.shapes,
  getTokens: () => doc.tokens,
  getDocument: () => doc,
  applyPatch: (p) => {
    patches.push(p);
    const next = applyPatchToCanvas(doc, p);
    doc.shapes = next.shapes;
    doc.tokens = next.tokens;
    doc.children = next.children;
    doc.variables = next.variables;
    doc.background = next.background;
    doc.viewport = next.viewport;
    return p;
  },
};
const tools = createCanvasTools(ctx);

async function run(name: string, args: Record<string, unknown>) {
  const r = await executeTool(tools, name, args as never);
  const first = (r.content ?? [])[0];
  const text = typeof first === 'string' ? first : first && typeof first === 'object' && 'text' in (first as Record<string, unknown>) ? String((first as { text?: string }).text) : '';
  console.log(`→ ${name}: ${r.isError ? 'ERROR' : 'ok'} — ${String(text).slice(0, 110).replace(/\n/g, ' | ')}`);
  return r;
}

async function main(): Promise<void> {
  // ---- Compose an icon showcase via the agent tools ---------------------------
  await run('pen_create_node', { type: 'rectangle', name: 'Panel', x: 40, y: 40, width: 720, height: 420, radius: 16, fill: '#ffffff', stroke: '#e2e8f0', strokeWidth: 1, shadow: { x: 0, y: 4, blur: 6, color: '#0000001a' } });
  await run('pen_create_node', { type: 'text', name: 'Title', x: 72, y: 72, width: 400, height: 32, text: 'Lucide Icon Nodes — end-to-end smoke', fontSize: 20, fontWeight: 700, textColor: '#0f172a' });

  // Feature tiles: tinted rect + centered icon + label (the ICON TILE recipe)
  const tiles: Array<[string, string, string, string]> = [
    ['zap', 'Instant', '#0ea5e9', '#f0f9ff'],
    ['lock', 'Secure', '#6366f1', '#eef2ff'],
    ['chart-column', 'Analytics', '#10b981', '#ecfdf5'],
    ['rocket', 'Launch', '#f59e0b', '#fffbeb'],
  ];
  let tx = 72;
  for (const [icon, label, color, tint] of tiles) {
    await run('pen_create_node', { type: 'rectangle', name: `Tile ${label}`, x: tx, y: 140, width: 150, height: 170, radius: 12, fill: tint, stroke: '#e2e8f0', strokeWidth: 1 });
    await run('pen_create_node', { type: 'icon', name: `Icon ${label}`, icon, x: tx + 51, y: 168, width: 48, height: 48, stroke: color, strokeWidth: 2 });
    await run('pen_create_node', { type: 'text', name: `Label ${label}`, x: tx + 10, y: 240, width: 130, height: 20, text: label, fontSize: 14, fontWeight: 600, textColor: '#0f172a', textAlign: 'center' });
    tx += 166;
  }

  // Icon + text rows at mixed sizes
  await run('pen_create_node', { type: 'text', name: 'RowsTitle', x: 72, y: 350, width: 300, height: 20, text: 'Mixed sizes & recoloring:', fontSize: 13, fontWeight: 600, textColor: '#64748b' });
  const rowIcons: Array<[string, string, number]> = [
    ['check', '#10b981', 20], ['x', '#ef4444', 20], ['eye', '#0f172a', 16], ['star', '#f59e0b', 24], ['heart', '#ef4444', 24], ['settings', '#64748b', 20], ['user', '#0f172a', 32], ['bell', '#6366f1', 20],
  ];
  let rx = 72;
  for (const [icon, color, size] of rowIcons) {
    await run('pen_search_icons', { icon, x: rx, y: 390, size, stroke: color });
    rx += size + 28;
  }

  // Search + place (query mode)
  await run('pen_search_icons', { query: 'password security', x: 640, y: 390, size: 24, stroke: '#0f172a' });

  // Unknown icon name → must fail with suggestions (no silent placeholder)
  const bad = await run('pen_create_node', { type: 'icon', icon: 'made-up-glyph', x: 0, y: 0 });
  if (!bad.isError) throw new Error('unknown icon name should have failed');

  // ---- Resolve + render ---------------------------------------------------------
  const layers: Shape[] = resolvePenTree(doc);
  const iconLayers = layers.filter((l) => l.type === 'icon');
  console.log(`\nresolved ${layers.length} layers, ${iconLayers.length} icon nodes:`);
  for (const ic of iconLayers) {
    console.log(`  ${ic.iconName} @(${ic.x},${ic.y}) ${ic.width}×${ic.height} stroke=${ic.stroke}`);
  }
  if (iconLayers.length < 12) throw new Error(`expected ≥12 icon layers, got ${iconLayers.length}`);

  const png = await renderCanvasToPng(layers, 800, 500);
  writeFileSync('download/lucide-icon-smoke.png', png);
  writeFileSync('download/lucide-icon-smoke.svg', renderCanvasToSvg(layers, 800, 500));
  console.log(`\nwrote download/lucide-icon-smoke.png (${(png.length / 1024).toFixed(1)} KB) + .svg`);
  console.log('E2E SMOKE PASSED');

}

main().catch((e) => { console.error(e); process.exit(1); });
