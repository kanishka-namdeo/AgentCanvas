// Tests for quota-aware localStorage wrapper (Task 1 fix).
// Verifies that QuotaExceededError is detected and surfaced via toast.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isQuotaExceededError,
  quotaAwareSetItem,
  resetQuotaFailureCount,
  getQuotaFailureCount,
} from '@/lib/storage/quota-aware';

describe('quota-aware storage', () => {
  beforeEach(() => {
    resetQuotaFailureCount();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetQuotaFailureCount();
  });

  describe('isQuotaExceededError', () => {
    it('detects DOMException with name QuotaExceededError', () => {
      const err = new DOMException('Quota exceeded', 'QuotaExceededError');
      expect(isQuotaExceededError(err)).toBe(true);
    });

    it('detects DOMException with code 22', () => {
      const err = new DOMException('Quota exceeded');
      // `code` is a readonly getter on DOMException — define it directly.
      Object.defineProperty(err, 'code', { value: 22 });
      expect(isQuotaExceededError(err)).toBe(true);
    });

    it('detects DOMException with code 1014 (Firefox)', () => {
      const err = new DOMException('Quota exceeded');
      Object.defineProperty(err, 'code', { value: 1014 });
      expect(isQuotaExceededError(err)).toBe(true);
    });

    it('detects Error with name QuotaExceededError', () => {
      const err = new Error('Quota exceeded');
      err.name = 'QuotaExceededError';
      expect(isQuotaExceededError(err)).toBe(true);
    });

    it('detects string containing QuotaExceeded', () => {
      expect(isQuotaExceededError('QuotaExceededError')).toBe(true);
    });

    it('returns false for non-quota errors', () => {
      expect(isQuotaExceededError(new Error('Network error'))).toBe(false);
      expect(isQuotaExceededError(new TypeError('Type error'))).toBe(false);
      expect(isQuotaExceededError(null)).toBe(false);
      expect(isQuotaExceededError(undefined)).toBe(false);
    });
  });

  describe('quotaAwareSetItem', () => {
    it('returns true on successful write', () => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
      const result = quotaAwareSetItem('test-key', 'test-value');
      expect(result).toBe(true);
      expect(setItemSpy).toHaveBeenCalledWith('test-key', 'test-value');
      setItemSpy.mockRestore();
    });

    it('returns false and calls onFirstFailure on quota error', () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError');
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw quotaErr;
      });
      const onFirstFailure = vi.fn();

      const result = quotaAwareSetItem('test-key', 'test-value', { onFirstFailure });

      expect(result).toBe(false);
      expect(onFirstFailure).toHaveBeenCalledOnce();
      expect(getQuotaFailureCount()).toBe(1);
      setItemSpy.mockRestore();
    });

    it('tracks consecutive failures', () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError');
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw quotaErr;
      });

      quotaAwareSetItem('key1', 'val1');
      expect(getQuotaFailureCount()).toBe(1);

      quotaAwareSetItem('key2', 'val2');
      expect(getQuotaFailureCount()).toBe(2);

      quotaAwareSetItem('key3', 'val3');
      expect(getQuotaFailureCount()).toBe(3);

      setItemSpy.mockRestore();
    });

    it('resets failure count on success', () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError');
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
        .mockImplementationOnce(() => { throw quotaErr; })
        .mockImplementationOnce(() => { throw quotaErr; })
        .mockImplementation(() => {}); // Success on third call

      quotaAwareSetItem('key1', 'val1');
      quotaAwareSetItem('key2', 'val2');
      expect(getQuotaFailureCount()).toBe(2);

      quotaAwareSetItem('key3', 'val3');
      expect(getQuotaFailureCount()).toBe(0);

      setItemSpy.mockRestore();
    });

    it('re-throws non-quota errors', () => {
      const networkErr = new Error('Network error');
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw networkErr;
      });

      expect(() => quotaAwareSetItem('test-key', 'test-value')).toThrow(networkErr);
      expect(getQuotaFailureCount()).toBe(0);

      setItemSpy.mockRestore();
    });
  });
});
