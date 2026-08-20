// Client-side export utilities — generate SVG / PNG / JSON / HTML / React / Tailwind
// from the current canvas document, WITHOUT going through the LLM agent.
//
// These mirror the logic in src/lib/agent/tools.ts (pen_export_svg, pen_export_png,
// pen_export_json, pen_copy_as_code) but run purely client-side so the user gets
// instant export with no LLM round-trip.
//
// All functions accept the resolved `Shape[]` (from canvas store) and return
// a string (or data URL). The caller handles the download / clipboard copy.

import type { Shape } from '@/lib/canvas/types';

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface ExportOptions {
  /// If provided, export only shapes inside this frame (by shape ID).
  frameId?: string;
}

/// Compute the bounding box of the given shapes and return the normalized shapes
/// (shifted so minX/minY = 0) plus the bounding-box dimensions.
function normalizeBounds(shapes: Shape[]): { shapes: Shape[]; w: number; h: number } | null {
  if (shapes.length === 0) return null;
  const minX = Math.min(...shapes.map((s) => s.x));
  const minY = Math.min(...shapes.map((s) => s.y));
  const maxX = Math.max(...shapes.map((s) => s.x + s.width));
  const maxY = Math.max(...shapes.map((s) => s.y + s.height));
  return {
    shapes: shapes.map((s) => ({ ...s, x: s.x - minX, y: s.y - minY })),
    w: maxX - minX,
    h: maxY - minY,
  };
}

/// Filter shapes to those inside a frame (by bounding box).
function filterByFrame(shapes: Shape[], frameId: string): Shape[] {
  const frame = shapes.find((s) => s.id === frameId);
  if (!frame) return shapes;
  return shapes.filter(
    (s) =>
      s.id !== frameId &&
      s.x >= frame.x &&
      s.y >= frame.y &&
      s.x + s.width <= frame.x + frame.width &&
      s.y + s.height <= frame.y + frame.height,
  );
}

/// Render a single shape as an SVG element string.
function shapeToSvg(s: Shape): string {
  const stroke = s.strokeWidth > 0 ? ` stroke="${s.stroke}" stroke-width="${s.strokeWidth}"` : '';
  switch (s.type) {
    case 'rectangle':
    case 'frame':
      return `  <rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.radius}" fill="${s.fill}"${stroke}/>`;
    case 'ellipse':
      return `  <ellipse cx="${s.x + s.width / 2}" cy="${s.y + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}" fill="${s.fill}"${stroke}/>`;
    case 'line':
      return `  <line x1="${s.x}" y1="${s.y}" x2="${s.x + s.width}" y2="${s.y + s.height}" stroke="${s.fill}" stroke-width="${Math.max(2, s.strokeWidth)}" stroke-linecap="round"/>`;
    case 'text':
      return `  <text x="${s.x}" y="${s.y + s.fontSize}" font-size="${s.fontSize}" fill="${s.textColor}" font-family="Inter, sans-serif">${escapeXml(s.text ?? '')}</text>`;
    case 'path':
      if (!s.points || s.points.length === 0) return '';
      const pts = s.points.map((p) => `${p.x},${p.y}`).join(' ');
      return s.closed
        ? `  <polygon points="${pts}" fill="${s.fill}"${stroke}/>`
        : `  <polyline points="${pts}" fill="none" stroke="${s.stroke}" stroke-width="${Math.max(2, s.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'image':
      return `  <image x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" href="${s.src ?? ''}"/>`;
    default:
      return '';
  }
}

/// Export the canvas as an SVG string.
export function exportSvg(allShapes: Shape[], opts: ExportOptions = {}): string | null {
  let shapes = opts.frameId ? filterByFrame(allShapes, opts.frameId) : allShapes;
  const norm = normalizeBounds(shapes);
  if (!norm) return null;
  const els = norm.shapes.map(shapeToSvg).filter(Boolean).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${norm.w}" height="${norm.h}" viewBox="0 0 ${norm.w} ${norm.h}">\n${els}\n</svg>`;
}

/// Export the canvas as an SVG data URL (can be used in <img> tags or downloaded as PNG).
export function exportPngDataUrl(allShapes: Shape[], opts: ExportOptions = {}): string | null {
  const svg = exportSvg(allShapes, opts);
  if (!svg) return null;
  // Use encodeURIComponent for broader compatibility than base64 (avoids btoa issues with Unicode).
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/// Export the canvas as a JSON string (the full canvas document).
export function exportJson(doc: unknown): string {
  return JSON.stringify(doc, null, 2);
}

/// Generate HTML / React / Tailwind code from the canvas shapes.
export function exportCode(
  allShapes: Shape[],
  framework: 'html' | 'react' | 'tailwind',
  opts: ExportOptions = {},
): string | null {
  let shapes = opts.frameId ? filterByFrame(allShapes, opts.frameId) : allShapes;
  const norm = normalizeBounds(shapes);
  if (!norm) return null;
  const els = norm.shapes.map((s) => {
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    const w = Math.round(s.width);
    const h = Math.round(s.height);
    if (s.type === 'text') {
      const fs = Math.round(s.fontSize);
      const text = escapeHtml(s.text ?? '');
      if (framework === 'tailwind') {
        return `    <span className="absolute" style={{ left: ${x}, top: ${y}, fontSize: ${fs}, color: '${s.textColor}', fontFamily: 'Inter,sans-serif' }}>${text}</span>`;
      }
      return `    <span style="position:absolute;left:${x}px;top:${y}px;font-size:${fs}px;color:${s.textColor};font-family:Inter,sans-serif">${text}</span>`;
    }
    const r = Math.round(s.radius);
    if (framework === 'tailwind') {
      const radiusCls = r > 0 ? ` rounded-[${r}px]` : '';
      const strokeCls = s.strokeWidth > 0 ? ` border-[${s.strokeWidth}px] border-[${s.stroke}]` : '';
      return `    <div className="absolute${radiusCls}${strokeCls}" style={{ left: ${x}, top: ${y}, width: ${w}, height: ${h}, background: '${s.fill}' }} />`;
    }
    const radius = r > 0 ? `;border-radius:${r}px` : '';
    const stroke = s.strokeWidth > 0 ? `;border:${s.strokeWidth}px solid ${s.stroke}` : '';
    return `    <div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${s.fill}${radius}${stroke}"></div>`;
  }).join('\n');
  const totalW = Math.round(norm.w);
  const totalH = Math.round(norm.h);
  if (framework === 'react') {
    return `export function CanvasExport() {\n  return (\n    <div style={{ position: 'relative', width: ${totalW}, height: ${totalH} }}>\n${els}\n    </div>\n  );\n}`;
  }
  return `<div style="position:relative;width:${totalW}px;height:${totalH}px">\n${els}\n</div>`;
}

/// Trigger a browser download of the given content.
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/// Copy text to the clipboard. Falls back to a textarea + execCommand for
/// browsers that don't support navigator.clipboard.
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy method.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
