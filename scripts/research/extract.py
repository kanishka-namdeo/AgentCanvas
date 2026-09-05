import json, sys, re, html
def extract(path, out=None):
    with open(path) as f:
        raw = f.read()
    # strip CLI wrapper lines
    start = raw.find('{')
    end = raw.rfind('}')
    data = json.loads(raw[start:end+1])
    h = data.get('data', {}).get('html', '')
    # remove scripts/styles
    h = re.sub(r'<(script|style)[\s\S]*?</\1>', ' ', h)
    h = re.sub(r'<br\s*/?>', '\n', h)
    h = re.sub(r'</(p|div|li|h1|h2|h3|h4|tr|section|article|dt|dd)>', '\n', h)
    h = re.sub(r'<[^>]+>', ' ', h)
    t = html.unescape(h)
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n\s*\n+', '\n', t)
    t = '\n'.join(l.strip() for l in t.split('\n') if l.strip())
    if out:
        open(out, 'w').write(t)
    else:
        print(t[:6000])
extract(sys.argv[1], sys.argv[2] if len(sys.argv)>2 else None)
