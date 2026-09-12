// Vitest setup — runs before every test file.
//
// Provides:
//   - jest-dom matchers (toBeInTheDocument, toHaveAttribute, etc.)
//   - Polyfills for browser APIs that jsdom doesn't implement but our
//     code relies on (crypto.randomUUID, matchMedia, ResizeObserver).

import '@testing-library/jest-dom/vitest';

// crypto.randomUUID is available in Node 19+ but not in older jsdom.
if (!globalThis.crypto) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  globalThis.crypto = require('node:crypto').webcrypto as Crypto;
}

// matchMedia — jsdom doesn't implement it; some components check it.
if (!globalThis.matchMedia) {
  globalThis.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// ResizeObserver — used by react-resizable-panels; jsdom lacks it.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// SVG element prototypes — jsdom doesn't implement getBBox / getCTM which
// some SVG code paths call. Provide no-op shims so they don't throw.
if (typeof SVGElement !== 'undefined') {
  const proto = SVGElement.prototype as any;
  if (!proto.getBBox) {
    proto.getBBox = () => ({ x: 0, y: 0, width: 100, height: 100 });
  }
}

// IntersectionObserver — motion's whileInView (Magic UI BlurFade etc.) needs
// it and jsdom doesn't implement it. The stub fires the callback immediately
// with isIntersecting: true so in-view content renders visible in tests.
// (Only defined when missing — production code is unaffected.)
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      const entry = { isIntersecting: true, target } as unknown as IntersectionObserverEntry;
      this.callback([entry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}
