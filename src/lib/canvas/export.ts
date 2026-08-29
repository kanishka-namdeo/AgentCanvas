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
import { serializeNodes } from './serialize';
import { lucideIconGroupSvg } from '@/lib/icons';

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface ExportOptions {
  /// If provided, export only shapes inside this frame (by shape ID).
  frameId?: string;
  /// Rasterization scale for PNG export (default 2 = 2x resolution).
  scale?: number;
}

/// Compute the bounding box of the given shapes and return the normalized shapes
/// (shifted so minX/minY = 0) plus the bounding-box dimensions.
function normalizeBounds(shapes: Shape[]): { shapes: Shape[]; w: number; h: number } | null {
  if (shapes.length === 0) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of shapes) {
    xs.push(s.x, s.x + s.width);
    ys.push(s.y, s.y + s.height);
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    shapes: shapes.map((s) => ({ ...s, x: s.x - minX, y: s.y - minY })),
    w: maxX - minX,
    h: maxY - minY,
  };
}

/// Filter shapes to those inside a frame.
///
/// Tree-based first (Figma semantics: a frame exports its descendants), with a
/// bounding-box fallback for frames that have no tree children. Previously this
/// was bbox-ONLY, which silently dropped any child that crossed the frame's
/// edge — a card peeking out of its container vanished from the export.
function filterByFrame(shapes: Shape[], frameId: string): Shape[] {
  const frame = shapes.find((s) => s.id === frameId);
  if (!frame) return shapes;
  const descendants = collectDescendants(shapes, frameId);
  if (descendants.length > 0) {
    return [frame, ...descendants];
  }
  // Fallback: bbox containment (no tree children — e.g. a loose rectangle used
  // as an export region).
  return shapes.filter(
    (s) =>
      s.id !== frameId &&
      s.x >= frame.x &&
      s.y >= frame.y &&
      s.x + s.width <= frame.x + frame.width &&
      s.y + s.height <= frame.y + frame.height,
  );
}

/// All strictly-descendant shapes of `rootId` per the resolved parentId links.
function collectDescendants(shapes: Shape[], rootId: string): Shape[] {
  const byParent = new Map<string, Shape[]>();
  for (const s of shapes) {
    const p = s.parentId ?? null;
    if (p) {
      const list = byParent.get(p) ?? [];
      list.push(s);
      byParent.set(p, list);
    }
  }
  const out: Shape[] = [];
  const queue = [rootId];
  const seen = new Set<string>([rootId]);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const child of byParent.get(id) ?? []) {
      if (seen.has(child.id)) continue; // defensive: cycle guard
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/// SVG defs + paint attributes for a shape's gradient / shadow / opacity.
/// Returns { defs, attrs } to splice into the element string.
function paintAttrs(s: Shape, uid: string): { defs: string[]; attrs: string } {
  const defs: string[] = [];
  let attrs = '';
  if (s.opacity !== undefined && s.opacity < 1) {
    attrs += ` opacity="${s.opacity}"`;
  }
  if (s.gradient && s.gradient.stops?.length >= 2) {
    const gid = `grad-${uid}`;
    const stops = s.gradient.stops
      .map((st) => `<stop offset="${st.offset}" stop-color="${st.color}"/>`)
      .join('');
    if (s.gradient.type === 'radial') {
      defs.push(`<radialGradient id="${gid}">${stops}</radialGradient>`);
    } else {
      defs.push(`<linearGradient id="${gid}" gradientTransform="rotate(${s.gradient.angle ?? 90} .5 .5)">${stops}</linearGradient>`);
    }
    attrs += ` fill="url(#${gid})"`;
  }
  if (s.shadow && (s.shadow.y !== 0 || s.shadow.blur > 0 || s.shadow.x !== 0)) {
    const fid = `shadow-${uid}`;
    const sc = s.shadow.color ?? '#0000001a';
    // 8-digit hex (#RRGGBBAA) needs splitting for SVG's rgba() syntax.
    let rgba = sc;
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})$/i.exec(sc);
    if (m) {
      const a = parseInt(m[2], 16) / 255;
      const r = parseInt(m[1].slice(0, 2), 16);
      const g = parseInt(m[1].slice(2, 4), 16);
      const b = parseInt(m[1].slice(4, 6), 16);
      rgba = `rgba(${r},${g},${b},${Number(a.toFixed(3))})`;
    }
    defs.push(
      `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%">` +
      `<feDropShadow dx="${s.shadow.x ?? 0}" dy="${s.shadow.y ?? 0}" stdDeviation="${(s.shadow.blur ?? 0) / 2}" flood-color="${rgba}"/>` +
      `</filter>`,
    );
    attrs += ` filter="url(#${fid})"`;
  }
  // Audit 4 C5 (rotation convention): the DOM renderer rotates CLOCKWISE
  // around the TOP-LEFT corner (transform-origin: 0 0). The export paths used
  // to rotate around the CENTER — so any rotated layer changed shape between
  // canvas and export. All three painters (DOM, SVG export, server render)
  // now share the clockwise/top-left convention.
  if (s.rotation) {
    attrs += ` transform="rotate(${s.rotation} ${s.x} ${s.y})"`;
  }
  return { defs, attrs };
}

function starPoints(s: Shape): string {
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const outer = Math.min(s.width, s.height) / 2;
  const inner = outer * (s.innerRadiusRatio ?? 0.5);
  const n = Math.max(3, s.pointCount ?? 5);
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / n - Math.PI / 2;
    pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
  }
  return pts.join(' ');
}

function polygonPoints(s: Shape): string {
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const r = Math.min(s.width, s.height) / 2;
  const n = Math.max(3, s.polygonCount ?? 6);
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n - Math.PI / 2;
    pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
  }
  return pts.join(' ');
}

/// Render a single shape as an SVG element string (+ any defs it needs).
function shapeToSvg(s: Shape, uid: string): { el: string; defs: string[] } {
  const stroke = s.strokeWidth > 0 ? ` stroke="${s.stroke}" stroke-width="${s.strokeWidth}"` : '';
  const { defs, attrs } = paintAttrs(s, uid);
  // When a gradient/shadow is present the paint attrs already carry
  // fill/filter; otherwise use the solid fill.
  const fill = attrs.includes('fill=') ? '' : ` fill="${s.fill}"`;
  const base = `${fill}${stroke}${attrs}`;
  switch (s.type) {
    case 'rectangle':
    case 'frame':
    case 'section':
    case 'component':
    case 'component_set':
      return { el: `  <rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.radius}"${base}/>`, defs };
    case 'ellipse':
      return { el: `  <ellipse cx="${s.x + s.width / 2}" cy="${s.y + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}"${base}/>`, defs };
    case 'line':
      return { el: `  <line x1="${s.x}" y1="${s.y}" x2="${s.x + s.width}" y2="${s.y + s.height}" stroke="${s.fill}" stroke-width="${Math.max(2, s.strokeWidth)}" stroke-linecap="round"${attrs}/>`, defs };
    case 'text':
      return { el: `  <text x="${s.x}" y="${s.y + s.fontSize}" font-size="${s.fontSize}" fill="${s.textColor}" font-family="Inter, sans-serif"${attrs}>${escapeXml(s.text ?? '')}</text>`, defs };
    case 'path':
      if (!s.points || s.points.length === 0) return { el: '', defs };
      const pts = s.points.map((p) => `${p.x},${p.y}`).join(' ');
      return s.closed
        ? { el: `  <polygon points="${pts}"${base}/>`, defs }
        : { el: `  <polyline points="${pts}" fill="none" stroke="${s.stroke}" stroke-width="${Math.max(2, s.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"${attrs}/>`, defs };
    case 'star':
      return { el: `  <polygon points="${starPoints(s)}"${base}/>`, defs };
    case 'polygon':
      return { el: `  <polygon points="${polygonPoints(s)}"${base}/>`, defs };
    case 'image':
      return { el: `  <image x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" href="${s.src ?? ''}"${attrs}/>`, defs };
    case 'icon': {
      // Lucide glyph: stroke-painted <g> positioned + scaled from the 24-grid
      // (docs/lucide-icons.md). Stroke falls back through stroke → textColor →
      // fill so token-bound icons recolor like any other node. Opacity/rotation
      // wrap the glyph in outer <g> elements (the inner g already transforms).
      if (!s.iconName) return { el: '', defs };
      const color =
        s.stroke && s.stroke !== 'transparent' ? s.stroke
        : s.textColor && s.textColor !== 'transparent' ? s.textColor
        : s.fill && s.fill !== 'transparent' ? s.fill
        : '#0f172a';
      let g = lucideIconGroupSvg(s.iconName, s.x, s.y, Math.min(s.width, s.height) || 24, {
        stroke: color,
        strokeWidth: s.strokeWidth > 0 ? s.strokeWidth : undefined,
      });
      if (!g) return { el: '', defs };
      if (s.rotation) {
        // C5: top-left origin — matches the DOM renderer + shapeShapeAttrs.
        g = `<g transform="rotate(${s.rotation} ${s.x} ${s.y})">${g}</g>`;
      }
      if (s.opacity !== undefined && s.opacity < 1) {
        g = `<g opacity="${s.opacity}">${g}</g>`;
      }
      return { el: `  ${g}`, defs };
    }
    default:
      return { el: '', defs };
  }
}

/// Export the canvas as an SVG string.
export function exportSvg(allShapes: Shape[], opts: ExportOptions = {}): string | null {
  const withSize = exportSvgWithSize(allShapes, opts);
  return withSize ? withSize.svg : null;
}

/// Same as exportSvg but also returns the pixel dimensions (used by the PNG
/// rasterizer to size the offscreen canvas).
export function exportSvgWithSize(allShapes: Shape[], opts: ExportOptions = {}): { svg: string; w: number; h: number; count: number } | null {
  let shapes = opts.frameId ? filterByFrame(allShapes, opts.frameId) : allShapes;
  const norm = normalizeBounds(shapes);
  if (!norm) return null;
  const allDefs: string[] = [];
  const els: string[] = [];
  norm.shapes.forEach((s, i) => {
    const { el, defs } = shapeToSvg(s, `${i}-${s.id}`);
    if (el) els.push(el);
    allDefs.push(...defs);
  });
  const defsBlock = allDefs.length > 0 ? `  <defs>\n${allDefs.map((d) => `  ${d}`).join('\n')}\n  </defs>\n` : '';
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${norm.w}" height="${norm.h}" viewBox="0 0 ${norm.w} ${norm.h}">\n${defsBlock}${els.join('\n')}\n</svg>`,
    w: norm.w,
    h: norm.h,
    count: shapes.length,
  };
}

/// Export the canvas as a REAL PNG data URL.
///
/// After spec Phase 5 (DOM default flip + §5.4 ground-truth seam), the primary
/// path captures the LIVE DOM-rendered world element via `html-to-image` —
/// same contract as the agent's `agent:screenshot_request` round-trip. This
/// guarantees the exported PNG matches what the user sees on screen
/// (fonts, images, measured native-layout geometry, drop-shadows, gradients
/// — all the things the SVG projection drops).
///
/// Options:
///   - `opts.worldElement` (HTMLElement | null): the live DOM world element.
///     When provided AND mounted, the DOM-capture path is used. When null /
///     not provided OR the dynamic import fails, falls back to the SVG
///     projection (`exportSvgWithSize` + Image + canvas) — same lossy path
///     that pre-Phase-5 export used, kept as the explicit fallback so the
///     function never throws in environments without `html-to-image`
///     (jsdom tests, SSR, private mode, etc.).
///   - `opts.scale` (number, default 2): pixel ratio for rasterization.
///   - `opts.backgroundColor` (string, optional): passed to html-to-image
///     `toPng` to fill transparent areas (default: the canvas background).
///   - `opts.frameId` (string, optional): export only shapes inside this
///     frame. When the DOM capture path is active AND `opts.worldElement` is
///     set, the function locates the DOM node with `[data-node-id="<frameId>"]`
///     inside the world element and captures that subtree instead of the
///     whole world — so frame exports also see the real DOM. Falls back to
///     SVG-projection filtering when no DOM node matches (SVG renderer,
///     jsdom tests, unknown frame id).
export async function exportPngDataUrl(
  allShapes: Shape[],
  opts: ExportOptions & { worldElement?: HTMLElement | null; backgroundColor?: string } = {},
): Promise<string | null> {
  const withSize = exportSvgWithSize(allShapes, opts);
  if (!withSize) return null;
  const scale = opts.scale ?? 2;

  // ---- Primary path: capture the live DOM world element via html-to-image.
  // Spec §5.4 — the DOM renderer is the source of truth after Phase 5.
  // The world element is the same one the agent's `agent:screenshot_request`
  // round-trip captures, so exports match the agent's view.
  const worldEl = opts.worldElement ?? null;
  if (worldEl && typeof window !== 'undefined') {
    // For frame exports, locate the frame's DOM node inside the world.
    // Falls through to whole-world capture when not found.
    let captureTarget: HTMLElement = worldEl;
    if (opts.frameId) {
      const frameEl = worldEl.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(opts.frameId)}"]`);
      if (frameEl) captureTarget = frameEl;
    } else {
      // The world element is a transform container with no explicit width/height
      // (its children are absolutely positioned, so they don't contribute to
      // its content box). html-to-image captures the element's own box, so a
      // 0x0 world produces an empty image. Fall back to the world's PARENT
      // (the visible canvas surface — has `right:0; bottom:0` so it fills
      // the canvas viewport). This is what users actually want exported:
      // what's visible on their screen, including the canvas background.
      const r = captureTarget.getBoundingClientRect();
      if ((r.width === 0 || r.height === 0) && captureTarget.parentElement) {
        captureTarget = captureTarget.parentElement;
      }
    }
    try {
      const { toPng } = await import('html-to-image');
      const dataUrl = await toPng(captureTarget, {
        pixelRatio: scale,
        backgroundColor: opts.backgroundColor,
        // Skip the ruler/guides/measure chrome overlays — they're screen-space,
        // not part of the canvas content.
        filter: (node) => {
          if (!(node instanceof HTMLElement)) return true;
          // Drop the chrome overlay + rulers + guides + measure overlay.
          if (node.dataset?.acChrome !== undefined) return false;
          if (node.dataset?.acRulers !== undefined) return false;
          if (node.dataset?.acGuides !== undefined) return false;
          if (node.dataset?.acMeasure !== undefined) return false;
          // Drop the drop-target affordance border if present.
          if (node.dataset?.acDropTarget !== undefined) return false;
          return true;
        },
      });
      return dataUrl;
    } catch {
      // html-to-image unavailable or capture failed — fall through to the
      // SVG-projection fallback. Common in tests / tainted-canvas / no-DOM.
    }
  }

  // ---- Fallback path: SVG projection + Image + canvas rasterization.
  // Lossy: drops gradients/shadows/polygons/stars/text-decoration/measured
  // geometry. Kept for compat-only environments (jsdom, SSR, no html-to-image).
  try {
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withSize.svg)}`;
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG rasterization failed'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(withSize.w * scale));
    canvas.height = Math.max(1, Math.round(withSize.h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    // Rasterization can fail on tainted/foreign images (remote src URLs) —
    // fall back to the SVG data URL so the user still gets SOMETHING.
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withSize.svg)}`;
  }
}

/// Export the canvas as a JSON string (the full canvas document).
export function exportJson(doc: unknown): string {
  return JSON.stringify(doc, null, 2);
}

/// Generate HTML / React / Tailwind code from the canvas shapes.
///
/// v2 (spec §5.3 — copy-as-code v2): delegates to the shared tree serializer
/// (`serializeNodes`) so the client-side export and the agent-side
/// `pen_copy_as_code` / `pen_get_design_context` tools emit IDENTICAL code.
/// The parent/child map is rebuilt from the resolved layers' parentId links;
/// auto-layout containers serialize as real nested flexbox, layout:none
/// containers as relative containers with absolutely-positioned children,
/// and every element carries data-name/data-node-id.
export function exportCode(
  allShapes: Shape[],
  framework: 'html' | 'react' | 'tailwind',
  opts: ExportOptions = {},
): string | null {
  let shapes = opts.frameId ? filterByFrame(allShapes, opts.frameId) : allShapes;
  if (shapes.length === 0) return null;
  return serializeNodes(shapes, { framework, rootName: 'CanvasExport' });
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

/// Download a data URL (e.g. a rasterized PNG) as a file.
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
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
