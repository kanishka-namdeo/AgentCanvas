// Tests for v2.1 prototyping + comments types.
//
// Covers:
//   - PenTrigger variants (on_click, after_timeout, on_key_down, etc.)
//   - PenAction variants (navigate, url, set_variable, conditional)
//   - PenTransition (fade/push/smart_animate + easing + cubic-bezier/spring)
//   - PenInteraction (trigger + actions)
//   - PenComment (with anchor + reactions + replies)
//   - PenDocument.comments field
//   - Figma JSON export of comments + styles

import { describe, it, expect } from 'vitest';
import {
  PEN_FORMAT_VERSION,
  isPenDocument,
  type PenDocument,
  type PenTrigger,
  type PenAction,
  type PenTransition,
  type PenInteraction,
  type PenComment,
  type PenEasingType,
  type PenCubicBezier,
  type PenSpringConfig,
} from '@/lib/pen/types';
import { penToFigmaJSON, canvasToPen, penToCanvas } from '@/lib/pen/converters';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';

describe('PenTrigger', () => {
  it('constructs simple click trigger', () => {
    const t: PenTrigger = { type: 'on_click' };
    expect(t.type).toBe('on_click');
  });

  it('constructs after_timeout trigger with timeout', () => {
    const t: PenTrigger = { type: 'after_timeout', timeout: 2000 };
    expect(t.type).toBe('after_timeout');
    expect((t as { timeout: number }).timeout).toBe(2000);
  });

  it('constructs on_key_down with device + keyCodes', () => {
    const t: PenTrigger = {
      type: 'on_key_down',
      device: 'keyboard',
      keyCodes: [13, 27],  // Enter + Escape
    };
    expect(t.type).toBe('on_key_down');
    expect((t as { device: string; keyCodes: number[] }).device).toBe('keyboard');
    expect((t as { keyCodes: number[] }).keyCodes).toEqual([13, 27]);
  });

  it('constructs mouse_enter with delay', () => {
    const t: PenTrigger = { type: 'mouse_enter', delay: 500 };
    expect(t.type).toBe('mouse_enter');
    expect((t as { delay: number }).delay).toBe(500);
  });

  it('constructs on_media_hit with timestamp', () => {
    const t: PenTrigger = { type: 'on_media_hit', mediaHitTime: 5.5 };
    expect(t.type).toBe('on_media_hit');
    expect((t as { mediaHitTime: number }).mediaHitTime).toBe(5.5);
  });

  it('supports all 12 trigger types', () => {
    const triggers: PenTrigger[] = [
      { type: 'on_click' },
      { type: 'on_hover' },
      { type: 'on_press' },
      { type: 'on_drag' },
      { type: 'after_timeout', timeout: 1000 },
      { type: 'mouse_enter' },
      { type: 'mouse_leave' },
      { type: 'mouse_up' },
      { type: 'mouse_down' },
      { type: 'on_key_down', device: 'keyboard', keyCodes: [] },
      { type: 'on_media_hit', mediaHitTime: 0 },
      { type: 'on_media_end' },
    ];
    expect(triggers).toHaveLength(12);
    expect(new Set(triggers.map((t) => t.type)).size).toBe(12);
  });
});

describe('PenAction', () => {
  it('constructs navigate action with transition', () => {
    const transition: PenTransition = {
      type: 'push',
      direction: 'left',
      durationMs: 300,
      easing: 'ease_in_out',
    };
    const a: PenAction = {
      type: 'navigate',
      destinationId: 'frame-2',
      transition,
    };
    expect(a.type).toBe('navigate');
    expect((a as { destinationId: string }).destinationId).toBe('frame-2');
    expect((a as { transition: PenTransition }).transition.type).toBe('push');
  });

  it('constructs url action', () => {
    const a: PenAction = { type: 'url', url: 'https://example.com' };
    expect(a.type).toBe('url');
    expect((a as { url: string }).url).toBe('https://example.com');
  });

  it('constructs set_variable action', () => {
    const a: PenAction = { type: 'set_variable', variableId: 'var-1', value: '#ff0000' };
    expect(a.type).toBe('set_variable');
    expect((a as { variableId: string }).variableId).toBe('var-1');
  });

  it('constructs set_variable_mode action', () => {
    const a: PenAction = {
      type: 'set_variable_mode',
      variableCollectionId: 'theme',
      modeId: 'dark',
    };
    expect(a.type).toBe('set_variable_mode');
  });

  it('constructs conditional action with nested actions', () => {
    const a: PenAction = {
      type: 'conditional',
      condition: '$mode === "dark"',
      trueAction: { type: 'navigate', destinationId: 'frame-dark' },
      falseAction: { type: 'navigate', destinationId: 'frame-light' },
    };
    expect(a.type).toBe('conditional');
    expect((a as { trueAction: PenAction }).trueAction.type).toBe('navigate');
  });

  it('constructs media runtime actions', () => {
    const play: PenAction = {
      type: 'update_media_runtime',
      destinationId: 'video-1',
      mediaAction: 'play',
    };
    expect(play.type).toBe('update_media_runtime');
    expect((play as { mediaAction: string }).mediaAction).toBe('play');
  });

  it('constructs back / close actions', () => {
    const back: PenAction = { type: 'back' };
    const close: PenAction = { type: 'close' };
    expect(back.type).toBe('back');
    expect(close.type).toBe('close');
  });
});

describe('PenTransition', () => {
  it('constructs a fade transition', () => {
    const t: PenTransition = { type: 'fade', durationMs: 200 };
    expect(t.type).toBe('fade');
    expect(t.durationMs).toBe(200);
  });

  it('constructs a smart_animate transition (no direction needed)', () => {
    const t: PenTransition = {
      type: 'smart_animate',
      durationMs: 400,
      easing: 'gentle',
    };
    expect(t.type).toBe('smart_animate');
    expect(t.easing).toBe('gentle');
  });

  it('constructs a custom cubic-bezier transition', () => {
    const bezier: PenCubicBezier = { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
    const t: PenTransition = {
      type: 'move_in',
      direction: 'up',
      durationMs: 300,
      easing: 'custom_cubic_bezier',
      cubicBezier: bezier,
    };
    expect(t.easing).toBe('custom_cubic_bezier');
    expect(t.cubicBezier?.x1).toBe(0.42);
  });

  it('constructs a custom spring transition', () => {
    const spring: PenSpringConfig = { stiffness: 200, damping: 20, mass: 1 };
    const t: PenTransition = {
      type: 'push',
      direction: 'left',
      durationMs: 500,
      easing: 'custom_spring',
      springConfig: spring,
    };
    expect(t.easing).toBe('custom_spring');
    expect(t.springConfig?.stiffness).toBe(200);
  });

  it('supports all 13 easing types', () => {
    const easings: PenEasingType[] = [
      'ease_in', 'ease_out', 'ease_in_out', 'linear',
      'ease_in_back', 'ease_out_back', 'ease_in_out_back',
      'gentle', 'quick', 'bouncy', 'slow',
      'custom_cubic_bezier', 'custom_spring',
    ];
    expect(new Set(easings).size).toBe(13);
  });
});

describe('PenInteraction', () => {
  it('combines a trigger with multiple actions', () => {
    const interaction: PenInteraction = {
      trigger: { type: 'on_click' },
      actions: [
        { type: 'navigate', destinationId: 'frame-2', transition: { type: 'fade', durationMs: 200 } },
        { type: 'set_variable', variableId: 'clicked', value: true },
      ],
    };
    expect(interaction.trigger.type).toBe('on_click');
    expect(interaction.actions).toHaveLength(2);
    expect(interaction.actions[0].type).toBe('navigate');
    expect(interaction.actions[1].type).toBe('set_variable');
  });
});

describe('PenComment', () => {
  it('constructs a comment anchored to a node', () => {
    const c: PenComment = {
      id: 'c1',
      author: 'ada',
      body: 'This button should be larger',
      createdAt: '2026-01-01T00:00:00Z',
      anchor: { nodeId: 'btn-submit' },
    };
    expect(c.author).toBe('ada');
    expect(c.anchor?.nodeId).toBe('btn-submit');
  });

  it('constructs a comment anchored to a canvas point', () => {
    const c: PenComment = {
      id: 'c2',
      author: 'bob',
      body: 'Review this area',
      createdAt: '2026-01-01T00:00:00Z',
      anchor: { x: 100, y: 200 },
    };
    expect(c.anchor?.x).toBe(100);
    expect(c.anchor?.y).toBe(200);
  });

  it('supports reactions', () => {
    const c: PenComment = {
      id: 'c3',
      author: 'ada',
      body: 'Looks great',
      createdAt: '2026-01-01T00:00:00Z',
      reactions: [
        { emoji: '👍', user: 'bob' },
        { emoji: '🎉', user: 'cara' },
      ],
    };
    expect(c.reactions).toHaveLength(2);
    expect(c.reactions?.[0].emoji).toBe('👍');
  });

  it('supports threaded replies', () => {
    const c: PenComment = {
      id: 'c4',
      author: 'ada',
      body: 'Question about this layout',
      createdAt: '2026-01-01T00:00:00Z',
      replies: [
        { id: 'c4-r1', author: 'bob', body: 'Answer', createdAt: '2026-01-01T01:00:00Z' },
      ],
    };
    expect(c.replies).toHaveLength(1);
    expect(c.replies?.[0].author).toBe('bob');
  });

  it('supports resolved status', () => {
    const c: PenComment = {
      id: 'c5',
      author: 'ada',
      body: 'Fixed',
      createdAt: '2026-01-01T00:00:00Z',
      resolved: true,
    };
    expect(c.resolved).toBe(true);
  });
});

describe('PenDocument.comments', () => {
  it('PenDocument accepts a comments field', () => {
    const doc: PenDocument = {
      version: PEN_FORMAT_VERSION,
      comments: [
        { id: 'c1', author: 'ada', body: 'hi', createdAt: '2026-01-01T00:00:00Z' },
      ],
      children: [],
    };
    expect(doc.comments).toHaveLength(1);
    expect(isPenDocument(doc)).toBe(true);
  });

  it('PenDocument works without comments', () => {
    const doc: PenDocument = {
      version: PEN_FORMAT_VERSION,
      children: [],
    };
    expect(doc.comments).toBeUndefined();
    expect(isPenDocument(doc)).toBe(true);
  });
});

describe('Figma JSON export: comments + styles', () => {
  it('exports comments in Figma comment shape', () => {
    const doc: PenDocument = {
      version: PEN_FORMAT_VERSION,
      comments: [
        {
          id: 'c1',
          author: 'ada',
          body: 'Make this bigger',
          createdAt: '2026-01-01T00:00:00Z',
          anchor: { nodeId: 'btn-1', x: 10, y: 20 },
        },
      ],
      children: [],
    };
    const fig = penToFigmaJSON(doc) as { comments: Array<Record<string, unknown>> };
    expect(fig.comments).toHaveLength(1);
    const c = fig.comments[0];
    expect(c.message).toBe('Make this bigger');
    expect(c.user).toEqual({ handle: 'ada' });
    expect(c.resolved).toBe(false);
    const meta = c.client_meta as { node_id: string; node_offset: { x: number; y: number } };
    expect(meta.node_id).toBe('btn-1');
    expect(meta.node_offset).toEqual({ x: 10, y: 20 });
  });

  it('exports style/* prefixed variables as Figma styles', () => {
    const doc: PenDocument = {
      version: PEN_FORMAT_VERSION,
      variables: {
        'style/brand.primary': { type: 'color', value: '#3b82f6' },
        'style/heading.h1': { type: 'number', value: 32 },
        'brand.unrelated': { type: 'color', value: '#ff0000' },
      },
      children: [],
    };
    const fig = penToFigmaJSON(doc) as { styles: Record<string, { name: string; styleType: string }> };
    expect(Object.keys(fig.styles)).toHaveLength(2);
    expect(fig.styles['style/brand.primary'].name).toBe('brand.primary');
    expect(fig.styles['style/brand.primary'].styleType).toBe('FILL');
    expect(fig.styles['style/heading.h1'].styleType).toBe('TEXT');
  });
});

describe('canvasToPen / penToCanvas: comments round-trip', () => {
  it('canvasToPen preserves comments', () => {
    const canvas = createEmptyCanvasDocument('rt-1', 'Test');
    (canvas as CanvasDocument & { comments?: PenComment[] }).comments = [
      { id: 'c1', author: 'ada', body: 'hi', createdAt: '2026-01-01T00:00:00Z' },
    ];
    const pen = canvasToPen(canvas);
    expect(pen.comments).toHaveLength(1);
    expect(pen.comments?.[0].body).toBe('hi');
  });

  it('penToCanvas preserves comments', () => {
    const pen: PenDocument = {
      version: PEN_FORMAT_VERSION,
      comments: [
        { id: 'c1', author: 'ada', body: 'hi', createdAt: '2026-01-01T00:00:00Z' },
      ],
      children: [],
    };
    const canvas = penToCanvas(pen, 'doc-1');
    const comments = (canvas as CanvasDocument & { comments?: PenComment[] }).comments;
    expect(comments).toHaveLength(1);
    expect(comments?.[0].author).toBe('ada');
  });

  it('round-trips comments through canvas → pen → canvas', () => {
    const canvas = createEmptyCanvasDocument('rt-2', 'Round Trip');
    (canvas as CanvasDocument & { comments?: PenComment[] }).comments = [
      {
        id: 'c1', author: 'ada', body: 'Original comment',
        createdAt: '2026-01-01T00:00:00Z',
        resolved: false,
        reactions: [{ emoji: '👍', user: 'bob' }],
      },
    ];
    const pen = canvasToPen(canvas);
    const back = penToCanvas(pen, 'rt-2');
    const comments = (back as CanvasDocument & { comments?: PenComment[] }).comments;
    expect(comments).toEqual([
      {
        id: 'c1', author: 'ada', body: 'Original comment',
        createdAt: '2026-01-01T00:00:00Z',
        resolved: false,
        reactions: [{ emoji: '👍', user: 'bob' }],
      },
    ]);
  });
});
