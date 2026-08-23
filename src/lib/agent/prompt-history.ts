// prompt-history.ts — terminal-style prompt history for the agent chat input.
//
// ArrowUp recalls the previous prompt (and iterates back through history);
// ArrowDown iterates forward. Persists to localStorage so history survives
// reloads. Capped to keep localStorage lean.
//
// Pure module (no React) so it's unit-testable.

const KEY = 'agentcanvas.prompthistory.v1';
const CAP = 50;

let cache: string[] | null = null;

function load(): string[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
  } catch {
    cache = [];
  }
  return cache!;
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
  } catch {
    // Quota exceeded / private mode — history stays memory-only this session.
  }
}

/// Record a submitted prompt. Dedupes consecutive repeats. Caps length.
export function pushPromptHistory(prompt: string): void {
  const p = prompt.trim();
  if (!p) return;
  const h = load();
  if (h[h.length - 1] === p) return; // consecutive duplicate
  h.push(p);
  while (h.length > CAP) h.shift();
  persist();
}

/// All history, oldest first.
export function getPromptHistory(): string[] {
  return [...load()];
}

/// Navigate: given the current history cursor (-1 = "live input", not
/// navigating) and a direction, return the new cursor and its text.
/// Returns null when there is nothing to recall in that direction.
export function navigateHistory(
  cursor: number,
  direction: 'up' | 'down',
): { cursor: number; text: string } | null {
  const h = load();
  if (h.length === 0) return null;
  if (direction === 'up') {
    // From live input (-1), first Up goes to the newest entry (length-1).
    const next = cursor === -1 ? h.length - 1 : Math.max(-1, cursor - 1);
    if (next < 0) return null;
    return { cursor: next, text: h[next] };
  }
  // Down: move toward newer entries; past index 0 returns to live input.
  if (cursor === -1) return null;
  const next = cursor + 1;
  if (next >= h.length) return { cursor: -1, text: '' };
  return { cursor: next, text: h[next] };
}

/// Test helper: wipe in-memory + persisted history.
export function _resetPromptHistoryForTests(): void {
  cache = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
