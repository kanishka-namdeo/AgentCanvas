// TypeScript types for the Design-System Registry.
//
// Mirrors the JSON Schema in `_registry.schema.json` (kept in
// /home/z/my-project/download/design-systems/). Every pack in the
// registry must validate against this shape.
//
// The agent runtime imports these types to know what to expect; the
// API routes use them as response shapes; the picker UI uses them to
// render pack cards.

export interface Dependency {
  /** npm package name, e.g. "tailwindcss" or "@radix-ui/react-dialog". */
  package: string;
  /** Minimum semver, e.g. "3.4.0". Agent checks installed version >= min. */
  min: string;
}

export type BestForTag =
  | 'nextjs'
  | 'fullstack'
  | 'dashboard'
  | 'saas'
  | 'marketing'
  | 'docs'
  | 'enterprise'
  | 'minimal'
  | 'brand';

export type SampleComponentName =
  | 'Button'
  | 'Input'
  | 'Card'
  | 'Dialog'
  | 'Table'
  | 'Toast'
  | 'Tabs'
  | 'Avatar';

export interface SampleComponent {
  name: SampleComponentName;
  /** Full TSX source — references var(--...) tokens, never hardcoded values. */
  code: string;
}

export interface PackPalette {
  primary: string;    // hex
  background: string; // hex
  accent: string;     // hex
  text: string;      // hex
}

export interface PackFontStack {
  body: string;
  heading: string;
  mono: string;
}

export interface ImportMap {
  /** Component name → module path. e.g. "Button" → "@/components/ui/button". */
  [componentName: string]: string;
}

export interface DesignSystemPack {
  /** Lowercase kebab-case identifier. Matches the folder name. */
  name: string;
  version: string; // semver
  description: string; // ≤160 char, shown in AskUserQuestion option
  palette: PackPalette;
  /** Relative path to the tokens.css file inside this pack folder. Always "tokens.css". */
  tokens: string;
  dependencies: Dependency[];
  importMap: ImportMap;
  fontStack: PackFontStack;
  sampleComponents: SampleComponent[];
  bestFor: BestForTag[];
}

export interface DesignSystemRegistry {
  version: string;
  defaultPack: string;
  packs: DesignSystemPack[];
}

/** What the API returns for `GET /api/design-systems` (no tokens, no samples). */
export interface PackSummary {
  name: string;
  version: string;
  description: string;
  palette: PackPalette;
  fontStack: PackFontStack;
  bestFor: BestForTag[];
  isDefault: boolean;
}

/** What the API returns for `GET /api/design-systems/[name]`. */
export interface PackDetail extends PackSummary {
  dependencies: Dependency[];
  importMap: ImportMap;
  sampleComponents: SampleComponent[];
  /** Raw tokens.css content — three layers: primitive → semantic → component. */
  tokensCss: string;
}
