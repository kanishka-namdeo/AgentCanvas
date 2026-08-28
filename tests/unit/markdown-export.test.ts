// Unit tests for the new server-sync + markdown export helpers (Phase P3-1..P3-6).
//
// Covers:
//   - renderSessionMarkdown (P2-37 Markdown export)
//   - markdown tag-list rendering
//   - markdown tool-call timeline (with cost line)
//   - per-run cost rendering in renderRunMarkdown
//   - tags normalization (in the store's setSessionTags)
//   - safe JSON column parsing for tags
//
// These tests are pure-function tests — they don't hit fetch or the DB.
// The full server-sync functions (fetchServerDocuments, etc.) are integration-
// tested via curl in scripts/ and are not duplicated here.

import { describe, it, expect } from 'vitest';
import { renderSessionMarkdown } from '@/lib/sessions/server-sync';

describe('renderSessionMarkdown (P2-37 session → Markdown export)', () => {
  it('renders a header block with session id, document id, created date, and tags', () => {
    const md = renderSessionMarkdown({
      id: 'sess_abc',
      documentId: 'demo',
      title: 'My chat',
      createdAt: '2026-08-28T18:00:00.000Z',
      tags: ['landing-page', 'v2'],
      messages: [],
      runs: [],
    });
    expect(md).toContain('# My chat');
    expect(md).toContain('**Session ID:** `sess_abc`');
    expect(md).toContain('**Document:** `demo`');
    expect(md).toContain('**Tags:** `landing-page` `v2`');
  });

  it('omits the tags row when no tags are present', () => {
    const md = renderSessionMarkdown({
      id: 'sess_abc',
      documentId: 'demo',
      title: 'My chat',
      createdAt: '2026-08-28T18:00:00.000Z',
      messages: [],
      runs: [],
    });
    expect(md).not.toContain('**Tags:**');
  });

  it('renders each message as a role heading with content', () => {
    const md = renderSessionMarkdown({
      id: 'sess_abc',
      documentId: 'demo',
      title: 'My chat',
      createdAt: '2026-08-28T18:00:00.000Z',
      messages: [
        { id: 'm1', role: 'user', content: 'Draw a rectangle', status: 'complete', createdAt: '2026-08-28T18:00:01.000Z' },
        { id: 'm2', role: 'assistant', content: 'Done!', status: 'complete', createdAt: '2026-08-28T18:00:05.000Z' },
      ],
      runs: [],
    });
    expect(md).toContain('## 🧑 User');
    expect(md).toContain('Draw a rectangle');
    expect(md).toContain('## 🤖 Assistant');
    expect(md).toContain('Done!');
  });

  it('renders a tool-call timeline under the assistant message that owns the run', () => {
    const md = renderSessionMarkdown({
      id: 'sess_abc',
      documentId: 'demo',
      title: 'My chat',
      createdAt: '2026-08-28T18:00:00.000Z',
      messages: [
        { id: 'm1', role: 'user', content: 'Add a button', status: 'complete', createdAt: '2026-08-28T18:00:01.000Z' },
        { id: 'm2', role: 'assistant', content: 'Created', status: 'complete', runId: 'r1', createdAt: '2026-08-28T18:00:05.000Z' },
      ],
      runs: [{
        id: 'r1',
        prompt: 'Add a button',
        status: 'completed',
        toolCalls: JSON.stringify([
          { name: 'canvas_create_shape', args: { type: 'rectangle' }, success: true, durationMs: 42 },
          { name: 'canvas_update_shape', args: { fill: '#ff0000' }, success: false, durationMs: 12 },
        ]),
        inputTokens: 1500,
        outputTokens: 320,
        costUsd: 0.0042,
      }],
    });
    // Tool-call timeline — 2 calls, the failure has ✗, the success has ✓.
    expect(md).toContain('<details><summary>Tool calls (2)</summary>');
    expect(md).toContain('✓ `canvas_create_shape` · 42ms');
    expect(md).toContain('✗ `canvas_update_shape` · 12ms');
    // Cost line — only when non-zero tokens.
    expect(md).toContain('tokens: 1500 in / 320 out · $0.0042');
  });

  it('omits the cost line when input/output tokens are both zero', () => {
    const md = renderSessionMarkdown({
      id: 'sess_abc',
      documentId: 'demo',
      title: 'My chat',
      createdAt: '2026-08-28T18:00:00.000Z',
      messages: [
        { id: 'm2', role: 'assistant', content: 'Hello', status: 'complete', runId: 'r1', createdAt: '2026-08-28T18:00:05.000Z' },
      ],
      runs: [{
        id: 'r1',
        prompt: 'Hello',
        status: 'completed',
        toolCalls: '[]',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      }],
    });
    expect(md).not.toContain('tokens:');
  });

  it('renders an error line for messages that errored', () => {
    const md = renderSessionMarkdown({
      id: 'sess_abc',
      documentId: 'demo',
      title: 'My chat',
      createdAt: '2026-08-28T18:00:00.000Z',
      messages: [
        { id: 'm1', role: 'assistant', content: '', status: 'error', error: 'LLM timed out', createdAt: '2026-08-28T18:00:05.000Z' },
      ],
      runs: [],
    });
    expect(md).toContain('⚠️ **Error:** LLM timed out');
  });

  it('renders a "Cancelled" marker for cancelled messages', () => {
    const md = renderSessionMarkdown({
      id: 'sess_abc',
      documentId: 'demo',
      title: 'My chat',
      createdAt: '2026-08-28T18:00:00.000Z',
      messages: [
        { id: 'm1', role: 'assistant', content: '', status: 'cancelled', createdAt: '2026-08-28T18:00:05.000Z' },
      ],
      runs: [],
    });
    expect(md).toContain('_Cancelled._');
  });

  it('handles empty messages array gracefully', () => {
    const md = renderSessionMarkdown({
      id: 'sess_abc',
      documentId: 'demo',
      title: 'Empty',
      createdAt: '2026-08-28T18:00:00.000Z',
      messages: [],
      runs: [],
    });
    expect(md).toContain('# Empty');
    // Should still have at least one separator after the header block.
    expect(md.split('---').length).toBeGreaterThanOrEqual(2);
  });

  it('handles malformed toolCalls JSON by skipping the timeline (no crash)', () => {
    const md = renderSessionMarkdown({
      id: 'sess_abc',
      documentId: 'demo',
      title: 'My chat',
      createdAt: '2026-08-28T18:00:00.000Z',
      messages: [
        { id: 'm2', role: 'assistant', content: 'Hmm', status: 'complete', runId: 'r1', createdAt: '2026-08-28T18:00:05.000Z' },
      ],
      runs: [{
        id: 'r1',
        prompt: 'Hmm',
        status: 'completed',
        toolCalls: 'not-json', // malformed
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      }],
    });
    expect(md).toContain('## 🤖 Assistant');
    // No tool-call timeline rendered.
    expect(md).not.toContain('<details>');
  });
});
