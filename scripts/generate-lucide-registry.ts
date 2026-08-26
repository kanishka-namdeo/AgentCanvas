// generate-lucide-registry.ts — build the curated Lucide icon registry module.
//
// Reads the INSTALLED lucide-react package's per-icon `__iconNode` data
// (dist/esm/icons/<name>.mjs — pure element arrays on a 24×24 viewBox),
// filters to the curated catalog below, and emits
// src/lib/icons/lucide-registry.generated.ts.
//
// Why a curated catalog instead of all ~2034 icons: the registry is imported
// by the resolver (client + server) and the DOM renderer, so bundle size
// matters; the curated set covers the icons a design agent realistically
// places, keeps the system-prompt catalog compact, and can be extended by
// adding names to CATEGORIES below and re-running:
//
//   npx tsx scripts/generate-lucide-registry.ts   (or: bun run scripts/…)
//
// The generated module is checked in so the app never depends on
// lucide-react's internals at runtime — see docs/lucide-icons.md.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ---- Curated catalog ---------------------------------------------------------
// category → icon names (must match lucide-react icon file names exactly).
// Keep each category ≤ 24 icons; the system prompt lists them compactly.
const CATEGORIES: Record<string, string[]> = {
  navigation: [
    'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down',
    'arrow-up-right', 'arrow-down-right', 'arrow-up-left', 'arrow-down-left',
    'chevron-right', 'chevron-left', 'chevron-up', 'chevron-down',
    'chevrons-right', 'chevrons-left', 'chevrons-up', 'chevrons-down',
    'move', 'external-link', 'corner-up-left', 'corner-down-right',
  ],
  actions: [
    'check', 'x', 'plus', 'minus', 'circle-check', 'circle-x', 'check-check',
    'pencil', 'trash-2', 'copy', 'clipboard', 'scissors',
    'undo-2', 'redo-2', 'rotate-ccw', 'rotate-cw', 'refresh-cw', 'save',
    'filter', 'more-horizontal', 'more-vertical', 'grip-vertical',
    'maximize-2', 'minimize-2',
  ],
  communication: [
    'mail', 'phone', 'phone-call', 'send', 'message-circle', 'message-square',
    'messages-square', 'bell', 'at-sign', 'inbox', 'paperclip', 'megaphone',
    'share-2', 'rss',
  ],
  media: [
    'play', 'pause', 'skip-forward', 'skip-back', 'volume-2', 'volume-x',
    'mic', 'mic-off', 'headphones', 'camera', 'video', 'image', 'film',
    'music', 'radio', 'podcast',
  ],
  files: [
    'file', 'file-text', 'file-plus-2', 'folder', 'folder-open', 'folder-plus',
    'archive', 'hard-drive', 'database', 'server', 'cloud-upload', 'cloud-download',
  ],
  commerce: [
    'shopping-cart', 'shopping-bag', 'package', 'gift', 'tag', 'store',
    'credit-card', 'wallet', 'banknote', 'coins', 'dollar-sign',
    'receipt', 'receipt-text', 'percent', 'trending-up', 'trending-down',
    'chart-column', 'chart-pie',
  ],
  users: [
    'user', 'users', 'user-plus', 'user-check', 'user-cog', 'log-in', 'log-out',
    'id-card', 'contact', 'heart', 'smile', 'frown',
  ],
  security: [
    'lock', 'unlock', 'key', 'key-round', 'shield', 'shield-check',
    'shield-alert', 'eye', 'eye-off', 'scan-face',
  ],
  status: [
    'info', 'circle-alert', 'circle-help', 'lightbulb', 'zap', 'flame',
    'star', 'sparkles', 'rocket', 'award', 'trophy',
  ],
  'weather-nature': [
    'sun', 'moon', 'sun-moon', 'cloud', 'cloud-rain', 'cloud-sun',
    'cloud-lightning', 'thermometer', 'wind', 'droplet', 'map-pin', 'compass',
  ],
  'tech-dev': [
    'code', 'code-xml', 'terminal', 'git-branch', 'git-commit-horizontal',
    'git-pull-request', 'bug', 'cpu', 'monitor', 'smartphone', 'tablet',
    'laptop', 'keyboard', 'wifi',
  ],
  time: [
    'clock', 'clock-3', 'calendar', 'calendar-days', 'calendar-check',
    'timer', 'hourglass', 'alarm-clock', 'history',
  ],
  layout: [
    'layout-dashboard', 'layout-grid', 'list', 'table-2', 'columns-3',
    'rows-3', 'panel-left', 'panel-right', 'sidebar', 'square', 'circle',
    'separator-horizontal',
  ],
  essentials: [
    'search', 'settings', 'settings-2', 'sliders-horizontal', 'home', 'menu',
    'link', 'link-2', 'globe', 'map',
  ],
};

// Search keywords per icon (semantic hints beyond the name itself). Only for
// high-traffic icons where the name alone doesn't surface common intents.
const KEYWORDS: Record<string, string> = {
  check: 'done success confirm complete tick',
  x: 'close cancel remove dismiss error fail',
  plus: 'add new create',
  minus: 'remove subtract less',
  'circle-check': 'success confirmed validated done ok',
  'circle-x': 'error failed invalid denied',
  'trash-2': 'delete remove bin garbage',
  pencil: 'edit write modify draw',
  copy: 'duplicate clone',
  clipboard: 'paste copy board',
  search: 'find lookup magnify query',
  settings: 'preferences configure options gear cog',
  user: 'person account profile avatar member',
  users: 'team people group audience members',
  lock: 'secure security password private protected auth',
  unlock: 'open unlocked public',
  'shield-check': 'verified protected safe secure trust',
  shield: 'protection security guard defense',
  eye: 'visible view watch preview show password',
  'eye-off': 'hidden invisible hide password conceal',
  bell: 'notification alert reminder ring',
  mail: 'email message inbox envelope',
  send: 'submit deliver email share',
  phone: 'call telephone contact support',
  heart: 'favorite like love rating',
  star: 'favorite rating bookmark premium featured',
  zap: 'fast instant energy power lightning quick',
  sparkles: 'ai magic generate feature new premium glow',
  rocket: 'launch deploy startup ship grow fast',
  home: 'main dashboard landing start',
  menu: 'hamburger navigation toggle sidebar collapse',
  'external-link': 'open new tab outbound share leave',
  'log-in': 'signin authenticate enter login',
  'log-out': 'signout exit logout leave',
  'shopping-cart': 'checkout basket ecommerce purchase add to cart',
  'shopping-bag': 'order purchase ecommerce bag',
  'credit-card': 'payment billing checkout purchase card',
  wallet: 'payment finance balance money',
  'dollar-sign': 'price money usd currency revenue cash',
  'trending-up': 'growth increase metrics analytics up revenue',
  'trending-down': 'decline decrease loss down churn',
  'chart-column': 'bar chart analytics metrics report statistics',
  'chart-pie': 'distribution share analytics donut statistics',
  'calendar-days': 'date schedule event picker appointment',
  clock: 'time hours minutes recent',
  timer: 'countdown stopwatch duration session',
  'map-pin': 'location address place marker geo',
  globe: 'world international language region web browser',
  cloud: 'hosting storage saas server weather',
  'cloud-upload': 'backup sync storage upload',
  'cloud-download': 'export retrieve download storage',
  code: 'developer programming snippet source',
  terminal: 'console command cli shell developer',
  'git-branch': 'version control branch fork repo',
  bug: 'error debug issue defect',
  database: 'storage db records sql',
  server: 'backend infrastructure hosting devops',
  play: 'start video media run begin',
  pause: 'stop hold suspend media',
  camera: 'photo capture snapshot picture',
  image: 'picture photo placeholder media',
  download: 'save export fetch retrieve',
  upload: 'import attach file transfer',
  filter: 'refine sort narrow search query',
  info: 'information about help hint tip',
  'circle-alert': 'warning caution attention error important',
  'circle-help': 'question faq support help unknown',
  lightbulb: 'idea tip insight suggestion hint',
  file: 'document attachment page paper',
  'file-text': 'document note article page contract',
  folder: 'directory group files workspace project',
  scissors: 'cut crop trim slice',
  'bar-chart': 'analytics chart statistics',
  'layout-dashboard': 'overview panels widgets admin home',
  'layout-grid': 'gallery cards tiles grid view',
  list: 'items bullets inventory todo',
  'message-circle': 'chat comment conversation bubble feedback',
  'message-square': 'chat comment message bubble feedback',
  pencil_1: 'unused',
};

// ---- Extraction ---------------------------------------------------------------

interface IconElement { tag: string; attrs: Record<string, string | number> }

/// Extract the `__iconNode` array from an icon module. lucide-react 1.x keeps
/// RENAMED icons as alias modules (`export { default } from './funnel.mjs'`)
/// so well-known names like `home`/`filter`/`smile` still resolve — follow the
/// re-export chain (depth-limited) to the canonical module carrying the data.
function extractIconNode(mjsSource: string, iconsDir: string, depth = 0): IconElement[] | null {
  const m = /const\s+__iconNode\s*=\s*(\[[\s\S]*?\]);\s*\n/.exec(mjsSource);
  if (!m) {
    if (depth >= 4) return null;
    const alias = /export\s*\{[^}]*\}\s*from\s*'\.\/([^']+\.mjs)'\s*;/.exec(mjsSource);
    if (!alias) return null;
    const target = join(iconsDir, alias[1]);
    if (!existsSync(target)) return null;
    return extractIconNode(readFileSync(target, 'utf8'), iconsDir, depth + 1);
  }
  let raw: unknown;
  try {
    // The array literal contains only JSON-safe literals (strings, numbers,
    // object literals with identifier keys) — evaluate it in a sandboxed fn.
    raw = new Function(`return (${m[1]})`)();
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: IconElement[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
    const attrs: Record<string, string | number> = {};
    const a = entry[1];
    if (a && typeof a === 'object') {
      for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
        if (k === 'key') continue; // React-only prop — drop it
        if (typeof v === 'string' || typeof v === 'number') attrs[k] = v;
      }
    }
    out.push({ tag: entry[0], attrs });
  }
  return out.length > 0 ? out : null;
}

// ---- Main ---------------------------------------------------------------------

const pkgRoot = join(process.cwd(), 'node_modules', 'lucide-react');
const iconsDir = join(pkgRoot, 'dist', 'esm', 'icons');
const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string };

if (!existsSync(iconsDir)) {
  console.error(`✗ lucide-react icons directory not found: ${iconsDir}`);
  console.error('  Install dependencies first (pnpm install).');
  process.exit(1);
}

const icons: Record<string, IconElement[]> = {};
const categories: Record<string, string[]> = {};
const seen = new Set<string>();
const missing: string[] = [];

for (const [category, names] of Object.entries(CATEGORIES)) {
  const kept: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue; // first category wins on duplicates
    const file = join(iconsDir, `${name}.mjs`);
    if (!existsSync(file)) {
      missing.push(name);
      continue;
    }
    const elements = extractIconNode(readFileSync(file, 'utf8'), iconsDir);
    if (!elements) {
      missing.push(name);
      continue;
    }
    icons[name] = elements;
    seen.add(name);
    kept.push(name);
  }
  categories[category] = kept;
}

if (missing.length > 0) {
  console.error(`✗ ${missing.length} icon(s) not found in lucide-react@${pkgJson.version}:`);
  for (const n of missing) console.error(`  - ${n}`);
  process.exit(1);
}

// Drop the unused sentinel key if it slipped through (defensive).
delete (icons as Record<string, unknown>).pencil_1;
delete KEYWORDS.pencil_1;
for (const list of Object.values(categories)) {
  const i = list.indexOf('pencil_1');
  if (i >= 0) list.splice(i, 1);
}

// Only keep keywords for icons that exist.
const keywords: Record<string, string> = {};
for (const [name, kw] of Object.entries(KEYWORDS)) {
  if (icons[name]) keywords[name] = kw;
}

const totalElements = Object.values(icons).reduce((acc, els) => acc + els.length, 0);
const serialized = JSON.stringify({ icons, categories, keywords });
const hash = createHash('sha256').update(serialized).digest('hex').slice(0, 12);

const banner = `// GENERATED FILE — do not edit by hand.
// Source: lucide-react@${pkgJson.version} __iconNode data, curated by
// scripts/generate-lucide-registry.ts (see docs/lucide-icons.md).
// Regenerate with: npx tsx scripts/generate-lucide-registry.ts
// Content hash: ${hash} (${Object.keys(icons).length} icons, ${totalElements} elements)
`;

const body = `${banner}
/** One SVG child element of a Lucide icon (tag + its attributes). */
export type LucideIconElement = { tag: string; attrs: Record<string, string | number> };

/** icon name (kebab-case, e.g. "arrow-right") → its SVG child elements. */
export const LUCIDE_ICONS: Record<string, LucideIconElement[]> = ${JSON.stringify(icons)};

/** category id → icon names (drives the prompt catalog + category filter). */
export const LUCIDE_CATEGORIES: Record<string, string[]> = ${JSON.stringify(categories)};

/** icon name → extra search keywords (semantic hints beyond the name). */
export const LUCIDE_ICON_KEYWORDS: Record<string, string> = ${JSON.stringify(keywords)};

/** lucide-react version the registry was generated from. */
export const LUCIDE_REGISTRY_SOURCE_VERSION = '${pkgJson.version}';
`;

const outPath = join(process.cwd(), 'src', 'lib', 'icons', 'lucide-registry.generated.ts');
writeFileSync(outPath, body, 'utf8');
console.log(`✓ wrote ${outPath}`);
console.log(`  ${Object.keys(icons).length} icons / ${Object.keys(categories).length} categories / ${totalElements} SVG elements (from lucide-react@${pkgJson.version})`);
