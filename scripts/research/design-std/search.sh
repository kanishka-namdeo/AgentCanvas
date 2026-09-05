#!/bin/bash
# Design-consistency research (Task: visual token audit 2026-09-06)
# Usage: bash scripts/research/design-std/search.sh
set -u
RAW="/home/z/my-project/scripts/research/design-std"
mkdir -p "$RAW"

search() { # query, name
  Q="$1"; NAME="$2"; NUM="${3:-8}"
  z-ai function -n web_search -a "{\"query\": \"$Q\", \"num\": $NUM}" -o "$RAW/$NAME.json" >/dev/null 2>&1
  node -e "
const d=require('$RAW/$NAME.json');
if(Array.isArray(d)){
  console.log('OK $NAME ('+d.length+')');
  d.slice(0,$NUM).forEach(r=>console.log('  ['+(r.date||'')+'] '+r.name+' :: '+r.url));
}else{console.log('FAIL $NAME', typeof d)}
"
}

search "W3C design tokens community group format specification 2026 status" "tokens-w3c"
search "WCAG 2.2 contrast minimum 1.4.3 1.4.11 non-text contrast UI components" "wcag22-contrast"
search "Tailwind CSS 4 theming @theme CSS variables semantic design tokens best practice" "tw4-theme"
search "shadcn/ui theming oklch semantic tokens light dark mode base color" "shadcn-theme"
search "Radix Colors dark mode guidelines step 9 solid component step 3 surface" "radix-colors"
search "4px 8px spacing grid design system baseline spacing scale best practice" "spacing-grid"
search "minimum font size UI dense interface micro typography accessibility 11px 12px" "micro-type"
search "design token naming convention color semantic scales UI consistency audit" "token-naming"
