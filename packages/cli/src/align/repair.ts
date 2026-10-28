import { flatSimilarity } from '../text/similarity.js';

/** A side's unit inside a repair window: its words, space-free key, and (timing side) time span. */
export interface WinUnit { words: number[]; key: string; start: number; end: number }

/** Silence between timing words of at least this length may hold words the timing side missed. */
const GAP_MIN = 0.4;
/** The timing side has "far more" text when its characters exceed this multiple of the text side's (+ slack). */
const SURPLUS_FACTOR = 2;
const SURPLUS_SLACK = 2;
/** Longest text (characters) for which the best matching timing sub-run is searched. */
const SEARCH_MAX_CHARS = 120;
/** Below this similarity no timing sub-run resembles the text; position decides instead. */
const NO_MATCH_SIM = 0.3;
/** Above this many timing units, sub-runs start only near the window ends, near the DP's pairs, or at the units
 * sharing most character bigrams with the text. */
const ALL_STARTS = 200;
const EDGE_STARTS = 20;
const SEED_STARTS = 50;

/** Text units placed on a stretch of timing words, to be spread over [start, end]. */
export interface WindowRun { text: WinUnit[]; timing: WinUnit[]; start: number; end: number; similarity: number }

export interface WindowContext {
  /** End of the anchor before the window (seconds), or null at the start of the transcript. */
  prevEnd: number | null;
  /** Start of the anchor after the window, or null at the end of the transcript. */
  nextStart: number | null;
  /** Media duration, when known. */
  duration?: number;
  /** Measured speaking rate, seconds per character. */
  secPerChar: number;
  /**
   * For each unpaired text unit: how many of the window's timing units the DP placed before it (where the timing side
   * missed it); null for paired units.
   */
  position: ReadonlyArray<number | null>;
  /** For each timing unit: did the DP pair it with text? */
  paired: readonly boolean[];
  /** The neighbor the window's text belongs to by punctuation (fill.ts `attachment`). */
  attach: 'prev' | 'next' | null;
}

/** Above this many character pairs, a run's confidence uses character bigrams instead of the edit distance. */
const EXACT_SIMILARITY_CELLS = 1_000_000;

const chars = (us: readonly WinUnit[]): number => us.reduce((s, u) => s + u.key.length, 0);

/** Similarity of two long strings: Dice coefficient of their character bigrams (linear time). */
function bigramSimilarity(x: string, y: string): number {
  const counts = new Map<string, number>();
  for (let k = 0; k + 1 < x.length; k++) counts.set(x.slice(k, k + 2), (counts.get(x.slice(k, k + 2)) ?? 0) + 1);
  let common = 0;
  for (let k = 0; k + 1 < y.length; k++) {
    const c = counts.get(y.slice(k, k + 2)) ?? 0;
    if (c > 0) { common++; counts.set(y.slice(k, k + 2), c - 1); }
  }
  const total = Math.max(0, x.length - 1) + Math.max(0, y.length - 1);
  return total === 0 ? (x === y ? 1 : 0) : (2 * common) / total;
}

const runSimilarity = (x: string, y: string): number =>
  x.length * y.length > EXACT_SIMILARITY_CELLS ? bigramSimilarity(x, y) : flatSimilarity(x, y);
const joined = (us: readonly WinUnit[]): string => us.map((u) => u.key).join('');

/**
 * Plan a repair window: a stretch between trusted anchors where the two sides disagree.
 *
 * The text wins; the only question is where its words were spoken. Timing words show where speech was heard,
 * silences where none was:
 * 1. When the timing side has far more characters (a false start, a sentence the text left out), only the timing
 *    sub-run most similar to the text is used.
 * 2. The timing words form runs separated by silences (≥ GAP_MIN). Each run takes as much text as it holds
 *    characters. Extra text (words the timing side missed) goes into the silences, where the DP put it, weighted by
 *    silence length, never more than fits at a fast pace.
 * 3. Text units are laid out in order by character midpoint. Units on a run share its span (returned); units in a
 *    silence are left to interpolation.
 */
export function planWindow(text: readonly WinUnit[], timingIn: readonly WinUnit[], ctx: WindowContext): WindowRun[] {
  let timing = timingIn;
  let position = ctx.position;
  const LT = chars(text);
  if (timing.length > 1 && chars(timing) > SURPLUS_FACTOR * LT + SURPLUS_SLACK) {
    const [p, q] = bestSubRun(text, timing, ctx);
    timing = timing.slice(p, q + 1);
    position = position.map((x) => (x === null ? null : Math.min(Math.max(0, x - p), timing.length)));
  }

  // runs of timing units, separated by silences
  const runs: Array<{ from: number; to: number; start: number; end: number }> = [];
  for (let k = 0; k < timing.length; k++) {
    const u = timing[k];
    const last = runs[runs.length - 1];
    if (last && u.start - last.end < GAP_MIN) { last.to = k; last.end = Math.max(last.end, u.end); }
    else runs.push({ from: k, to: k, start: u.start, end: u.end });
  }
  // silences: before run r (index r) and after the last run (index runs.length)
  const lo = ctx.prevEnd ?? 0;
  const hi = ctx.nextStart ?? ctx.duration ?? Infinity;
  const silence = runs.map((r, idx) => r.start - (idx === 0 ? lo : runs[idx - 1].end));
  silence.push(hi - runs[runs.length - 1].end);

  // character budget per run and per silence
  const runChars = runs.map((r) => chars(timing.slice(r.from, r.to + 1)));
  const LZ = runChars.reduce((a, b) => a + b, 0);
  const gapChars = silence.map(() => 0);
  const surplus = LT - LZ;
  if (surplus > 0) {
    const need = surplus * ctx.secPerChar;
    // where the DP put the text-only words: right before the first unit of run r = the silence before it
    const prior = silence.map(() => 0);
    text.forEach((u, k) => {
      const x = position[k];
      if (x === null) return;
      const r = x >= timing.length ? runs.length : runs.findIndex((run) => run.from === x);
      if (r >= 0) prior[r] += u.key.length; // otherwise the DP put it inside a run
    });
    const weight = silence.map((d, g) => (d >= GAP_MIN ? Math.min(d, need) * (prior[g] + 1) : 0));
    const total = weight.reduce((a, b) => a + b, 0);
    if (total > 0) {
      silence.forEach((d, g) => {
        gapChars[g] = Math.min((surplus * weight[g]) / total, d / (0.5 * ctx.secPerChar));
      });
    }
  }
  const scale = (LT - gapChars.reduce((a, b) => a + b, 0)) / (LZ || 1);
  const budget: Array<{ run: number | null; size: number }> = [];
  runs.forEach((_, r) => {
    budget.push({ run: null, size: gapChars[r] });
    budget.push({ run: r, size: runChars[r] * scale });
  });
  budget.push({ run: null, size: gapChars[runs.length] });

  // lay the text units out in order by character midpoint
  const perRun: WinUnit[][] = runs.map(() => []);
  let pos = 0;
  let b = 0;
  let edge = budget[0].size;
  for (const u of text) {
    const mid = pos + u.key.length / 2;
    while (b < budget.length - 1 && mid > edge + 1e-9) { b++; edge += budget[b].size; }
    const slot = budget[b].run;
    if (slot !== null) perRun[slot].push(u);
    pos += u.key.length;
  }
  return runs.flatMap((r, k) => {
    if (perRun[k].length === 0) return [];
    const tz = timing.slice(r.from, r.to + 1);
    return [{ text: perRun[k], timing: tz, start: r.start, end: r.end, similarity: runSimilarity(joined(perRun[k]), joined(tz)) }];
  });
}

/**
 * The timing sub-run [p, q] most similar to the text (at most about twice as long); ties go to the closest length,
 * then the earliest. When nothing resembles the text: a sub-run of its length next to the anchor it belongs to by
 * punctuation, else the DP's paired span if about that long. Long texts use the DP's span directly.
 */
function bestSubRun(text: readonly WinUnit[], timing: readonly WinUnit[], ctx: WindowContext): [number, number] {
  const t = joined(text);
  const pairedSpan = (): [number, number] => {
    const p = ctx.paired.indexOf(true);
    return p < 0 ? [0, timing.length - 1] : [p, ctx.paired.lastIndexOf(true)];
  };
  if (t.length > SEARCH_MAX_CHARS) return pairedSpan();
  const maxLen = SURPLUS_FACTOR * t.length + SURPLUS_SLACK;
  let best: [number, number] = [0, 0];
  let bestScore = -1;
  let bestDiff = Infinity;
  for (const p of candidateStarts(t, timing, ctx.paired)) {
    let s = '';
    for (let q = p; q < timing.length; q++) {
      s += timing[q].key;
      if (q > p && s.length > maxLen) break;
      const score = flatSimilarity(t, s);
      const diff = Math.abs(s.length - t.length);
      if (score > bestScore + 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && diff < bestDiff)) {
        best = [p, q];
        bestScore = score;
        bestDiff = diff;
      }
    }
  }
  if (bestScore >= NO_MATCH_SIM) return best;
  if (ctx.attach === null) {
    // the DP's pairs, unless they are scattered over far more than the text could have taken
    const [p, q] = pairedSpan();
    return chars(timing.slice(p, q + 1)) <= maxLen ? [p, q] : best;
  }
  // grow from the anchor's side until the run holds about as many characters as the text
  let p = ctx.attach === 'prev' ? 0 : timing.length - 1;
  let q = p;
  let size = timing[p].key.length;
  while (size < t.length && (ctx.attach === 'prev' ? q + 1 < timing.length : p > 0)) {
    if (ctx.attach === 'prev') size += timing[++q].key.length;
    else size += timing[--p].key.length;
  }
  return [p, q];
}

/** Start indices worth trying for a sub-run (all of them for short windows). */
function candidateStarts(t: string, timing: readonly WinUnit[], paired: readonly boolean[]): number[] {
  const n = timing.length;
  if (n <= ALL_STARTS) return Array.from({ length: n }, (_, k) => k);
  const starts = new Set<number>();
  const around = (from: number, to: number): void => {
    for (let k = Math.max(0, from); k <= Math.min(n - 1, to); k++) starts.add(k);
  };
  around(0, EDGE_STARTS - 1);
  around(n - 1 - SURPLUS_FACTOR * EDGE_STARTS, n - 1);
  const p = paired.indexOf(true);
  if (p >= 0) around(p - EDGE_STARTS, paired.lastIndexOf(true) + EDGE_STARTS);
  // units sharing the most character bigrams with the text
  const grams = new Set<string>();
  for (let k = 0; k + 1 < t.length; k++) grams.add(t.slice(k, k + 2));
  const score = timing.map((u, k) => {
    let hit = 0;
    for (let c = 0; c + 1 < u.key.length; c++) if (grams.has(u.key.slice(c, c + 2))) hit++;
    return { k, s: hit / Math.max(1, u.key.length - 1) };
  });
  score.sort((x, y) => y.s - x.s || x.k - y.k);
  for (const { k } of score.slice(0, SEED_STARTS)) starts.add(k);
  return [...starts].sort((x, y) => x - y);
}
