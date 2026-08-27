// Complete the registry: finish radix-themes entry + add tailwind-catalyst.
// Copies the shared sampleComponents (ds-* convention) from shadcn-default.
import { readFileSync, writeFileSync } from 'node:fs';

const path = '/home/z/my-project/src/lib/design-systems/registry.json';
const raw = readFileSync(path, 'utf-8');

// The file is currently truncated mid-entry (ends after radix-themes fontStack).
// Strategy: parse what we can't — instead, strip the dangling radix-themes stub
// and rebuild both new entries programmatically.
const trimmed = raw.trimEnd();
// Remove the dangling radix entry (from `,\n    {\n      "name": "radix-themes"` to EOF).
const cutIdx = trimmed.indexOf('{\n      "name": "radix-themes"');
let base = trimmed.slice(0, cutIdx).trimEnd();
// `base` now ends at the mantine entry's closing `}` (before the removed comma).
if (base.endsWith(',')) base = base.slice(0, -1);

const parsed = JSON.parse(base + '\n  ]\n}');
const shadcn = parsed.packs.find((p) => p.name === 'shadcn-default');

parsed.packs.push({
  name: 'radix-themes',
  version: '1.0.0',
  description:
    'Indigo accent on cool gray, soft tinted panels, 6px radii. Radix Themes — accessible, themeable components for polished product UIs.',
  palette: { primary: '#3e63dd', background: '#fcfcfd', accent: '#3e63dd', text: '#2a2e37' },
  tokens: 'tokens.css',
  dependencies: [
    { package: '@radix-ui/themes', min: '3.0.0' },
    { package: 'tailwindcss', min: '3.4.0' },
    { package: '@radix-ui/react-icons', min: '1.3.0' },
  ],
  importMap: {
    Button: '@radix-ui/themes',
    Input: '@radix-ui/themes',
    Card: '@radix-ui/themes',
    Dialog: '@radix-ui/themes',
    Table: '@radix-ui/themes',
    Toast: '@radix-ui/themes',
    Tabs: '@radix-ui/themes',
    Avatar: '@radix-ui/themes',
  },
  fontStack: {
    body: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
    heading: 'Inter, system-ui, -apple-system, sans-serif',
    mono: "'Roboto Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  },
  sampleComponents: shadcn.sampleComponents,
  bestFor: ['nextjs', 'fullstack', 'saas', 'marketing'],
});

parsed.packs.push({
  name: 'tailwind-catalyst',
  version: '1.0.0',
  description:
    'Zinc neutrals, ink-black buttons, 8px radii, indigo focus rings. Tailwind Labs Catalyst — Headless UI kit made to be owned.',
  palette: { primary: '#09090b', background: '#fafafa', accent: '#4f46e5', text: '#09090b' },
  tokens: 'tokens.css',
  dependencies: [
    { package: 'tailwindcss', min: '4.0.0' },
    { package: '@headlessui/react', min: '2.2.0' },
    { package: 'lucide-react', min: '0.475.0' },
  ],
  importMap: {
    Button: '@/components/catalyst/button',
    Input: '@/components/catalyst/input',
    Card: '@/components/catalyst/card',
    Dialog: '@/components/catalyst/dialog',
    Table: '@/components/catalyst/table',
    Toast: '@/components/catalyst/toast',
    Tabs: '@/components/catalyst/tabs',
    Avatar: '@/components/catalyst/avatar',
  },
  fontStack: {
    body: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
    heading: 'Inter, system-ui, -apple-system, sans-serif',
    mono: "ui-monospace, 'SF Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
  },
  sampleComponents: shadcn.sampleComponents,
  bestFor: ['fullstack', 'saas', 'dashboard', 'minimal'],
});

writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n');
console.log('packs:', parsed.packs.map((p) => p.name).join(', '));
console.log('descriptions ok:', parsed.packs.every((p) => p.description.length <= 160));
