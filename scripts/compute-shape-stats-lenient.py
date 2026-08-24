#!/usr/bin/env python3
"""Compute field-usage stats from a shapes JSON dump (Task 7-d, lenient variant).

This variant counts a field as "used" if it is PRESENT (not missing/None).
Used for the apples-to-apples comparison with the Task 7-a baseline stat
(which also counted presence rather than non-default value).
"""
import json
import sys


def is_present(v):
    """Field is 'used' if it's not None, not undefined, not empty."""
    if v is None:
        return False
    if isinstance(v, str):
        return v not in ("", "undefined", "none", "null")
    if isinstance(v, (list, dict)):
        return len(v) > 0
    return True


def compute_stats(shapes):
    total = len(shapes)
    text_shapes = [s for s in shapes if s.get("type") == "text"]
    rect_shapes = [s for s in shapes if s.get("type") in ("rectangle", "frame")]

    use_shadow = sum(1 for s in shapes if is_present(s.get("shadow")))
    use_gradient = sum(1 for s in shapes if is_present(s.get("gradient")))
    use_radii = sum(1 for s in shapes if is_present(s.get("radii")) or (is_present(s.get("radius")) and s.get("radius") not in (0, "0", None)))
    use_auto_layout = sum(1 for s in shapes if is_present(s.get("autoLayout")))
    use_font_weight = sum(1 for s in text_shapes if is_present(s.get("fontWeight")))
    use_letter_spacing = sum(1 for s in text_shapes if is_present(s.get("letterSpacing")))
    use_line_height = sum(1 for s in text_shapes if is_present(s.get("lineHeight")))
    use_text_align = sum(1 for s in text_shapes if is_present(s.get("textAlign")))
    use_opacity = sum(1 for s in shapes if is_present(s.get("opacity")) and s.get("opacity") not in (1, "1", 1.0))
    use_blur = sum(1 for s in shapes if is_present(s.get("blur")))
    use_font_size = sum(1 for s in text_shapes if is_present(s.get("fontSize")))
    use_font_family = sum(1 for s in text_shapes if is_present(s.get("fontFamily")))
    use_text_color = sum(1 for s in text_shapes if is_present(s.get("textColor")))
    use_stroke = sum(1 for s in shapes if is_present(s.get("stroke")) and s.get("stroke") not in (None, "", "none", "transparent"))

    bare_rectangles = sum(
        1 for s in rect_shapes
        if not is_present(s.get("shadow")) and not is_present(s.get("gradient"))
        and (not is_present(s.get("radius")) or s.get("radius") in (0, "0"))
        and not is_present(s.get("autoLayout"))
    )

    return {
        "total_shapes": total,
        "text_shapes": len(text_shapes),
        "rectangle_shapes": len(rect_shapes),
        "useShadow": use_shadow,
        "useGradient": use_gradient,
        "useRadii": use_radii,
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


def load_shapes(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read().strip()
    # agent-browser eval wraps the JSON string in extra JSON-string-quote layer
    while raw.startswith('"') and raw.endswith('"'):
        raw = json.loads(raw)
    data = json.loads(raw)
    # The baseline file is {shapeCount, shapes: [...]}; the after file is just [...]
    if isinstance(data, dict) and "shapes" in data:
        return data["shapes"]
    return data


def main():
    stats = compute_stats(load_shapes(sys.argv[1]))
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2, sort_keys=True)
    print(json.dumps(stats, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
