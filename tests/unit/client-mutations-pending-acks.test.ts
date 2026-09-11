// Tests for pending acks tracking (Task 12 fix).
// Verifies that in-flight mutations are tracked and can be re-emitted on reconnect.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recordPendingAck,
  clearPendingAck,
  getStalePendingAcks,
  clearAllPendingAcks,
  __resetClientMutationsForTests,
} from '@/lib/canvas/client-mutations';

describe('client-mutations pending acks', () => {
  beforeEach(() => {
    __resetClientMutationsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetClientMutationsForTests();
    vi.useRealTimers();
  });

  it('records a pending ack', () => {
    recordPendingAck(1);
    recordPendingAck(2);

    // Not stale yet (just recorded).
    expect(getStalePendingAcks()).toEqual([]);
  });

  it('returns stale pending acks after timeout', () => {
    recordPendingAck(1);
    recordPendingAck(2);

    // Advance time past the 5-second timeout.
    vi.advanceTimersByTime(6000);

    const stale = getStalePendingAcks();
    expect(stale).toEqual([1, 2]);
  });

  it('does not return pending acks before timeout', () => {
    recordPendingAck(1);

    // Advance time to 4 seconds (just under the 5-second timeout).
    vi.advanceTimersByTime(4000);

    expect(getStalePendingAcks()).toEqual([]);

    // Advance to 6 seconds total.
    vi.advanceTimersByTime(2000);

    expect(getStalePendingAcks()).toEqual([1]);
  });

  it('clears a specific pending ack', () => {
    recordPendingAck(1);
    recordPendingAck(2);
    recordPendingAck(3);

    vi.advanceTimersByTime(6000);

    clearPendingAck(2);

    const stale = getStalePendingAcks();
    expect(stale).toEqual([1, 3]);
  });

  it('clears all pending acks', () => {
    recordPendingAck(1);
    recordPendingAck(2);
    recordPendingAck(3);

    vi.advanceTimersByTime(6000);

    clearAllPendingAcks();

    expect(getStalePendingAcks()).toEqual([]);
  });

  it('respects cap of 100 pending acks', () => {
    // Record 150 pending acks.
    for (let i = 1; i <= 150; i++) {
      recordPendingAck(i);
    }

    vi.advanceTimersByTime(6000);

    const stale = getStalePendingAcks();
    // Should only have the last 100 (51-150).
    expect(stale).toHaveLength(100);
    expect(stale[0]).toBe(51);
    expect(stale[99]).toBe(150);
  });

  it('handles clearing non-existent ack gracefully', () => {
    recordPendingAck(1);

    // Clear an ack that doesn't exist.
    clearPendingAck(999);

    vi.advanceTimersByTime(6000);

    // Original ack should still be there.
    expect(getStalePendingAcks()).toEqual([1]);
  });

  it('handles multiple clear calls for the same ack', () => {
    recordPendingAck(1);

    clearPendingAck(1);
    clearPendingAck(1); // Second clear should be a no-op.

    vi.advanceTimersByTime(6000);

    expect(getStalePendingAcks()).toEqual([]);
  });
});
