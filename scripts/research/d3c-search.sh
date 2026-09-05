#!/bin/bash
# Usage: d3c-search.sh <name> <query> [num]
NAME="$1"; QUERY="$2"; NUM="${3:-8}"
OUT="/home/z/my-project/scripts/research/deep3c-${NAME}.json"
z-ai function -n web_search -a "{\"query\": \"${QUERY}\", \"num\": ${NUM}}" > "${OUT}.raw" 2>/dev/null
python3 - "$OUT" <<'PYEOF'
import json, sys
out = sys.argv[1]
raw = open(out + '.raw').read()
i = raw.find('[')
if i < 0:
    print("NO RESULTS")
    sys.exit(0)
try:
    d = json.loads(raw[i:raw.rfind(']')+1])
    for r in d:
        print(f"{r.get('rank')} {r.get('url')} | {r.get('name','')[:60]} | {r.get('snippet','')[:180]}")
except Exception as e:
    print("PARSE ERROR", e)
PYEOF
