import { endsSentence, type SpeakerWord } from '../turns.js';

/** A slice of the transcript for one LLM call: [first, last] is sent, [ownFirst, ownLast] may be changed. */
export interface Window { first: number; last: number; ownFirst: number; ownLast: number }

export const WINDOW_WORDS = 1200;
export const WINDOW_OVERLAP = 60;

/**
 * Overlapping windows: each owns up to `maxWords` words, cut at a turn start (preferred) or a sentence start, and shows
 * `overlap` extra words of context on each side.
 */
export function planWindows(words: readonly SpeakerWord[], maxWords = WINDOW_WORDS, overlap = WINDOW_OVERLAP): Window[] {
  // at least one word per window (0, negative or NaN would never advance)
  maxWords = Math.max(1, Math.floor(maxWords) || 1);
  overlap = Math.max(0, Math.floor(overlap) || 0);
  const n = words.length;
  const windows: Window[] = [];
  let s = 0;
  while (s < n) {
    let cut = n;
    if (n - s > maxWords) {
      const limit = s + maxWords;
      let turnCut = -1;
      let sentenceCut = -1;
      for (let c = limit; c > s; c--) {
        if (turnCut < 0 && c > s + maxWords / 2 && words[c].speaker !== words[c - 1].speaker) turnCut = c;
        if (sentenceCut < 0 && endsSentence(words[c - 1].text, { prev: words[c - 2]?.text, next: words[c].text })) sentenceCut = c;
        if (turnCut >= 0) break;
      }
      cut = turnCut >= 0 ? turnCut : sentenceCut >= 0 ? sentenceCut : limit;
    }
    windows.push({ first: Math.max(0, s - overlap), last: Math.min(n - 1, cut - 1 + overlap), ownFirst: s, ownLast: cut - 1 });
    s = cut;
  }
  return windows;
}
