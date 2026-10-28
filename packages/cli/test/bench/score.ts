// Regression gate scores: WER (plain and formatted, bench/lib/normalize.mjs), word timing and cue timing. Timing
// matches tokens in order: the most equal pairs within WINDOW seconds, then the closest in time, so a repeated word
// matches its nearest occurrence.
import { normalizeWords } from '../../../../bench/lib/normalize.mjs';
import { align } from '../../../../bench/lib/wer.mjs';

/** A pair further apart than this (seconds) never matches. */
export const WINDOW = 30;
/** Largest matcher table (reference × hypothesis tokens); about 12 minutes of speech against 12 minutes. */
const MAX_CELLS = 2.5e7;

export interface Timed { text: string; start: number; end?: number }

/**
 * Pairs [i, j] of a monotonic alignment of `ref` and `hyp` tokens maximizing the number of equal pairs whose time
 * distance `dt(i, j)` is at most WINDOW; ties go to the smallest total distance (a pair is worth 1 − dt/1000).
 */
export function matchInOrder(ref: readonly string[], hyp: readonly string[], dt: (i: number, j: number) => number, window = WINDOW): Array<[number, number]> {
  const n = ref.length;
  const m = hyp.length;
  if (n === 0 || m === 0) return [];
  if ((n + 1) * (m + 1) > MAX_CELLS) throw new Error(`regression gate: ${n} × ${m} tokens is too large for the matcher; split the clip`);
  const W = m + 1;
  const D = new Float64Array((n + 1) * W);
  const gain = (i: number, j: number) => {
    if (ref[i] !== hyp[j]) return -1;
    const d = dt(i, j);
    return d <= window ? 1 - d / 1000 : -1;
  };
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let v = Math.max(D[(i + 1) * W + j]!, D[i * W + j + 1]!);
      const g = gain(i, j);
      if (g > 0) v = Math.max(v, D[(i + 1) * W + j + 1]! + g);
      D[i * W + j] = v;
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const g = gain(i, j);
    if (g > 0 && Math.abs(D[i * W + j]! - (D[(i + 1) * W + j + 1]! + g)) < 1e-9) { out.push([i, j]); i++; j++; }
    else if (D[(i + 1) * W + j]! >= D[i * W + j + 1]!) i++;
    else j++;
  }
  return out;
}

const median = (xs: readonly number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2;
};
/** The value at index floor(0.9 n) of the sorted list. */
const p90 = (xs: readonly number[]) => (xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)]!);
const share = (xs: readonly number[], f: (x: number) => boolean) => (xs.length === 0 ? NaN : xs.filter(f).length / xs.length);

export interface TextScore {
  refWords: number;
  /** (S + D + I) / reference tokens, plain normalization (lowercase, no punctuation). */
  wer: number;
  /** The same with casing kept and . , ? as tokens. */
  werFormatted: number;
}

function errorRate(ref: readonly string[], hyp: readonly string[]): number {
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const { ops } = align(ref, hyp);
  return ops.filter((o) => o.op !== 'C').length / ref.length;
}

export function wer(ref: ReadonlyArray<{ text: string }>, hyp: ReadonlyArray<{ text: string }>, lang: string): TextScore {
  const tok = (ws: ReadonlyArray<{ text: string }>, mode: 'plain' | 'formatted') => normalizeWords(ws, lang, mode).map((t) => t.t);
  return {
    refWords: tok(ref, 'plain').length,
    wer: errorRate(tok(ref, 'plain'), tok(hyp, 'plain')),
    werFormatted: errorRate(tok(ref, 'formatted'), tok(hyp, 'formatted')),
  };
}

export interface WordTimingScore {
  /** Hypothesis words matched to a reference word, and reference words. */
  matched: number;
  refWords: number;
  /** Absolute start error of the matched words (seconds). */
  median: number;
  p90: number;
  /** Shares of matched words whose start is within 100 ms / 250 ms. */
  within100: number;
  within250: number;
  /** Matched words more than 1 s off. */
  over1s: number;
}

/** Start error of `hyp` words against `ref` words with times (both sorted by start here). */
export function wordTiming(refIn: readonly Timed[], hypIn: readonly Timed[], lang: string): WordTimingScore {
  const ref = [...refIn].sort((a, b) => a.start - b.start);
  const hyp = [...hypIn].sort((a, b) => a.start - b.start);
  const rt = normalizeWords(ref, lang, 'plain');
  const ht = normalizeWords(hyp, lang, 'plain');
  const pairs = matchInOrder(rt.map((t) => t.t), ht.map((t) => t.t), (i, j) => Math.abs(hyp[ht[j]!.src]!.start - ref[rt[i]!.src]!.start));
  const seen = new Set<number>();
  const errs: number[] = [];
  for (const [i, j] of pairs) {
    const h = ht[j]!.src;
    if (seen.has(h)) continue; // "don't" → "do not": one word, two tokens
    seen.add(h);
    errs.push(Math.abs(hyp[h]!.start - ref[rt[i]!.src]!.start));
  }
  return {
    matched: errs.length, refWords: ref.length, median: median(errs), p90: p90(errs),
    within100: share(errs, (e) => e <= 0.1), within250: share(errs, (e) => e <= 0.25), over1s: errs.filter((e) => e > 1).length,
  };
}

export interface CueTimingScore {
  cues: number;
  /** Reference cues with at least one matched word. */
  matched: number;
  /** Absolute difference between a cue's start and the start of its first matched hypothesis word (seconds). */
  median: number;
  over1s: number;
  over2s: number;
}

/** Per reference cue: the start of the first hypothesis word matched to its text, against the cue's start. */
export function cueTiming(cues: ReadonlyArray<{ start: number; end: number; text: string }>, hypIn: readonly Timed[], lang: string): CueTimingScore {
  const hyp = [...hypIn].sort((a, b) => a.start - b.start);
  const rt = normalizeWords(cues, lang, 'plain'); // src: the cue
  const ht = normalizeWords(hyp, lang, 'plain');
  const pairs = matchInOrder(rt.map((t) => t.t), ht.map((t) => t.t), (i, j) => Math.abs(hyp[ht[j]!.src]!.start - cues[rt[i]!.src]!.start));
  const firstWord = new Map<number, number>();
  for (const [i, j] of pairs) if (!firstWord.has(rt[i]!.src)) firstWord.set(rt[i]!.src, ht[j]!.src);
  const errs = [...firstWord.entries()].map(([c, h]) => Math.abs(hyp[h]!.start - cues[c]!.start));
  return { cues: cues.length, matched: errs.length, median: median(errs), over1s: errs.filter((e) => e > 1).length, over2s: errs.filter((e) => e > 2).length };
}

export interface SpeakerScore {
  /** Reference words with a speaker matched to a hypothesis word with one. */
  matched: number;
  /** Share of them whose hypothesis speaker maps to the reference speaker (best one-to-one mapping). */
  accuracy: number;
  /** Distinct speakers in the hypothesis and in the reference. */
  found: number;
  refSpeakers: number;
}

/**
 * Speaker attribution against reference words with speakers (AMI): the words are matched as in `wordTiming`, then each
 * hypothesis speaker is mapped to at most one reference speaker (greedy on the co-occurrence counts, largest first) and
 * the accuracy is the share of matched words whose mapped speaker is the reference speaker.
 */
export function speakerScore(refIn: ReadonlyArray<Timed & { speaker?: string }>, hypIn: ReadonlyArray<Timed & { speaker?: string }>, lang: string): SpeakerScore | undefined {
  const ref = refIn.filter((w) => w.speaker !== undefined).sort((a, b) => a.start - b.start);
  const hyp = hypIn.filter((w) => w.speaker !== undefined).sort((a, b) => a.start - b.start);
  if (ref.length === 0 || hyp.length === 0) return undefined;
  const rt = normalizeWords(ref, lang, 'plain');
  const ht = normalizeWords(hyp, lang, 'plain');
  const pairs = matchInOrder(rt.map((t) => t.t), ht.map((t) => t.t), (i, j) => Math.abs(hyp[ht[j]!.src]!.start - ref[rt[i]!.src]!.start));
  const counts = new Map<string, number>();
  const seen = new Set<number>();
  for (const [i, j] of pairs) {
    const r = rt[i]!.src;
    if (seen.has(r)) continue;
    seen.add(r);
    const key = `${hyp[ht[j]!.src]!.speaker}\u0000${ref[r]!.speaker}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const used = { h: new Set<string>(), r: new Set<string>() };
  let correct = 0;
  for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const [h, r] = key.split('\u0000') as [string, string];
    if (used.h.has(h) || used.r.has(r)) continue;
    used.h.add(h); used.r.add(r); correct += n;
  }
  return { matched: seen.size, accuracy: seen.size ? correct / seen.size : NaN, found: new Set(hyp.map((w) => w.speaker)).size, refSpeakers: new Set(ref.map((w) => w.speaker)).size };
}
