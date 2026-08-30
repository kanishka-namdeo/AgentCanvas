#!/bin/bash
# Research helper: run a web search, save raw JSON
# Usage: search.sh "<query>" <output-name> [num]
set -u
Q="$1"; NAME="$2"; NUM="${3:-10}"
RAW="/home/z/my-project/download/research-modes/raw"
z-ai function -n web_search -a "{\"query\": \"$Q\", \"num\": $NUM}" -o "$RAW/$NAME.json" >/dev/null 2>&1
node -e "
const d=require('$RAW/$NAME.json');
if(Array.isArray(d)){
  console.log('OK $NAME ('+d.length+' results)');
  d.slice(0,10).forEach(r=>console.log('  ['+(r.date||'')+'] '+r.name+' :: '+r.url));
}else{console.log('FAIL $NAME', typeof d)}
"
