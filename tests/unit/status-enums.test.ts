// Tests for status enum validation (Task 5 fix).
// Verifies that invalid status strings are rejected at the API boundary.

import { describe, it, expect } from 'vitest';
import {
  isValidSessionStatus,
  isValidMessageStatus,
  isValidRunStatus,
  isValidToolCallStatus,
  VALID_SESSION_STATUSES,
  VALID_MESSAGE_STATUSES,
  VALID_RUN_STATUSES,
  VALID_TOOL_CALL_STATUSES,
} from '@/lib/validation/status-enums';

describe('status enum validation', () => {
  describe('isValidSessionStatus', () => {
    it('accepts valid session statuses', () => {
      for (const status of VALID_SESSION_STATUSES) {
        expect(isValidSessionStatus(status)).toBe(true);
      }
    });

    it('rejects invalid session statuses', () => {
      expect(isValidSessionStatus('banana')).toBe(false);
      expect(isValidSessionStatus('')).toBe(false);
      expect(isValidSessionStatus('ACTIVE')).toBe(false); // Case-sensitive.
      expect(isValidSessionStatus(123)).toBe(false);
      expect(isValidSessionStatus(null)).toBe(false);
      expect(isValidSessionStatus(undefined)).toBe(false);
    });
  });

  describe('isValidMessageStatus', () => {
    it('accepts valid message statuses', () => {
      for (const status of VALID_MESSAGE_STATUSES) {
        expect(isValidMessageStatus(status)).toBe(true);
      }
    });

    it('rejects invalid message statuses', () => {
      expect(isValidMessageStatus('streaming_now')).toBe(false);
      expect(isValidMessageStatus('complete')).toBe(true); // Exact match.
      expect(isValidMessageStatus('completed')).toBe(false); // Wrong form.
      expect(isValidMessageStatus('')).toBe(false);
      expect(isValidMessageStatus(42)).toBe(false);
    });
  });

  describe('isValidRunStatus', () => {
    it('accepts valid run statuses', () => {
      for (const status of VALID_RUN_STATUSES) {
        expect(isValidRunStatus(status)).toBe(true);
      }
    });

    it('rejects invalid run statuses', () => {
      expect(isValidRunStatus('running')).toBe(false); // Should be 'in_progress'.
      expect(isValidRunStatus('done')).toBe(false); // Should be 'completed'.
      expect(isValidRunStatus('IN_PROGRESS')).toBe(false); // Case-sensitive.
      expect(isValidRunStatus('')).toBe(false);
      expect(isValidRunStatus({})).toBe(false);
    });
  });

  describe('isValidToolCallStatus', () => {
    it('accepts valid tool call statuses', () => {
      for (const status of VALID_TOOL_CALL_STATUSES) {
        expect(isValidToolCallStatus(status)).toBe(true);
      }
    });

    it('rejects invalid tool call statuses', () => {
      expect(isValidToolCallStatus('started')).toBe(false); // Should be 'running'.
      expect(isValidToolCallStatus('failed')).toBe(false); // Should be 'error'.
      expect(isValidToolCallStatus('')).toBe(false);
      expect(isValidToolCallStatus([])).toBe(false);
    });
  });

  describe('enum arrays', () => {
    it('VALID_SESSION_STATUSES contains expected values', () => {
      expect(VALID_SESSION_STATUSES).toContain('active');
      expect(VALID_SESSION_STATUSES).toContain('archived');
      expect(VALID_SESSION_STATUSES).toHaveLength(2);
    });

    it('VALID_MESSAGE_STATUSES contains expected values', () => {
      expect(VALID_MESSAGE_STATUSES).toContain('streaming');
      expect(VALID_MESSAGE_STATUSES).toContain('complete');
      expect(VALID_MESSAGE_STATUSES).toContain('error');
      expect(VALID_MESSAGE_STATUSES).toContain('cancelled');
      expect(VALID_MESSAGE_STATUSES).toHaveLength(4);
    });

    it('VALID_RUN_STATUSES contains expected values', () => {
      expect(VALID_RUN_STATUSES).toContain('queued');
      expect(VALID_RUN_STATUSES).toContain('in_progress');
      expect(VALID_RUN_STATUSES).toContain('completed');
      expect(VALID_RUN_STATUSES).toContain('failed');
      expect(VALID_RUN_STATUSES).toContain('cancelled');
      expect(VALID_RUN_STATUSES).toHaveLength(9);
    });

    it('VALID_TOOL_CALL_STATUSES contains expected values', () => {
      expect(VALID_TOOL_CALL_STATUSES).toContain('pending');
      expect(VALID_TOOL_CALL_STATUSES).toContain('running');
      expect(VALID_TOOL_CALL_STATUSES).toContain('success');
      expect(VALID_TOOL_CALL_STATUSES).toContain('error');
      expect(VALID_TOOL_CALL_STATUSES).toContain('cancelled');
      expect(VALID_TOOL_CALL_STATUSES).toHaveLength(5);
    });
  });
});
