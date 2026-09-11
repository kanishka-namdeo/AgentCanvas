// Quota-aware localStorage wrapper — detects QuotaExceededError and surfaces
// it to the user via toast notifications instead of silently swallowing.
//
// Both the session store (300ms throttled persist) and the settings store
// (standard Zustand persist) write to localStorage. Without this module,
// quota failures are caught and discarded — the user loses data with no
// feedback. This module:
//   1. Detects QuotaExceededError specifically (err.name === 'QuotaExceededError'
//      or err.code === 22 / 1014 for older browsers)
//   2. Tracks consecutive failures — a single failure shows a toast; 3+ in a
//      row shows a persistent "Storage full" warning
//   3. Calls an optional emergency callback so the session store can attempt
//      a server sync before data is lost
//
// The "persisting must never break the app" invariant is preserved: errors
// are still caught and swallowed, but now with user-visible feedback.

let quotaFailureCount = 0;
let lastQuotaToastId: string | number | null = null;

/// Detect whether an error is a localStorage quota failure.
/// Covers: DOMException 'QuotaExceededError' (standard), code 22 (IE/older),
/// code 1014 (Firefox), and the string match fallback.
export function isQuotaExceededError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014;
  }
  if (err instanceof Error) {
    return err.name === 'QuotaExceededError' ||
      (err as { code?: number }).code === 22 ||
      (err as { code?: number }).code === 1014;
  }
  if (typeof err === 'string' && err.includes('QuotaExceeded')) return true;
  return false;
}

/// Options for the quota-aware write function.
interface QuotaAwareWriteOptions {
  /// Called on the FIRST quota failure (to trigger emergency server sync).
  onFirstFailure?: () => void;
  /// Sonner toast object — pass `toast` from `import { toast } from 'sonner'`.
  /// When null/undefined, no toast is shown (SSR-safe).
  toast?: {
    error: (message: string, opts?: Record<string, unknown>) => string | number;
    dismiss: (id?: string | number) => void;
  } | null;
}

/// Write to localStorage with quota-aware error handling.
/// Returns `true` on success, `false` on quota failure.
/// Non-quota errors are re-thrown (they indicate a real bug, not a full disk).
export function quotaAwareSetItem(
  key: string,
  value: string,
  opts?: QuotaAwareWriteOptions,
): boolean {
  // SSR/test safety: if window is not defined, return false without throwing.
  if (typeof window === 'undefined' || !window.localStorage) {
    return false;
  }

  try {
    window.localStorage.setItem(key, value);
    // Success — reset the failure counter.
    quotaFailureCount = 0;
    return true;
  } catch (err) {
    if (!isQuotaExceededError(err)) {
      // Non-quota error (e.g., security error in private browsing with
      // non-standard behavior). Re-throw — this is unexpected.
      throw err;
    }

    quotaFailureCount++;
    const t = opts?.toast;

    if (quotaFailureCount === 1) {
      // First failure — trigger emergency callback and show initial toast.
      opts?.onFirstFailure?.();
      if (t) {
        lastQuotaToastId = t.error('Storage full', {
          description: 'localStorage quota exceeded. Your data is safe in this tab but may not persist. Try clearing browser data for other sites.',
          duration: 8000,
        });
      }
    } else if (quotaFailureCount >= 3 && t) {
      // 3+ consecutive failures — escalate to a persistent warning.
      if (lastQuotaToastId) {
        t.dismiss(lastQuotaToastId);
        lastQuotaToastId = null;
      }
      lastQuotaToastId = t.error('Storage critically full', {
        description: 'Multiple writes failed. Save important work externally. The app will keep working but cannot persist changes.',
        duration: Infinity,
      });
    }

    return false;
  }
}

/// Reset the quota failure counter (e.g., after the user clears storage).
export function resetQuotaFailureCount(): void {
  quotaFailureCount = 0;
  lastQuotaToastId = null;
}

/// Get the current consecutive failure count (for testing / UI badge).
export function getQuotaFailureCount(): number {
  return quotaFailureCount;
}
