// draft-store.ts — per-document chat draft persistence.
//
// Cursor keeps your unsent chat input when you switch chats or reload the
// window; losing a half-typed design brief on refresh is the kind of paper
// cut that separates "tool" from "toy". Drafts are keyed by document id and
// stored under a single versioned localStorage key prefix. Pure functions —
// SSR-safe (no-ops without window) and unit-testable.

const KEY_PREFIX = 'agentcanvas.draft.v1:';

function key(documentId: string): string {
  return `${KEY_PREFIX}${documentId}`;
}

export function saveDraft(documentId: string, text: string): void {
  if (typeof window === 'undefined' || !documentId) return;
  try {
    if (!text) {
      window.localStorage.removeItem(key(documentId));
    } else {
      window.localStorage.setItem(key(documentId), text);
    }
  } catch {
    // Quota / private-mode — drafts are best-effort by design.
  }
}

export function loadDraft(documentId: string): string {
  if (typeof window === 'undefined' || !documentId) return '';
  try {
    return window.localStorage.getItem(key(documentId)) ?? '';
  } catch {
    return '';
  }
}

export function clearDraft(documentId: string): void {
  if (typeof window === 'undefined' || !documentId) return;
  try {
    window.localStorage.removeItem(key(documentId));
  } catch {
    // Ignore.
  }
}
