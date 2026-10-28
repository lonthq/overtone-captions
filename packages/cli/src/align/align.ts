import { roundTime, type MatchKind } from 'overtone-format';
import type { AlignedWord, Heard, TimedWord } from '../types.js';
import { langOf, type Lang } from '../lang/index.js';
import { normalizeWords, type NormWord } from '../text/normalize.js';
import { alignUnits, extendMerges, type Op } from './dp.js';
import { DEFAULT_SPEAKER, attachment, finalize, interpolate, type Timing } from './fill.js';
import { charWeight, speakingRate, splitSpan } from './rate.js';
import { planWindow, type WinUnit } from './repair.js';

export interface AlignOptions {
  /** BCP-47 language of the text ("en", "nl-NL", …); selects number words and contractions. */
  language?: string;
  /** Media duration in seconds: words never end after it; spreads the text when the timing side is empty. */
  duration?: number;
  /** DP band half-width for long stretches without anchors (default 100 units; see alignUnits). */
  band?: number;
}

/** Shortest time an untimed word gets (seconds). */
export const MIN_WORD_DURATION = 0.1;
/** Pairs below this similarity are not trusted as anchors; they go to a repair window. */
const ANCHOR_MIN_SIM = 0.5;

/**
 * A word no engine heard: its time is an estimate (fill.ts `interpolate`). An edit that replaces such a word keeps
 * `untimed` (refine/edits.ts), though its match is "edited".
 */
export const isUntimed = (w: { match?: MatchKind; untimed?: boolean }): boolean => w.match === 'interpolated' || w.untimed === true;

/**
 * Did an engine hear this word? Exact, merge, split, or a fuzzy match at least as similar as an anchor (a repair
 * window's guess from unrelated words does not count).
 */
export const isHeard = (w: { match?: MatchKind; confidence?: number }): boolean =>
  w.match !== undefined && w.match !== 'interpolated' && w.match !== 'edited' && (w.match !== 'fuzzy' || (w.confidence ?? 0) >= ANCHOR_MIN_SIM);
/** Short keys (≤ 3 characters) need more: "to" ↔ "go" (0.5) proves nothing inside garbled speech. */
const ANCHOR_MIN_SIM_SHORT = 0.66;
const SHORT_KEY = 3;

interface UnitSpan { first: number; last: number; key: string; filler: boolean }

/** Group words into units: a word with a key plus the continuation and empty words after it. */
function buildUnits(norm: readonly NormWord[]): UnitSpan[] {
  const units: UnitSpan[] = [];
  norm.forEach((w, i) => {
    if (w.key !== '' && !w.cont) units.push({ first: i, last: i, key: w.key, filler: w.filler });
    else if (units.length > 0) units[units.length - 1].last = i;
  });
  if (units.length > 0) units[0].first = 0; // leading empty words join the first unit
  return units;
}

function wordsOf(units: readonly UnitSpan[], range: [number, number] | null): number[] {
  if (!range) return [];
  const out: number[] = [];
  for (let u = range[0]; u <= range[1]; u++) for (let w = units[u].first; w <= units[u].last; w++) out.push(w);
  return out;
}

const flatKey = (u: UnitSpan): string => u.key.replace(/ /g, '');

function speakerAt(timed: readonly TimedWord[], idx: readonly number[], t: number): string {
  let best = idx[0];
  let bestDist = Infinity;
  for (const k of idx) {
    const w = timed[k];
    const d = t < w.start ? w.start - t : t > w.end ? t - w.end : 0;
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return timed[best]?.speaker ?? DEFAULT_SPEAKER;
}

function spanOf(timed: readonly TimedWord[], Z: readonly number[]): [number, number] {
  let start = Infinity;
  let end = -Infinity;
  for (const z of Z) { start = Math.min(start, timed[z].start); end = Math.max(end, timed[z].end); }
  return [start, end];
}

const SCALE = /^(hundred|thousand|million|billion|honderd|duizend|miljoen|miljard)$/;

/** Does this display word say (part of) a number ("25", "twenty", "€12", "thousand"; not "percent", "euro")? */
function isNumberWord(word: string, lang: Lang): boolean {
  const key = normalizeWords([word], lang)[0]?.key ?? '';
  return /\d/.test(key) || SCALE.test(key);
}

/**
 * Split a number phrase into prefix / number / suffix on both sides ("25 percent" ↔ "twenty five percent" →
 * [25]↔[twenty five], [percent]↔[percent]), so each word takes the time of the words that say it. A part missing on
 * one side joins the number part. Null when a side has no number word.
 */
function numberParts(T: number[], Z: number[], textWords: readonly string[], timed: readonly TimedWord[], lang: Lang): Array<[number[], number[]]> | null {
  const split = (idx: number[], text: (k: number) => string): [number[], number[], number[]] | null => {
    const num = idx.map((k) => isNumberWord(text(k), lang));
    const f = num.indexOf(true);
    if (f < 0) return null;
    const l = num.lastIndexOf(true);
    return [idx.slice(0, f), idx.slice(f, l + 1), idx.slice(l + 1)];
  };
  const t = split(T, (k) => textWords[k]);
  const z = split(Z, (k) => timed[k].text);
  if (!t || !z) return null;
  for (const side of [0, 2] as const) {
    if ((t[side].length === 0) === (z[side].length === 0)) continue;
    const has = t[side].length > 0 ? t : z;
    has[1] = side === 0 ? [...has[0], ...has[1]] : [...has[1], ...has[2]];
    has[side] = [];
  }
  return [0, 1, 2].filter((p) => t[p].length > 0).map((p) => [t[p], z[p]]);
}

/**
 * Align the text hearing's words to the timing hearing's words. The text wins: every text word gets a time, speaker,
 * match kind and confidence. Timing-only words are dropped.
 */
export function alignWords(textWords: readonly string[], timedIn: readonly TimedWord[], opts: AlignOptions = {}): AlignedWord[] {
  if (textWords.length === 0) return [];
  const lang = langOf(opts.language);
  const timed = [...timedIn].sort((x, y) => x.start - y.start);
  const normA = normalizeWords(textWords, lang);
  const normB = normalizeWords(timed.map((t) => t.text), lang);
  const unitsA = buildUnits(normA);
  const unitsB = buildUnits(normB);
  const result: Array<Timing | null> = textWords.map(() => null);
  // per text word: the timing words (indices into `timed`) it was matched with, reported as `heard`
  const heardBy: Array<readonly number[] | null> = textWords.map(() => null);
  // silence before each timing unit (and after the last, up to the duration): DP ties go where there is room
  const silence: number[] = [];
  let heardUntil = 0;
  for (let u = 0; u < unitsB.length; u++) {
    const [start, end] = spanOf(timed, wordsOf(unitsB, [u, u]));
    silence.push(start - heardUntil);
    heardUntil = Math.max(heardUntil, end);
  }
  silence.push(opts.duration !== undefined ? opts.duration - heardUntil : 0);
  const ops = extendMerges(alignUnits(unitsA, unitsB, { band: opts.band, silence }), unitsA, unitsB);

  const keyLength = (units: readonly UnitSpan[], r: [number, number]): number => {
    let n = 0;
    for (let u = r[0]; u <= r[1]; u++) n += flatKey(units[u]).length;
    return n;
  };
  const trusted = (op: Op): boolean => {
    if (op.kind === 'ins' || op.kind === 'del') return false;
    const short = Math.max(keyLength(unitsA, op.a!), keyLength(unitsB, op.b!)) <= SHORT_KEY;
    return op.sim >= (short ? ANCHOR_MIN_SIM_SHORT : ANCHOR_MIN_SIM);
  };

  const share = (T: number[], Z: number[], start: number, end: number, match: MatchKind, confidence: number): void => {
    if (T.length === Z.length && T.length > 1) {
      T.forEach((t, k) => {
        const z = timed[Z[k]];
        result[t] = { start: z.start, end: z.end, speaker: z.speaker ?? DEFAULT_SPEAKER, match, confidence };
        heardBy[t] = [Z[k]];
      });
      return;
    }
    splitSpan(start, end, T.map((t) => charWeight(textWords[t]))).forEach(([s, e], k) => {
      result[T[k]] = { start: s, end: e, speaker: speakerAt(timed, Z, (s + e) / 2), match, confidence };
      heardBy[T[k]] = Z;
    });
  };

  const anchor = (op: Op): void => {
    const T = wordsOf(unitsA, op.a);
    const Z = wordsOf(unitsB, op.b);
    const confidence = roundTime(op.sim);
    const [start, end] = spanOf(timed, Z);
    if (T.length === Z.length && T.length > 1) { share(T, Z, start, end, op.sim === 1 ? 'exact' : 'fuzzy', confidence); return; }
    if (T.length === 1) {
      const match: MatchKind = Z.length > 1 ? 'merge' : op.sim === 1 ? 'exact' : 'fuzzy';
      result[T[0]] = { start, end, speaker: timed[Z[0]].speaker ?? DEFAULT_SPEAKER, match, confidence };
      heardBy[T[0]] = Z;
      return;
    }
    const parts = Z.length > 1 ? numberParts(T, Z, textWords, timed, lang) : null;
    for (const [Tp, Zp] of parts ?? [[T, Z]]) {
      const [s, e] = spanOf(timed, Zp);
      share(Tp, Zp, s, e, 'split', confidence);
    }
  };

  // Repair window: a low-similarity stretch between anchors (see repair.ts).
  const repair = (win: readonly Op[], prevEnd: number | null, nextStart: number | null, secPerChar: number): void => {
    const text: WinUnit[] = [];
    const timing: WinUnit[] = [];
    const position: Array<number | null> = [];
    const paired: boolean[] = [];
    for (const op of win) {
      const both = op.a !== null && op.b !== null;
      if (op.a) for (let u = op.a[0]; u <= op.a[1]; u++) {
        text.push({ words: wordsOf(unitsA, [u, u]), key: flatKey(unitsA[u]), start: 0, end: 0 });
        position.push(both ? null : timing.length);
      }
      if (op.b) for (let u = op.b[0]; u <= op.b[1]; u++) {
        const words = wordsOf(unitsB, [u, u]);
        const [start, end] = spanOf(timed, words);
        timing.push({ words, key: flatKey(unitsB[u]), start, end });
        paired.push(both);
      }
    }
    if (text.length === 0 || timing.length === 0) return; // text-only words are interpolated later
    const words = text.flatMap((u) => u.words);
    const attach = attachment(textWords, words[0], words[words.length - 1]);
    for (const run of planWindow(text, timing, { prevEnd, nextStart, duration: opts.duration, secPerChar, position, paired, attach })) {
      const T = run.text.flatMap((u) => u.words);
      const Z = run.timing.flatMap((u) => u.words);
      const confidence = roundTime(run.similarity);
      const spans = splitSpan(run.start, run.end, T.map((t) => charWeight(textWords[t])));
      spans.forEach(([s, e], k) => {
        result[T[k]] = { start: s, end: e, speaker: speakerAt(timed, Z, (s + e) / 2), match: 'fuzzy', confidence };
      });
      hearRun(T, Z, spans);
    }
  };

  /**
   * What each text word of a repair run heard: word for word when the counts match, else each timing word goes to
   * the text word whose span holds its midpoint (or the nearest).
   */
  const hearRun = (T: readonly number[], Z: readonly number[], spans: ReadonlyArray<readonly [number, number]>): void => {
    if (T.length === Z.length) { T.forEach((t, k) => { heardBy[t] = [Z[k]]; }); return; }
    const own: number[][] = T.map(() => []);
    for (const z of Z) {
      const mid = (timed[z].start + timed[z].end) / 2;
      let best = 0;
      let bestDist = Infinity;
      spans.forEach(([s, e], k) => {
        const d = mid < s ? s - mid : mid >= e ? mid - e : 0;
        if (d < bestDist) { bestDist = d; best = k; }
      });
      own[best].push(z);
    }
    T.forEach((t, k) => { heardBy[t] = own[k].length > 0 ? own[k] : null; });
  };

  // Pass 1: trusted pairs become anchors; the stretches between them are collected as repair windows.
  const windows: Array<{ ops: Op[]; prevEnd: number | null; nextStart: number | null }> = [];
  let win: Op[] = [];
  let prevEnd: number | null = null;
  for (const op of ops) {
    if (!trusted(op)) { win.push(op); continue; }
    const [start, end] = spanOf(timed, wordsOf(unitsB, op.b));
    if (win.length > 0) windows.push({ ops: win, prevEnd, nextStart: start });
    win = [];
    anchor(op);
    prevEnd = end;
  }
  if (win.length > 0) windows.push({ ops: win, prevEnd, nextStart: null });

  // Pass 2: repair windows (at the speaking rate measured on the anchors), then interpolation.
  const secPerChar = speakingRate(textWords, result, lang);
  for (const w of windows) repair(w.ops, w.prevEnd, w.nextStart, secPerChar);
  // Words no engine heard (and punctuation-only words) get an unknown time.
  interpolate(textWords, result, { duration: opts.duration, minWordDuration: MIN_WORD_DURATION, secPerChar, language: lang });
  hearGaps(timed, result as Timing[], heardBy);
  const witness = heardBy.map((z) => (z ? heardOf(timed, z) : undefined));
  return finalize(textWords, result as Timing[], { duration: opts.duration, minWordDuration: MIN_WORD_DURATION }).map((w, i) => (witness[i] ? { ...w, heard: witness[i] } : w));
}

/**
 * Interpolated words heard nothing of their own: give them the timing words no text word took between their timed
 * neighbors. A run of interpolated words shares them.
 */
export function hearGaps(timed: readonly TimedWord[], result: readonly Timing[], heardBy: Array<readonly number[] | null>): void {
  const taken = new Set(heardBy.flatMap((z) => z ?? []));
  const free = timed.map((_, z) => z).filter((z) => !taken.has(z));
  if (free.length === 0) return;
  let i = 0;
  while (i < result.length) {
    if (!isUntimed(result[i]) || heardBy[i]) { i++; continue; }
    let j = i;
    while (j + 1 < result.length && isUntimed(result[j + 1]) && !heardBy[j + 1]) j++;
    const lo = i > 0 ? result[i - 1].end : -Infinity;
    const hi = j + 1 < result.length ? result[j + 1].start : Infinity;
    const Z = free.filter((z) => { const mid = (timed[z].start + timed[z].end) / 2; return mid >= lo && mid <= hi; });
    if (Z.length > 0) for (let k = i; k <= j; k++) heardBy[k] = Z;
    i = j + 1;
  }
}

/** The `heard` record for timing words Z (indices into the sorted timing words). */
function heardOf(timed: readonly TimedWord[], Z: readonly number[]): Heard {
  const sorted = [...Z].sort((a, b) => a - b);
  return { text: sorted.map((z) => timed[z].text).join(' '), first: sorted[0], last: sorted[sorted.length - 1] };
}
