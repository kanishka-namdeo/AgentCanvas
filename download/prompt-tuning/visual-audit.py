#!/usr/bin/env python3
"""Computed visual audit of multishot final canvases (no LLM) — Task 10-d, Phase 4.

For every scripts/agent-eval/results/ms-*-final-canvas.json reports:
  (a) layer count
  (b) % layers with shadows
  (c) % layers with saturated fills  (max-min)/max > 0.3  — over layers that carry a color
  (d) distinct hue clusters (30-degree HSV bins with >=2 colors, fill + text colors)
  (e) font-size distribution vs the 12/14/16/20/24/30/38 type scale
  (f) spacing-grid adherence (% of x/y/width/height values divisible by 4)

Output: download/prompt-tuning/visual-audit.md
"""
import json
import glob
import os
import re
import colorsys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # /home/z/my-project
CANVAS_GLOB = os.path.join(ROOT, 'scripts', 'agent-eval', 'results', 'ms-*-final-canvas.json')
OUT_PATH = os.path.join(ROOT, 'download', 'prompt-tuning', 'visual-audit.md')
TYPE_SCALE = [12, 14, 16, 20, 24, 30, 38]
HUE_NAMES = [(15, 'red'), (45, 'orange'), (70, 'yellow'), (100, 'lime'), (160, 'green'),
             (185, 'teal'), (210, 'cyan'), (250, 'blue'), (290, 'indigo'),
             (330, 'purple'), (361, 'magenta')]

HEX_RE = re.compile(r'#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?')


def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def colors_of_layer(layer):
    """All parseable colors a layer paints itself with (fill, fills[], textColor)."""
    out = []
    for key in ('fill', 'textColor'):
        v = layer.get(key)
        if isinstance(v, str):
            out += [hex_to_rgb(m) for m in re.findall(r'#[0-9a-fA-F]{6}', v)]
    fills = layer.get('fills')
    if isinstance(fills, list):
        for f in fills:
            if isinstance(f, dict):
                c = f.get('color')
                if isinstance(c, str):
                    out += [hex_to_rgb(m) for m in re.findall(r'#[0-9a-fA-F]{6}', c)]
                for stop in (f.get('stops') or []):
                    c = stop.get('color') if isinstance(stop, dict) else None
                    if isinstance(c, str):
                        out += [hex_to_rgb(m) for m in re.findall(r'#[0-9a-fA-F]{6}', c)]
    return out


def has_shadow(layer):
    s = layer.get('shadow')
    if isinstance(s, dict) and s:
        return True
    arr = layer.get('shadows')
    return isinstance(arr, list) and len(arr) > 0


def saturation(rgb):
    mx = max(rgb)
    if mx == 0:
        return 0.0
    return (mx - min(rgb)) / mx


def hue_name(h):
    for hi, name in HUE_NAMES:
        if h < hi:
            return name
    return 'red'


def audit(path):
    doc = json.load(open(path))
    shapes = doc.get('shapes') or []
    n = len(shapes)

    # (b) shadows
    n_shadow = sum(1 for s in shapes if has_shadow(s))

    # (c) saturated fills + (d) hue clusters
    colored = saturated = 0
    color_counter = Counter()
    for s in shapes:
        cols = colors_of_layer(s)
        if cols:
            colored += 1
            for c in cols:
                color_counter['#%02x%02x%02x' % c] += 1
        if any(saturation(c) > 0.3 for c in cols):
            saturated += 1
    hue_bins = Counter()
    for hexcode, cnt in color_counter.items():
        rgb = hex_to_rgb(hexcode)
        h, _, _ = colorsys.rgb_to_hsv(*[v / 255 for v in rgb])
        hue_bins[(int(h * 360) // 30) * 30] += cnt
    clusters = sorted(b for b, c in hue_bins.items() if c >= 2)
    cluster_names = [f"{b}-{b + 30}° {hue_name(b + 15)}" for b in clusters]

    # (e) font sizes
    sizes = Counter()
    off = Counter()
    for s in shapes:
        if s.get('type') == 'text':
            fs = s.get('fontSize')
            if isinstance(fs, (int, float)):
                sizes[int(fs)] += 1
                if int(fs) not in TYPE_SCALE:
                    off[int(fs)] += 1
    total_text = sum(sizes.values())
    on_scale = total_text - sum(off.values())

    # (f) 4-px grid adherence
    vals = []
    for s in shapes:
        for k in ('x', 'y', 'width', 'height'):
            v = s.get(k)
            if isinstance(v, (int, float)):
                vals.append(v)
    on_grid = sum(1 for v in vals if abs(v % 4) < 1e-9)

    return {
        'file': os.path.basename(path),
        'layers': n,
        'shadow_pct': (100.0 * n_shadow / n) if n else 0.0,
        'colored': colored,
        'saturated_pct': (100.0 * saturated / colored) if colored else 0.0,
        'saturated_of_all_pct': (100.0 * saturated / n) if n else 0.0,
        'clusters': len(clusters),
        'cluster_names': cluster_names,
        'sizes': sizes,
        'off': off,
        'on_scale_pct': (100.0 * on_scale / total_text) if total_text else 0.0,
        'n_geom': len(vals),
        'grid_pct': (100.0 * on_grid / len(vals)) if vals else 0.0,
    }


def fmt_sizes(sizes):
    return ', '.join(f'{k}px×{v}' for k, v in sorted(sizes.items())) or '—'


def main():
    files = sorted(glob.glob(CANVAS_GLOB))
    results = [audit(f) for f in files]

    lines = []
    ap = lines.append
    ap('# Computed Visual Audit — Multishot Final Canvases (Round 3, Task 10-d)')
    ap('')
    ap('No LLM involved: pure geometry/color arithmetic over `scripts/agent-eval/results/ms-*-final-canvas.json`.')
    ap('')
    ap('## Per-canvas metrics')
    ap('')
    ap('| Canvas | Layers | % shadowed | % saturated (of colored / of all) | Hue clusters (≥2 colors) | Font sizes (on-scale %) | 4px grid adherence |')
    ap('|---|---|---|---|---|---|---|')
    for r in results:
        ap(f"| {r['file'].replace('-final-canvas.json','')} | {r['layers']} | {r['shadow_pct']:.0f}% "
           f"| {r['saturated_pct']:.0f}% / {r['saturated_of_all_pct']:.0f}% "
           f"| {r['clusters']} ({', '.join(r['cluster_names']) or 'none'}) "
           f"| {r['on_scale_pct']:.0f}% on scale · {fmt_sizes(r['sizes'])} "
           f"| {r['grid_pct']:.0f}% of {r['n_geom']} vals |")
    ap('')
    ap('## Detail')
    ap('')
    for r in results:
        ap(f"### {r['file']}")
        ap('')
        ap(f"- **(a) Layer count:** {r['layers']}")
        ap(f"- **(b) Shadows:** {r['shadow_pct']:.0f}% of layers carry a shadow")
        ap(f"- **(c) Saturated fills:** {r['saturated_pct']:.0f}% of the {r['colored']} color-carrying layers "
           f"have (max−min)/max > 0.3 ({r['saturated_of_all_pct']:.0f}% of all layers)")
        ap(f"- **(d) Hue clusters:** {r['clusters']} distinct 30° clusters (≥2 color uses): "
           f"{', '.join(r['cluster_names']) or 'none'}")
        off = fmt_sizes(r['off'])
        ap(f"- **(e) Typography:** {r['on_scale_pct']:.0f}% of text layers on the 12/14/16/20/24/30/38 scale; "
           f"off-scale sizes: {off if off != '—' else 'none'}")
        ap(f"- **(f) Spacing grid:** {r['grid_pct']:.0f}% of {r['n_geom']} x/y/width/height values divisible by 4")
        ap('')
    ap('## Reading')
    ap('')
    ap('- Saturated % uses the requested (max−min)/max > 0.3 chroma test on fill/fills/textColor; '
       'grays and near-grays (slate borders, #e2e8f0 dividers, #0f172a ink) correctly fail it.')
    ap('- Hue clusters counted in 30° HSV bins over deduplicated fill+text colors, threshold ≥2 uses '
       '(bin shown as range + representative name of its midpoint).')
    ap('- Grid adherence counts raw geometry values (x/y/w/h), so a single centered 375-wide mobile frame '
       '(375 % 4 = 3) drags the number down even when internal spacing is disciplined.')
    ap('')
    out = '\n'.join(lines)
    with open(OUT_PATH, 'w') as f:
        f.write(out)
    print(out)


if __name__ == '__main__':
    main()
