#!/bin/bash
# Research helper: fetch a page via z-ai page_reader, save raw JSON + extracted text
# Usage: fetch-page.sh <url> <output-prefix>
set -u
URL="$1"; PREFIX="$2"
RAW="/home/z/my-project/download/research-modes/raw"
z-ai function -n page_reader -a "{\"url\": \"$URL\"}" -o "$RAW/$PREFIX.json" >/dev/null 2>&1
node -e "
const fs=require('fs');
try{
  const d=JSON.parse(fs.readFileSync('$RAW/$PREFIX.json','utf8'));
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
  fs.writeFileSync('$RAW/$PREFIX.txt', 'URL: $URL\nTITLE: '+(dd.title||'')+'\n\n'+text);
  console.log('OK $PREFIX', 'title:', dd.title, 'textlen:', text.length);
}catch(e){console.log('FAIL $PREFIX', e.message)}
"
