#!/usr/bin/env python3
"""Compute field-usage stats from a shapes JSON dump (Task 7-d).

Mirrors the Task 7-a baseline computation so the numbers are directly comparable.
Reads the file path from argv[1], writes the stats JSON to argv[2].
"""
import json
import sys
import os


def is_set(v):
    """A field is 'used' if it's not None, not 'undefined', not empty, and not the default."""
    if v is None:
        return False
    if isinstance(v, str):
        if v in ("", "undefined", "none", "normal"):
            return False
        # color defaults
        if v.startswith("#00000000") or v == "transparent":
            return False
        return True
    if isinstance(v, (int, float)):
        # numeric defaults: 0 = not set for these fields (fontWeight 400 default IS set if explicitly 400)
        return True
    if isinstance(v, (list, dict)):
        return len(v) > 0
    if isinstance(v, bool):
        return v
    return v is not None


def is_text_shape(s):
    return s.get("type") == "text" or (s.get("type") == "rectangle" and s.get("text") and len(str(s.get("text"))) > 0)


def is_rectangle(s):
    return s.get("type") in ("rectangle", "frame")


def compute_stats(shapes):
    total = len(shapes)
    text_shapes = [s for s in shapes if s.get("type") == "text"]
    rect_shapes = [s for s in shapes if is_rectangle(s)]
    card_shapes = [s for s in rect_shapes if s.get("name", "").lower() and any(
        k in (s.get("name", "") or "").lower() for k in
        ["card", "stat", "panel", "tile", "metric", "chart", "topbar", "sidebar", "frame", "container", "section"]
    )]

    use_shadow = sum(1 for s in shapes if is_set(s.get("shadow")))
    use_gradient = sum(1 for s in shapes if is_set(s.get("gradient")))
    use_radii = sum(1 for s in shapes if is_set(s.get("radii")) or (is_set(s.get("radius")) and s.get("radius") not in (0, "0", None)))
    use_auto_layout = sum(1 for s in shapes if is_set(s.get("autoLayout")))
    use_font_weight = sum(1 for s in text_shapes if is_set(s.get("fontWeight")) and s.get("fontWeight") not in (None, 400, "400", "normal"))
    use_letter_spacing = sum(1 for s in text_shapes if is_set(s.get("letterSpacing")) and s.get("letterSpacing") not in (None, 0, "0", "normal"))
    use_line_height = sum(1 for s in text_shapes if is_set(s.get("lineHeight")) and s.get("lineHeight") not in (None, 0, "0", "normal", 1.0, "1"))
    use_text_align = sum(1 for s in text_shapes if is_set(s.get("textAlign")) and s.get("textAlign") not in (None, "left", "start", ""))
    use_opacity = sum(1 for s in shapes if is_set(s.get("opacity")) and s.get("opacity") not in (None, 1, "1", 1.0))
    use_blur = sum(1 for s in shapes if is_set(s.get("blur")))
    use_font_size = sum(1 for s in text_shapes if is_set(s.get("fontSize")) and s.get("fontSize") not in (None, 16, "16"))
    use_font_family = sum(1 for s in text_shapes if is_set(s.get("fontFamily")) and s.get("fontFamily") not in (None, "", "sans-serif", "system-ui"))
    use_text_color = sum(1 for s in text_shapes if is_set(s.get("textColor")) and s.get("textColor") not in (None, "", "#000000", "#000"))
    use_stroke = sum(1 for s in shapes if is_set(s.get("stroke")) and s.get("stroke") not in (None, "", "none", "transparent"))
    use_radius = sum(1 for s in shapes if is_set(s.get("radius")) and s.get("radius") not in (None, 0, "0"))

    bare_rectangles = sum(1 for s in rect_shapes if not is_set(s.get("shadow")) and not is_set(s.get("gradient")) and (not is_set(s.get("radius")) or s.get("radius") in (0, "0")) and not is_set(s.get("autoLayout")))

    return {
        "total_shapes": total,
        "text_shapes": len(text_shapes),
        "rectangle_shapes": len(rect_shapes),
        "card_shapes": len(card_shapes),
        "useShadow": use_shadow,
        "useGradient": use_gradient,
        "useRadii": use_radii,
        "useRadius": use_radius,
        "useAutoLayout": use_auto_layout,
        "useFontWeight": use_font_weight,
        "useLetterSpacing": use_letter_spacing,
        "useLineHeight": use_line_height,
        "useTextAlign": use_text_align,
        "useOpacity": use_opacity,
        "useBlur": use_blur,
        "useFontSize": use_font_size,
        "useFontFamily": use_font_family,
        "useTextColor": use_text_color,
        "useStroke": use_stroke,
        "bareRectangles": bare_rectangles,
    }


def main():
    if len(sys.argv) < 3:
        print("usage: compute-shape-stats.py <input-shapes.json> <output-stats.json>", file=sys.stderr)
        sys.exit(2)
    in_path = sys.argv[1]
    out_path = sys.argv[2]
    with open(in_path, "r", encoding="utf-8") as f:
        raw = f.read().strip()
    # agent-browser eval wraps the JSON string in an extra JSON-string-quote layer
    if raw.startswith('"') and raw.endswith('"'):
        raw = json.loads(raw)
    shapes = json.loads(raw)
    stats = compute_stats(shapes)
    # Annotate with shape type distribution + name sample for diagnostic
    type_counts = {}
    name_sample = []
    for s in shapes:
        t = s.get("type", "?")
        type_counts[t] = type_counts.get(t, 0) + 1
        n = s.get("name") or ""
        if n and len(name_sample) < 20:
            name_sample.append(n)
    stats["shapeTypeDistribution"] = type_counts
    stats["nameSample"] = name_sample
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2, sort_keys=True)
    print(json.dumps(stats, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
