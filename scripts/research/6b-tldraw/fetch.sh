#!/bin/bash
# fetch <name> <url>
D=/home/z/my-project/scripts/research/6b-tldraw
curl -sL -A "Mozilla/5.0" "$2" -o "$D/$1.html"
python3 - "$D/$1.html" "$D/$1.txt" <<'PY'
import re, sys
html = open(sys.argv[1], errors='ignore').read()
t = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', html, flags=re.S)
t = re.sub(r'<[^>]+>', ' ', t)
t = re.sub(r'\s+', ' ', t)
open(sys.argv[2], 'w').write(t)
print(sys.argv[1], len(html), 'bytes html,', len(t), 'chars text')
PY
