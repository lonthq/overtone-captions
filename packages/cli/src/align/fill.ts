import type { MatchKind } from 'overtone-format';
import { langOf } from '../lang/index.js';
import { endsSentence } from '../turns.js';
import type { AlignedWord } from '../types.js';
import { naturalLength, spokenLength, splitSpan } from './rate.js';

/** Timing of one text word while aligning (seconds, unrounded). */
export interface Timing { start: number; end: number; speaker: string; match: MatchKind; confidence: number }

export const DEFAULT_SPEAKER = 'S1';
/** Shortest word the output may contain (also bounded by minWordDuration). */
const FINAL_MIN_DURATION = 0.05;

/** How strongly a display word ends a phrase: 2 = sentence end (`endsSentence`), 1 = clause end (, ; :), 0 = none. */
function boundaryAfter(word: string | undefined): number {
  if (word === undefined) return 2;
  if (endsSentence(word)) return 2;
  return /[,;:]["'”’»)\]}]*$/u.test(word) ? 1 : 0;
}

/**
 * Which neighbor do text words [i, j] belong to? The side without the stronger phrase boundary:
 * "coming. | And welcome | Ruud." → next; "Hello | Qxyz. | Thank" → prev; otherwise null. Decides which side of a
 * silence missed words go to (repair.ts) and whose speaker they take.
 */
export function attachment(textWords: readonly string[], i: number, j: number): 'prev' | 'next' | null {
  const before = boundaryAfter(textWords[i - 1]);
  const after = boundaryAfter(textWords[j]);
  return before > after ? 'next' : after > before ? 'prev' : null;
}

export interface FillOptions { duration?: number; minWordDuration: number; secPerChar: number; language?: string }

/**
 * Give every word no engine heard an unknown time ("interpolated", confidence 0) between its timed neighbors.
 * A run gets its natural length (speaking rate × spoken length, at least minWordDuration per word) centered in the
 * gap, or the whole gap when that is shorter. At the start or end it sits next to its neighbor, never past the
 * duration. Neighbors lend time when a gap is too small for the minimum durations.
 * Speaker: the word before (at the start, the word after); between two speakers, the side its phrase goes with
 * (`attachment`), since a caption never spans a speaker change. The line cutter does not read the gaps around these
 * words as pauses (segment/splitter.ts).
 */
export function interpolate(textWords: readonly string[], result: Array<Timing | null>, o: FillOptions): void {
  const minDur = o.minWordDuration;
  const lang = langOf(o.language);
  const duration = o.duration !== undefined && o.duration > 0 ? o.duration : undefined;
  let i = 0;
  while (i < result.length) {
    if (result[i]) { i++; continue; }
    let j = i;
    while (j + 1 < result.length && !result[j + 1]) j++;
    const prev = i > 0 ? result[i - 1] : null;
    const next = j + 1 < result.length ? result[j + 1] : null;
    const weights: number[] = [];
    for (let k = i; k <= j; k++) weights.push(spokenLength(textWords[k]!, lang));
    const need = weights.length * minDur;
    let natural = 0;
    for (let k = i; k <= j; k++) natural += naturalLength(textWords[k]!, o.secPerChar, minDur, lang);
    let lo: number;
    let hi: number;
    if (!prev && !next) {
      lo = 0;
      hi = duration ?? natural;
    } else {
      lo = prev ? prev.end : Math.max(0, next!.start - natural);
      hi = next ? next.start : prev!.end + natural;
      if (!next && duration !== undefined) hi = Math.max(lo, Math.min(hi, duration));
      if (prev && next && hi - lo > natural) {
        lo += (hi - lo - natural) / 2;
        hi = lo + natural;
      }
      let short = need - (hi - lo);
      if (short > 0 && prev) {
        const take = Math.min(next ? short / 2 : short, Math.max(0, prev.end - prev.start - minDur));
        prev.end -= take; lo -= take; short -= take;
      }
      if (short > 0 && next) {
        const take = Math.min(short, Math.max(0, next.end - next.start - minDur));
        next.start += take; hi += take; short -= take;
      }
      if (short > 0 && !next) hi = duration === undefined ? hi + short : Math.max(lo, Math.min(hi + short, duration));
    }
    const side = prev && next && prev.speaker !== next.speaker ? attachment(textWords, i, j) : null;
    const speaker = side === 'next' ? next!.speaker : prev?.speaker ?? next?.speaker ?? DEFAULT_SPEAKER;
    splitSpan(lo, Math.max(lo, hi), weights).forEach(([s, e], k) => {
      result[i + k] = { start: s, end: e, speaker, match: 'interpolated', confidence: 0 };
    });
    i = j + 1;
  }
}

/**
 * Round to milliseconds and make words ordered, non-overlapping and non-empty. On overlap the previous word ends
 * where the next starts, keeping a minimum duration (pushing the next word if needed). With a known duration the
 * last words are pulled back inside it, shrinking the minimum to fit (down to 1 ms). Under 1 ms per word, words end
 * after the duration (start < end wins).
 */
export function finalize(textWords: readonly string[], result: ReadonlyArray<Timing>, o: { duration?: number; minWordDuration: number }): AlignedWord[] {
  const n = textWords.length;
  const D = o.duration !== undefined && o.duration > 0 ? Math.floor(o.duration * 1000) : undefined;
  let minMs = Math.max(1, Math.round(Math.min(FINAL_MIN_DURATION, o.minWordDuration) * 1000));
  if (D !== undefined && n > 0) minMs = Math.max(1, Math.min(minMs, Math.floor(D / n)));
  const S = result.map((r) => Math.max(0, Math.round(r.start * 1000)));
  const E = result.map((r, i) => Math.max(S[i]!, Math.round(r.end * 1000)));
  for (let i = 0; i < n; i++) {
    if (i > 0 && S[i]! < E[i - 1]!) {
      const cut = Math.max(S[i]!, S[i - 1]! + minMs);
      E[i - 1] = cut;
      S[i] = cut;
    }
    if (E[i]! < S[i]! + minMs) E[i] = S[i]! + minMs;
  }
  if (D !== undefined && n > 0 && E[n - 1]! > D && D >= n * minMs) {
    // pull the last words back inside the media
    let limit = D;
    for (let i = n - 1; i >= 0 && E[i]! > limit; i--) {
      E[i] = limit;
      if (S[i]! > E[i]! - minMs) S[i] = E[i]! - minMs;
      limit = S[i]!;
    }
  }
  return textWords.map((text, i) => {
    const r = result[i]!;
    return { text, start: S[i]! / 1000, end: E[i]! / 1000, speaker: r.speaker, match: r.match, confidence: r.confidence };
  });
}
