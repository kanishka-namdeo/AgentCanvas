import { describe, it, expect } from 'vitest';
import { inCanvasKeyScope, isEditableTarget, menuLayerOpen } from '@/lib/canvas/shortcuts';

describe('scope gate sanity', () => {
  it('window-targeted events are in canvas scope', () => {
    expect(inCanvasKeyScope(window)).toBe(true);
  });
  it('body is in scope', () => {
    expect(inCanvasKeyScope(document.body)).toBe(true);
  });
  it('button is NOT in scope', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    expect(inCanvasKeyScope(btn)).toBe(false);
    expect(isEditableTarget(btn)).toBe(false);
    btn.remove();
  });
  it('menuLayerOpen false by default', () => {
    expect(menuLayerOpen()).toBe(false);
  });
});
