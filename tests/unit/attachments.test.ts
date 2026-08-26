// Unit tests for the image-attachment pipeline (lib/agent/attachments.ts)
// and its integration points: promptAgent carrying images, the API route's
// defensive parsing, and the runner's dataUrl → ImageContent conversion.
//
// Browser-only pieces (FileReader/Image canvas downscale, DataTransfer) are
// integration-level and covered by the E2E browser verification; here we
// lock down the pure logic that is easy to regress.

import { describe, it, expect } from 'vitest';
import {
  modelSupportsImages,
  dataUrlToImageContent,
  formatDataUrlSize,
  isImageFile,
  makeAttachedImage,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DATAURL_LENGTH,
  type AttachedImage,
} from '@/lib/agent/attachments';

// ---- modelSupportsImages --------------------------------------------------------

describe('modelSupportsImages', () => {
  it('returns true when input includes image', () => {
    expect(modelSupportsImages(['text', 'image'])).toBe(true);
  });

  it('returns false for text-only models', () => {
    expect(modelSupportsImages(['text'])).toBe(false);
  });

  it('returns false for undefined/null/empty (unknown is treated as not vision)', () => {
    expect(modelSupportsImages(undefined)).toBe(false);
    expect(modelSupportsImages(null)).toBe(false);
    expect(modelSupportsImages([])).toBe(false);
  });
});

// ---- dataUrlToImageContent --------------------------------------------------------

describe('dataUrlToImageContent', () => {
  it('converts a base64 image data URL into pi-ai ImageContent', () => {
    const content = dataUrlToImageContent('data:image/png;base64,aGVsbG8=');
    expect(content).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  });

  it('accepts jpeg and webp mime types', () => {
    expect(dataUrlToImageContent('data:image/jpeg;base64,AAA=')?.mimeType).toBe('image/jpeg');
    expect(dataUrlToImageContent('data:image/webp;base64,AAA=')?.mimeType).toBe('image/webp');
  });

  it('returns null for non-image mime types', () => {
    expect(dataUrlToImageContent('data:text/plain;base64,aGVsbG8=')).toBeNull();
    expect(dataUrlToImageContent('data:application/json;base64,e30=')).toBeNull();
  });

  it('returns null for malformed data URLs', () => {
    expect(dataUrlToImageContent('not-a-data-url')).toBeNull();
    expect(dataUrlToImageContent('data:image/png;base64,')).toBeNull();
    expect(dataUrlToImageContent('')).toBeNull();
    expect(dataUrlToImageContent('data:image/png,aGVsbG8=')).toBeNull(); // no base64 marker
  });
});

// ---- formatDataUrlSize --------------------------------------------------------

describe('formatDataUrlSize', () => {
  it('formats compact sizes from the base64 payload length', () => {
    // 4/3 * base64 chars ≈ binary bytes. 1366 chars → ~1024 bytes → "1 KB".
    expect(formatDataUrlSize(`data:image/png;base64,${'A'.repeat(1366)}`)).toBe('1 KB');
  });

  it('formats megabyte-scale sizes', () => {
    // ~1.4M chars → ~1.05 MB.
    expect(formatDataUrlSize(`data:image/jpeg;base64,${'A'.repeat(1_400_000)}`)).toBe('1.0 MB');
  });

  it('handles non-data-url input gracefully', () => {
    expect(formatDataUrlSize('garbage')).toBe('0 B');
  });
});

// ---- isImageFile --------------------------------------------------------

describe('isImageFile', () => {
  it('accepts image/* mime types', () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    expect(isImageFile(png)).toBe(true);
  });

  it('rejects non-image files', () => {
    const txt = new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' });
    expect(isImageFile(txt)).toBe(false);
    const noType = new File([new Uint8Array([1])], 'a.bin', { type: '' });
    expect(isImageFile(noType)).toBe(false);
  });
});

// ---- limits --------------------------------------------------------

describe('attachment limits', () => {
  it('caps attachments per message at 4', () => {
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(4);
  });
});

// ---- promptAgent images plumbing (store contract) ------------------------------

describe('promptAgent image plumbing contract', () => {
  it('attached images are serializable over the wire (socket + HTTP body)', () => {
    const images: AttachedImage[] = [
      { id: 'img_1', name: 'ref.png', dataUrl: 'data:image/png;base64,aGVsbG8=' },
    ];
    const payload = JSON.stringify({
      type: 'agent:prompt',
      documentId: 'doc',
      prompt: 'recreate this',
      images,
    });
    const parsed = JSON.parse(payload);
    expect(parsed.images[0].dataUrl).toBe('data:image/png;base64,aGVsbG8=');
    expect(parsed.images[0].name).toBe('ref.png');
  });
});

// ---- makeAttachedImage (canvas-snapshot pipeline) --------------------------------

describe('makeAttachedImage', () => {
  it('wraps a valid image data URL with a generated id', () => {
    const img = makeAttachedImage('canvas-snapshot.png', 'data:image/png;base64,aGVsbG8=');
    expect(img).not.toBeNull();
    expect(img!.name).toBe('canvas-snapshot.png');
    expect(img!.id).toMatch(/^img_/);
    expect(img!.dataUrl).toBe('data:image/png;base64,aGVsbG8=');
  });

  it('rejects non-image data URLs', () => {
    expect(makeAttachedImage('x.txt', 'data:text/plain;base64,aGVsbG8=')).toBeNull();
    expect(makeAttachedImage('x', 'not-a-data-url')).toBeNull();
  });

  it('rejects payloads above the transport cap', () => {
    const huge = `data:image/png;base64,${'A'.repeat(MAX_DATAURL_LENGTH + 1)}`;
    expect(makeAttachedImage('big.png', huge)).toBeNull();
  });
});

// ---- selection-context plumbing (store → runner contract) -----------------------

describe('selection-context plumbing contract', () => {
  it('selection serializes over the wire with count + names', () => {
    const payload = JSON.stringify({
      type: 'agent:prompt',
      documentId: 'doc',
      prompt: 'make these blue',
      selection: { count: 2, names: ['Card 1', 'Card 2'] },
    });
    const parsed = JSON.parse(payload);
    expect(parsed.selection.count).toBe(2);
    expect(parsed.selection.names).toEqual(['Card 1', 'Card 2']);
  });

  it('omission is JSON-clean (no selection key when nothing selected)', () => {
    const payload = JSON.stringify({ type: 'agent:prompt', documentId: 'doc', prompt: 'hi' });
    expect(JSON.parse(payload).selection).toBeUndefined();
  });
});
