// chat-mentions.ts — @-mention engine for the agent chat input.
//
// Cursor's most recognizable input affordance after slash commands is the
// @-mention (@file, @docs, @web — see docs/chat-parity.md). Our domain
// equivalent is mentioning CANVAS LAYERS: typing `@` in the input opens a
// fuzzy-matched list of layer names; picking one inserts `@Name` and marks
// that layer as prompt targeting context (merged with the canvas selection
// at submit time — "make @Header sticky" needs no manual selection).
//
// Pure string machinery (no React, no store) so it is unit-testable and can
// be reused by the command palette later.

import type { Shape } from '@/lib/canvas/types';

/// One mentionable canvas layer.
export interface LayerMention {
  id: string;
  name: string;
  type: string;
}

/// Maximum layers offered in the mention menu (render window — the same
/// progressive-disclosure cap the slash-command menu uses).
export const MENTION_MENU_LIMIT = 8;

/// Candidate layers for the menu: top-level-first, name-bearing, visible.
/// Groups/frames surface before leaves so "the big containers" are easy to
/// target; nested children are included but ranked after top-level shapes.
export function mentionableLayers(shapes: Shape[]): LayerMention[] {
  const out: LayerMention[] = [];
  for (const s of shapes) {
    if (s.visible === false) continue;
    if (!s.name || !s.name.trim()) continue;
    out.push({ id: s.id, name: s.name, type: s.type });
  }
  // Groups/frames first (they read as "the X section"), then everything
  // else in document order.
  const isContainer = (t: string) => t === 'group' || t === 'frame' || t === 'section';
  return [...out.filter((l) => isContainer(l.type)), ...out.filter((l) => !isContainer(l.type))];
}

/// Normalize a layer name for matching: lowercase, collapse separators.
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '');
}

/// The active @-token: the substring after the LAST '@' before the caret,
/// valid only when the '@' starts a word and the token has no whitespace.
/// Returns null when the user is not typing a mention.
export function activeMentionToken(input: string, caretIndex = input.length): string | null {
  if (caretIndex < 0 || caretIndex > input.length) return null;
  const before = input.slice(0, caretIndex);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  // '@' must start a word (preceded by start-of-string or whitespace).
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const token = before.slice(at + 1);
  // A space closes the mention (it was already applied or is prose).
  if (/\s/.test(token)) return null;
  return token;
}

/// Rank candidate layers for a mention token.
/// Order: exact (normalized) > prefix > substring > acronym (initials).
export function matchMentions(
  token: string,
  layers: LayerMention[],
  limit = MENTION_MENU_LIMIT,
): LayerMention[] {
  const q = norm(token);
  if (!q) {
    // Bare '@' — the default menu: containers first, document order.
    return layers.slice(0, limit);
  }
  const scored: Array<{ m: LayerMention; score: number }> = [];
  for (const m of layers) {
    const n = norm(m.name);
    let score = 0;
    if (n === q) score = 100;
    else if (n.startsWith(q)) score = 80;
    else if (n.includes(q)) score = 60;
    else if (m.name.split(/[\s_-]+/).filter(Boolean).map((w) => w[0]?.toLowerCase()).join('').startsWith(q)) score = 40;
    if (score > 0) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score || a.m.name.length - b.m.name.length);
  return scored.slice(0, limit).map((s) => s.m);
}

/// Replace the active @-token with the chosen mention (name + trailing
/// space). Returns the new input string. When no active token exists the
/// input is returned unchanged (defensive — UI calls this only with a live
/// token).
export function applyMention(input: string, mention: LayerMention, caretIndex = input.length): string {
  const token = activeMentionToken(input, caretIndex);
  if (token === null) return input;
  const before = input.slice(0, caretIndex);
  const at = before.lastIndexOf('@');
  const after = input.slice(caretIndex);
  // Spaces in layer names are legal; the mention is closed by the trailing
  // space we append (activeMentionToken treats it as prose afterwards).
  return `${input.slice(0, at)}@${mention.name} ${after}`;
}

/// Resolve every `@Name` token in the final prompt to layer ids (fuzzy-safe:
/// exact normalized match only — this is targeting, not search). Unknown
/// names are skipped silently; the prompt text still carries them for the
/// LLM to read.
///
/// Multi-word layer names ("@Hero Section") are matched longest-first against
/// the text that follows the '@' (separator-insensitive, trailing punctuation
/// tolerated). The previous `/@([^\s@]+)/` regex stopped at the first space,
/// so mentioning ANY multi-word layer silently produced no targeting — while
/// applyMention happily inserted those names.
export function extractMentionedLayerIds(input: string, shapes: Shape[]): string[] {
  // Longest name first so "@Hero Section" wins over a hypothetical "@Hero".
  const entries = shapes
    .filter((s) => s.name && s.name.trim())
    .map((s) => ({ id: s.id, name: s.name as string, norm: norm(s.name as string) }))
    .sort((a, b) => b.name.length - a.name.length);
  const ids: string[] = [];
  let i = input.indexOf('@');
  while (i !== -1) {
    // '@' must start a word (same rule as activeMentionToken).
    const startsWord = i === 0 || /\s/.test(input[i - 1]);
    if (startsWord) {
      const rest = input.slice(i + 1);
      for (const e of entries) {
        // Compare the normalized prefix of the same length as the layer name;
        // tolerate trailing punctuation ("@Header, please" → "Header").
        const candidate = rest.slice(0, e.name.length).replace(/[^\w\s-]+$/, '');
        if (candidate && norm(candidate) === e.norm) {
          if (!ids.includes(e.id)) ids.push(e.id);
          break;
        }
      }
    }
    i = input.indexOf('@', i + 1);
  }
  return ids;
}

/// True when the input contains at least one resolvable @-mention — drives
/// the context chip above the input ("@2 mentioned layers").
export function hasMentions(input: string, shapes: Shape[]): boolean {
  return extractMentionedLayerIds(input, shapes).length > 0;
}
