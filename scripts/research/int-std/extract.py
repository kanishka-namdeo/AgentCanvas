#!/usr/bin/env python3
"""Extract readable text from page_reader JSON dumps for the interaction-standards research."""
import json, re, sys, html

DIR = "/home/z/my-project/scripts/research/int-std/"

def strip_html(h: str) -> str:
    h = re.sub(r"<script[^>]*>[\s\S]*?</script>", " ", h, flags=re.I)
    h = re.sub(r"<style[^>]*>[\s\S]*?</style>", " ", h, flags=re.I)
    h = re.sub(r"<br\s*/?>", "\n", h, flags=re.I)
    h = re.sub(r"</(p|div|li|tr|h[1-6]|section|article)>", "\n", h, flags=re.I)
    h = re.sub(r"<[^>]+>", " ", h)
    h = html.unescape(h)
    h = re.sub(r"[ \t]+", " ", h)
    h = re.sub(r"\n\s*\n+", "\n", h)
    return h.strip()

def load(name: str):
    try:
        raw = json.load(open(DIR + name))
        data = raw.get("data", raw) if isinstance(raw, dict) else raw
        body = data.get("html") or data.get("text") or ""
        title = data.get("title", "")
        return title, strip_html(body)
    except Exception as e:
        return f"ERROR: {e}", ""

if __name__ == "__main__":
    name = sys.argv[1]
    title, text = load(name)
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 6000
    print(f"# TITLE: {title}\n")
    print(text[:limit])
    print(f"\n--- [{len(text)} chars total] ---")
