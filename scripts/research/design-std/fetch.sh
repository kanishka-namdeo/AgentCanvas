#!/bin/bash
# Fetch key reference pages for the design-consistency audit
set -u
RAW="/home/z/my-project/scripts/research/design-std"
mkdir -p "$RAW"

fetch() { # url, name
  URL="$1"; NAME="$2"
  z-ai function -n page_reader -a "{\"url\": \"$URL\"}" -o "$RAW/$NAME.json" >/dev/null 2>&1
  node -e "
const fs=require('fs');
try{
  const d=JSON.parse(fs.readFileSync('$RAW/$NAME.json','utf8'));
  const dd=d.data||{};
  const html=dd.html||'';
  const text=html
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre|\/code)[^>]*>/gi,'\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'\"').replace(/&#39;/g,\"'\").replace(/&nbsp;/g,' ')
    .replace(/[ \t]{2,}/g,' ')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
  fs.writeFileSync('$RAW/$NAME.txt', 'URL: $URL\nTITLE: '+(dd.title||'')+'\n\n'+text.slice(0,20000));
  console.log('OK $NAME', 'title:', dd.title, 'textlen:', text.length);
}catch(e){console.log('FAIL $NAME', e.message)}
"
}

fetch "https://ui.shadcn.com/docs/theming" "page-shadcn-theming"
fetch "https://ui.shadcn.com/colors" "page-shadcn-colors"
fetch "https://www.designtokens.org/TR/2025.10/format" "page-dtcg-format"
fetch "https://stephaniewalter.design/blog/what-minimum-font-size-for-a-high-density-data-web-app-do-you-suggest" "page-min-font"
fetch "https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html" "page-wcag-1411"
fetch "https://www.radix-ui.com/colors/docs/palette-composition/understanding-palette" "page-radix-palette"
