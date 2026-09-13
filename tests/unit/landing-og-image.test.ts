// Task 9 of the landing-page plan — the OG image file convention.
// next/og is mocked so the module imports cleanly under jsdom; the default
// export's options are then asserted against the declared size.

import { describe, it, expect, vi } from 'vitest';

vi.mock('next/og', () => ({
  ImageResponse: class MockImageResponse {
    constructor(
      public element: unknown,
      public options?: { width?: number; height?: number },
    ) {}
  },
}));

import OgImage, { alt, size, contentType } from '@/app/opengraph-image';

describe('landing: OG image', () => {
  it('exports alt text naming the product', () => {
    expect(typeof alt).toBe('string');
    expect(alt).toContain('AgentCanvas');
    expect(alt.length).toBeGreaterThan(10);
  });

  it('exports the 1200x630 size and png content type', () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe('image/png');
  });

  it('builds the ImageResponse with the declared size', () => {
    const response = OgImage() as unknown as {
      options: { width: number; height: number };
      element: unknown;
    };
    expect(response.options).toEqual({ width: 1200, height: 630 });
    expect(response.element).toBeTruthy();
  });
});
